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

/** INPUT report 是 256 字节（蓝牙模式下唯一能读到真实状态帧的通道） */
const INPUT_REPORT_SIZE = 256;

/** 记下哪种读法有效，避免每秒都做无用的探测；设备重新枚举时清空 */
let preferredReadPath = null; // 'feature' | 'request-70'

/**
 * 判断一段数据是不是设备返回的**状态帧**（`A5 5A FC <len> <cmd> ... 16`）。
 *
 * 注意要排除「应答回显帧」：蓝牙模式下设备只回
 * `A5 5A FC 01 <cmd> 03 16`（body 只有 1 字节），那里面没有任何参数。
 * 真正的状态帧 body 至少几十字节，所以用长度下限区分。
 */
function isStateFrame(buf) {
  if (!buf || buf.length < 8) return false;
  if (buf[0] !== 0xa5 || buf[1] !== 0x5a || buf[2] !== 0xfc) return false;
  let end = buf.length - 1;
  while (end > 6 && buf[end] === 0) end -= 1;
  if (buf[end] !== 0x16) return false;
  return end - 6 >= 16;
}

/**
 * 修正状态帧第 3 字节（长度字段）。
 *
 * 设备返回的 `A5 5A FC <len> ... 16` 里，<len> 会少报 4 个字节：
 * 声明的 body 到不了终止符 0x16，末尾还会剩下 `01 8f 01 00 16`（键盘 143）。
 * 渲染层 initSpeakerConfig() 用 `result.slice(6, 6 + result[3])` 解析，
 * 于是会漏掉最后两个参数 142（powerNoticeFlag）与 143（mixLineChannelFlag）。
 *
 * 受影响的实际行为：Home 里「混合输入」通道是否可选由
 * `channelStatus[3] == 0 || mixLineChannelFlag === 0` 决定，
 * 一旦漏读就永远是 0，用户开了混合输入也选不到那个通道。
 *
 * 这里按终止符反推真实 body 长度回填，其余字节不动。
 */
function fixStateFrameLength(frame) {
  if (!frame || frame.length < 8) return frame;
  if (frame[0] !== 0xa5 || frame[1] !== 0x5a || frame[2] !== 0xfc) return frame;
  let end = frame.length - 1;
  while (end > 6 && frame[end] === 0) end -= 1;
  if (frame[end] !== 0x16) return frame;         // 没有终止符，不敢改
  const actual = end - 6;
  if (actual <= 0 || frame[3] === actual) return frame;
  const fixed = Buffer.from(frame);
  log(`状态帧长度低报：声明 ${frame[3]}，实测 ${actual}，已回填`);
  fixed[3] = actual;
  return fixed;
}

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

/** 同一个物理设备在重新枚举后会换地址，用它判断句柄是否还新鲜 */
function identityOf(device) {
  if (!device) return null;
  return `${device.busNumber}:${device.deviceAddress}`;
}

/** 设备掉线 / 重新枚举后旧句柄会失效，必须丢弃重开 */
function invalidate() {
  preferredReadPath = null;
  if (!shared) return;
  try { shared.device.close(); } catch (_) { /* ignore */ }
  shared = null;
}

