'use strict';
/**
 * Xiaomi C-HUB —— Linux USB-HID 后端
 *
 * 背景
 * ----
 * 音箱（VID 0x2717）的厂商配置接口是 interface 4（HID class，0 个端点）。
 * Windows 上程序通过 node-hid 的 HidD_GetFeature / HidD_SetFeature 访问它。
 *
 * Linux 下 usbhid 驱动在探测这个接口时会失败：
 *     usbhid 3-2:1.4: couldn't find an input interrupt endpoint
 * 于是不会生成 /dev/hidraw* 节点，hidapi/node-hid 完全看不到它。
 * 设备上唯一的 hidraw 是 interface 3（音量旋钮 / 消费类控制），
 * 对它发 GET_REPORT 会超时（已实测）。
 *
 * 因此这里绕过 hidraw，直接用 libusb 对 interface 4 做
 * GET_REPORT / SET_REPORT 控制传输，语义与原 node-hid 调用一致。
 *
 * 权限
 * ----
 * /dev/bus/usb/BBB/DDD 默认只有 root 可写，必须安装 udev 规则：
 *     udev/60-xiaomi-c-hub.rules
 */

const fs = require('fs');
const { EventEmitter } = require('events');
const usb = require('usb');

const XIAOMI_VID = 0x2717;

// B03 系列全部型号
// 0xd003 0xd004 0xd00b 0xd00c —— 中文版
// 0xd007 0xd008             —— 英文版
// 0xd009 0xd00a             —— 套装版（Pro Set）
const XIAOMI_PIDS = [0xd003, 0xd004, 0xd00b, 0xd00c, 0xd007, 0xd008, 0xd009, 0xd00a];

const DEBUG = !!process.env.XIAOMI_C_HUB_DEBUG;
const DEBUG_LOG = '/tmp/xiaomi-c-hub-hid.log';

function log(msg) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}


