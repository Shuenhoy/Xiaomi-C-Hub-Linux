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
  const hid = ifaces.filter((i) => i.bInterfaceClass === 0x03);
  const noEndpoints = hid.filter((i) => (i.endpoints || []).length === 0);
  const pool = noEndpoints.length ? noEndpoints : hid;
  return pool.slice().sort((a, b) => b.bInterfaceNumber - a.bInterfaceNumber)[0] || null;
}

/**
 * 读取接口的 HID report descriptor（标准请求 GET_DESCRIPTOR 0x2200）。
 * 仅用于调试/自检。
 */
function readReportDescriptor(device, interfaceNumber) {
  try {
    const r = device.controlTransferIn(
      {
        requestType: 'standard',
        recipient: 'interface',
        request: 0x06,
        value: 0x2200,
        index: interfaceNumber,
      },
      4096
    );
    if (r && r.status === 'success' && r.data) return Buffer.from(r.data);
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
    log(`claimed interface ${iface.bInterfaceNumber}`);
  } catch (e) {
    // 已被占用时不致命，控制传输通常仍可用
    log('claim interface failed: ' + e.message);
  }

  const desc = readReportDescriptor(device, iface.bInterfaceNumber);
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
   */
  getFeatureReport(reportId, reportLength) {
    if (!this._open) throw new Error('Unable to read from a closed HID device');
    const handle = acquire();
    try {
      const len = reportLength || 22;
      const r = handle.device.controlTransferIn(
        {
          requestType: 'class',
          recipient: 'interface',
          request: 0x01,                       // GET_REPORT
          value: 0x0300 | (reportId & 0xff),   // feature report
          index: handle.iface.bInterfaceNumber,
        },
        len
      );
      if (!r || r.status !== 'success' || !r.data) {
        throw new Error('could not get feature report from device');
      }
      const got = Buffer.from(r.data);
      const out = Buffer.alloc(len);
      got.copy(out, 0, 0, Math.min(got.length, len));
      log(`GET_REPORT id=0x${reportId.toString(16)} len=${len} -> ${hex(out)}`);
      return out;
    } finally {
      release();
    }
  }

  /**
   * 等价 node-hid: sendFeatureReport(data)，data[0] 为 report id。
   * Windows 上是 HidD_SetFeature。
   */
  sendFeatureReport(data) {
    if (!this._open) throw new Error('Unable to write to a closed HID device');
    const handle = acquire();
    try {
      const buf = Buffer.from(Array.from(data));
      const reportId = buf[0];
      const r = handle.device.controlTransferOut(
        {
          requestType: 'class',
          recipient: 'interface',
          request: 0x09,                       // SET_REPORT
          value: 0x0300 | (reportId & 0xff),
          index: handle.iface.bInterfaceNumber,
        },
        buf
      );
      log(`SET_REPORT id=0x${reportId.toString(16)} len=${buf.length} -> ${r && r.status}`);
      if (!r || r.status !== 'success') {
        throw new Error('could not send feature report to device');
      }
      return buf.length;
    } finally {
      release();
    }
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
  XIAOMI_VID,
  XIAOMI_PIDS,
};