function acquire() {
  if (shared) {
    // 换通道时音箱会重新枚举（PID 和接口布局都会变），
    // 旧句柄上所有传输都会变成 LIBUSB_ERROR_NO_DEVICE，这里先校验一次
    const current = findDevice();
    if (current && identityOf(current.device) === identityOf(shared.device)) {
      shared.refs += 1;
      return shared;
    }
    log('设备地址已变化（重新枚举），重建句柄');
    invalidate();
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
    const requestType = 0x0300 | ((reportId || 0) & 0xff);

    // 设备会随输入通道重新枚举：
    //   USB 通道 → PID d009，5 个接口，Feature report 能读到真实状态帧
    //   蓝牙通道 → PID d00a，只剩 1 个 HID 接口，Feature report 恒返回默认帧
    //              `00 01 00 03 00 00 80 ...`，只有 INPUT report 能读到真实帧
    // 所以两条读法都要试，谁先拿到合法帧就用谁。
    const readFeature = () => transferIn(
      handle.device, REQUEST_TYPE.classIn, 0x01, requestType,
      ifaceNumber(handle.iface), FEATURE_REPORT_SIZE
    );
    const readInput = () => transferIn(
      handle.device, REQUEST_TYPE.classIn, 0x01, 0x0100,
      ifaceNumber(handle.iface), INPUT_REPORT_SIZE
    );

    /** 自己补发一条状态查询（渲染层用的是 0x90，蓝牙模式下只有 0x70 有应答） */
    const sendStateQuery = async (cmd) => {
      const frame = Buffer.alloc(OUTPUT_REPORT_SIZE);
      Buffer.from([0xa5, 0x5a, 0xfc, 0x03, cmd, 0x03, 0x00, 0x16]).copy(frame);
      try {
        const written = await transferOut(
          handle.device, REQUEST_TYPE.classOut, 0x09, 0x0200,
          ifaceNumber(handle.iface), frame
        );
        log(`补发状态查询 0x${cmd.toString(16)} -> ${written}`);
      } catch (e) {
        log(`补发状态查询 0x${cmd.toString(16)} 失败: ${e.message}`);
      }
    };

    const attemptRead = async () => {
      for (let i = 0; i < 4; i += 1) {
        // 已知 feature 走不通就直接跳过，省一次无用的控制传输
        if (preferredReadPath !== 'request-70') {
          let viaFeature = null;
          try { viaFeature = await readFeature(); } catch (e) { log('FEATURE 读失败: ' + e.message); }
          if (isStateFrame(viaFeature)) {
            preferredReadPath = 'feature';
            const frame = fixStateFrameLength(viaFeature);
            log(`GET_REPORT(feature) -> ${hex(frame)}`);
            return frame;
          }
        }
        // feature 拿不到真实帧时，用 INPUT report 读。
        // 设备刚收到查询命令时第一次 INPUT 常常只是回显（body 长度 1），需要多读几次。
        for (let j = 0; j < 3; j += 1) {
          let viaInput = null;
          try { viaInput = await readInput(); } catch (e) { log('INPUT 读失败: ' + e.message); }
          if (isStateFrame(viaInput)) {
            const frame = fixStateFrameLength(viaInput);
            log(`GET_REPORT(input) -> ${hex(frame)}`);
            return frame;
          }
          await new Promise((r) => setTimeout(r, 60));
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      return null;
    };

    const attempt = async () => {
      const first = await attemptRead();
      if (first) return first;

      // 还没拿到状态帧。渲染层发的是 0x90 查询，但这个固件只对 0x70 回完整状态，
      // 0x90 只回 1 字节回显。补发一次 0x70 再读。
      await sendStateQuery(0x70);
      await new Promise((r) => setTimeout(r, 150));
      const second = await attemptRead();
      if (second) {
        preferredReadPath = 'request-70';
        return second;
      }

      // 都失败就返回 Feature 的原始结果（默认帧），交给上层按空配置处理
      preferredReadPath = null;
      const fallback = await readFeature().catch(() => Buffer.alloc(FEATURE_REPORT_SIZE));
      log(`GET_REPORT 未取到合法状态帧 -> ${hex(fallback)}`);
      return fixStateFrameLength(fallback);
    };

    return withRetry(attempt).finally(() => setTimeout(release, 0));
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

    // 渲染层的状态查询是 `A5 5A FC 03 90 03 00 16`，但当前固件对 0x90
    // 只回 1 字节回显，只有 0x70 会回完整状态帧。一旦确认 0x90 不可用，
    // 就把查询改写成 0x70，省掉「先发 0x90、失败、再补发 0x70」的一轮往返。
    if (
      body.length >= 6 &&
      body[0] === 0xa5 && body[1] === 0x5a && body[2] === 0xfc &&
      body[4] === 0x90 && body[5] === 0x03 &&
      preferredReadPath === 'request-70'
    ) {
      body[4] = 0x70;
      log('状态查询 0x90 改写为 0x70');
    }

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