/** usb@2.x 的 Interface 用 interfaceNumber；旧代码里写作 bInterfaceNumber */
function ifaceNumber(iface) {
  if (!iface) return undefined;
  if (typeof iface.interfaceNumber === 'number') return iface.interfaceNumber;
  if (typeof iface.bInterfaceNumber === 'number') return iface.bInterfaceNumber;
  if (iface.descriptor && typeof iface.descriptor.bInterfaceNumber === 'number') {
    return iface.descriptor.bInterfaceNumber;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 控制传输（兼容 usb 2.x 的 controlTransfer 回调式 API）               */
/* ------------------------------------------------------------------ */

const LIBUSB_ENDPOINT_IN = 0x80;
const LIBUSB_TYPE_CLASS = 0x20;
const LIBUSB_TYPE_STANDARD = 0x00;
const LIBUSB_RECIPIENT_INTERFACE = 0x01;

const REQUEST_TYPE = {
  classIn: LIBUSB_ENDPOINT_IN | LIBUSB_TYPE_CLASS | LIBUSB_RECIPIENT_INTERFACE,
  classOut: LIBUSB_TYPE_CLASS | LIBUSB_RECIPIENT_INTERFACE,
  standardIn: LIBUSB_ENDPOINT_IN | LIBUSB_TYPE_STANDARD | LIBUSB_RECIPIENT_INTERFACE,
};

/**
 * interface 4 的 report descriptor（实测）：
 *   06 00 ff 0a aa 55 a1 01 15 00 26 ff 00 75 08 96 00 01 09 01 81 02
 *   96 00 01 09 01 91 02 95 80 09 01 b1 02 c0
 *   → usagePage 0xFF00, usage 0x55AA
 *   → Input  256 B,  Output 256 B,  Feature 128 B（都没有 report ID）
 * Feature report 必须按 128 字节精确读写，否则设备只回默认状态帧。
 */
const FEATURE_REPORT_SIZE = 128;

/** Output report 也是 256 字节（同描述符），写入时补齐到这长度即可 */
const OUTPUT_REPORT_SIZE = 128;

/** 音箱对连续 SET_REPORT 会间歇性 STALL，重试一次即可恢复 */
function withRetry(fn, attempts = 4) {
  let lastError;
  const attempt = (n) => fn().catch((err) => {
    lastError = err;
    const stall = /STALL/i.test(err && err.message ? err.message : '');
    if (n <= 1 || !stall) throw err;
    log(`控制传输 STALL，重试 (${attempts - n + 1}/${attempts})`);
    return new Promise((r) => setTimeout(r, 30)).then(() => attempt(n - 1));
  });
  return attempt(attempts).catch((err) => { throw err || lastError; });
}

/** IN 控制传输，返回 Buffer（失败抛错） */
function transferIn(device, bmRequestType, bRequest, wValue, wIndex, length) {
  return new Promise((resolve, reject) => {
    device.controlTransfer(
      bmRequestType, bRequest, wValue, wIndex, length,
      (err, data) => {
        if (err) return reject(err);
        resolve(Buffer.from(data));
      }
    );
  });
}

/** OUT 控制传输，返回写入字节数（失败抛错） */
function transferOut(device, bmRequestType, bRequest, wValue, wIndex, data) {
  return new Promise((resolve, reject) => {
    device.controlTransfer(
      bmRequestType, bRequest, wValue, wIndex, Buffer.from(data),
      (err, written) => {
        if (err) return reject(err);
        resolve(written);
      }
    );
  });
}

const hex = (v) => Buffer.from(v).toString('hex');

/* ------------------------------------------------------------------ */
/* 设备发现                                                             */
/* ------------------------------------------------------------------ */

/** 找到 Xiaomi 音箱，返回 { device, pid } 或 null */
function findDevice() {
  let list;
  try {
    list = usb.getDeviceList();
  } catch (e) {
    log('getDeviceList failed: ' + e.message);
    return null;
  }
  for (const d of list) {
    const { idVendor, idProduct } = d.deviceDescriptor;
    if (idVendor === XIAOMI_VID && XIAOMI_PIDS.includes(idProduct)) {
      return { device: d, pid: idProduct };
    }
  }
  return null;
}

/**
 * 找到“厂商配置接口”：HID class 且没有端点的那个。
 * 实测为 interfaceNumber 4。若存在多个，取接口号最大的。
 */
function findVendorInterface(device) {
  const ifaces = device.interfaces || [];
  // usb@2.x 把描述符放在 iface.descriptor 里（iface.bInterfaceClass 是 undefined）
  const descOf = (i) => i.descriptor || {};
  const hid = ifaces.filter((i) => descOf(i).bInterfaceClass === 0x03);
  const noEndpoints = hid.filter((i) => (i.endpoints || []).length === 0);
  const pool = noEndpoints.length ? noEndpoints : hid;
  const sorted = pool.slice().sort(
    (a, b) => (descOf(b).bInterfaceNumber ?? b.interfaceNumber) -
              (descOf(a).bInterfaceNumber ?? a.interfaceNumber)
  );
  return sorted[0] || null;
}

/**
 * 读取接口的 HID report descriptor（标准请求 GET_DESCRIPTOR 0x2200）。
 * 仅用于调试/自检。
 */
function readReportDescriptor(device, interfaceNumber) {
  try {
    let result = null;
    let failed = null;
    device.controlTransfer(
      REQUEST_TYPE.standardIn, 0x06, 0x2200, interfaceNumber, 4096,
      (err, data) => {
        if (err) failed = err;
        else result = Buffer.from(data);
      }
    );
    if (failed) throw failed;
    if (result) return result;
  } catch (e) {
    log('readReportDescriptor failed: ' + e.message);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 共享句柄（程序频繁开关设备，重复 claim 会失败）                        */
/* ------------------------------------------------------------------ */

let shared = null; // { device, iface, refs }

function acquire() {
  if (shared) {
    shared.refs += 1;
    return shared;
  }

  const found = findDevice();
  if (!found) throw new Error('Xiaomi C-HUB: device not found');

  const device = found.device;
  try {
    device.open();
  } catch (e) {
    const isAccess = (e.errno === usb.LIBUSB_ERROR_ACCESS) || /ACCESS/i.test(e.message || '');
    if (isAccess) {
      throw new Error(
        'Xiaomi C-HUB: 无权访问 USB 设备（LIBUSB_ERROR_ACCESS）。\n' +
        '请安装 udev 规则后重新插拔设备：\n' +
        '  sudo cp udev/60-xiaomi-c-hub.rules /etc/udev/rules.d/\n' +
        '  sudo udevadm control --reload-rules && sudo udevadm trigger'
      );
    }
    throw e;
  }

  const iface = findVendorInterface(device);
  if (!iface) {
    device.close();
    throw new Error('Xiaomi C-HUB: 未找到厂商 HID 接口（interface 4）');
  }

  try {
    iface.claim();
    log(`claimed interface ${ifaceNumber(iface)}`);
  } catch (e) {
    // 已被占用时不致命，控制传输通常仍可用
    log('claim interface failed: ' + e.message);
  }

  const desc = readReportDescriptor(device, ifaceNumber(iface));
  if (desc) log(`report descriptor (${desc.length}): ${hex(desc)}`);

  shared = { device, iface, refs: 1 };
  return shared;
}

function release() {
  if (!shared) return;
  shared.refs -= 1;
  if (shared.refs > 0) return;
  try { shared.iface.release(true, () => {}); } catch (_) { /* ignore */ }
  try { shared.device.close(); } catch (_) { /* ignore */ }
  shared = null;
}

/* ------------------------------------------------------------------ */
/* 设备对象（模仿 node-hid 的 HID API）                                 */
/* ------------------------------------------------------------------ */

class XiaomiHidDevice extends EventEmitter {
  constructor() {
    super();
    this._open = true;
    this.path = 'xiaomi-hid:vendor-interface';
    acquire();
    log('XiaomiHidDevice opened');
  }

  /**
   * 等价 node-hid: getFeatureReport(reportId, reportLength)
   * Windows 上是 HidD_GetFeature。
   *
   * 关键：该接口的 Feature report 固定 128 字节（见上面的描述符），
   * 控制传输的 wLength 必须精确等于 128，否则设备只会回默认状态帧
   * （`00 01 00 03 04 00 80 ...`），而不是命令应答帧
   * （`A5 5A FC <len> <cmd> 03 <payload>`）。
   * 超出部分用 0 补齐 —— Windows 上 HidD_GetFeature 传 129 时也是一样的效果。
   */
  getFeatureReport(reportId, reportLength) {
    if (!this._open) throw new Error('Unable to read from a closed HID device');
    const handle = acquire();
    return withRetry(() =>
      transferIn(
        handle.device,
        REQUEST_TYPE.classIn,
        0x01,                                // GET_REPORT
        0x0300 | ((reportId || 0) & 0xff),   // feature report
        ifaceNumber(handle.iface),
        FEATURE_REPORT_SIZE
      ).then((got) => {
        // 渲染层按 result[0..] 直接解析应答帧，不能在前面加 report id
        log(`GET_REPORT id=0x${(reportId || 0).toString(16)} -> ${hex(got)}`);
        return got;
      })
    ).finally(() => setTimeout(release, 0));
  }

  /**
   * 等价 node-hid: sendFeatureReport(data)，data[0] 为 report id。
   *
   * 注意：名字虽然叫 feature，但**写入必须走 OUTPUT report**
   * （wValue = 0x0200），走 FEATURE report 只会被设备丢弃并回
   * `00 01 00 03 04 00 80` 空应答。实测：
   *   SET_REPORT val=0x0200 + `a5 5a fc 03 74 02 04 16` → 音量真的改了
   *   SET_REPORT val=0x0300 + 同一帧                     → 被忽略
   * 这个设备没有 report ID，所以首字节（恒为 0）要去掉。
   */
  sendFeatureReport(data) {
    if (!this._open) throw new Error('Unable to write to a closed HID device');
    const handle = acquire();
    const raw = Buffer.from(Array.from(data));
    const body = raw.length && raw[0] === 0 ? raw.subarray(1) : raw;
    const buf = Buffer.alloc(Math.max(OUTPUT_REPORT_SIZE, body.length));
    body.copy(buf, 0, 0, body.length);
    return withRetry(() =>
      transferOut(
        handle.device,
        REQUEST_TYPE.classOut,
        0x09,                                // SET_REPORT
        0x0200,                              // output report, report id 0
        ifaceNumber(handle.iface),
        buf
      ).then((written) => {
        log(`SET_REPORT(out) body=${body.length} -> ${written} (${hex(buf.subarray(0, 12))}...)`);
        return written;
      })
    ).finally(() => setTimeout(release, 0));
  }

  /** 某些代码路径把它当输出设备用 */
  write(data) {
    return this.sendFeatureReport(data);
  }

  read() {
    return Buffer.alloc(0);
  }

  pause() {}
  resume() {}

  close() {
    if (!this._open) return;
    this._open = false;
    release();
    log('XiaomiHidDevice closed');
  }
}

module.exports = {
  XiaomiHidDevice,
  findDevice,
  findVendorInterface,
  readReportDescriptor,
  ifaceNumber,
  XIAOMI_VID,
  XIAOMI_PIDS,
};
