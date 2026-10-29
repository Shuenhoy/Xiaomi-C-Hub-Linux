'use strict';
/**
 * Xiaomi C-HUB —— Linux 兼容层
 *
 * 由 out/main/index.js 在加载原始字节码（index.jsc）之前 require。
 * 不修改程序本体，只在运行期做几件适配工作。
 *
 * 已验证的事实
 * ------------
 * 这个版本（B03 系列）在 Electron 主进程里是用 `usb`（libusb）直接操作
 * 音箱的 interface 4，而不是走 hidapi / hidraw。证据：
 *   - out/main/index.jsc 里存在 selectConfiguration / claimInterface /
 *     "interface 4 claimed" 这些字符串；
 *   - package.json 依赖里有 `usb`；
 *   - Linux 上 usbhid 根本无法为 interface 4 建立 hidraw 节点
 *     （usbhid 3-2:1.4: couldn't find an input interrupt endpoint）。
 *
 * 所以移植的实质障碍只有一个：/dev/bus/usb/BBB/DDD 的权限。
 * 安装 udev/60-xiaomi-c-hub.rules 后即可正常工作。
 *
 * 本文件做的事
 * ------------
 * 1. 把 LIBUSB_ERROR_ACCESS 转换成一条能看懂的提示，写进程序日志。
 * 2. 可选：把对 .exe 的 spawn 转给 wine（固件升级用）。
 * 3. 可选：node-hid 回退（B02 系列或将来需要 hidraw 时）。
 *
 * 环境变量
 * --------
 *   XIAOMI_C_HUB_DEBUG=1        补充日志到 /tmp/xiaomi-c-hub-shim.log
 *   XIAOMI_C_HUB_WINE=1         对 .exe 的调用改走 wine
 *   XIAOMI_C_HUB_HID_FALLBACK=1 当 node-hid 看不到厂商接口时，注入合成设备
 */

const Module = require('module');
const fs = require('fs');

const XIAOMI_VID = 0x2717;
const XIAOMI_PIDS = [0xd003, 0xd004, 0xd00b, 0xd00c, 0xd007, 0xd008, 0xd009, 0xd00a];

const DEBUG = !!process.env.XIAOMI_C_HUB_DEBUG;
const SHIM_LOG = '/tmp/xiaomi-c-hub-shim.log';

function log(msg) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(SHIM_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 1. libusb 权限错误提示                                               */
/* ------------------------------------------------------------------ */

const ACCESS_HINT =
  '无法访问 Xiaomi 音箱的 USB 接口（LIBUSB_ERROR_ACCESS）。\n' +
  '这几乎总是因为 udev 权限规则没有安装。请执行：\n' +
  '    sudo cp udev/60-xiaomi-c-hub.rules /etc/udev/rules.d/\n' +
  '    sudo udevadm control --reload-rules && sudo udevadm trigger\n' +
  '然后拔掉音箱重新插上。';

function installUsbDiagnostics() {
  let usb;
  try {
    usb = require('usb');
  } catch (e) {
    log('usb 模块不可用: ' + e.message);
    return;
  }

  // 记录所有 open() 失败，便于定位
  try {
    const sample = usb.getDeviceList()[0];
    if (!sample) return;

    // `open()` 定义在 usb.Device.prototype 上，而实例的原型是
    // ExtendedDevice.prototype，所以必须沿原型链找到真正定义处。
    let proto = Object.getPrototypeOf(sample);
    let owner = null;
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'open');
      if (desc && typeof desc.value === 'function') { owner = proto; break; }
      proto = Object.getPrototypeOf(proto);
    }
    if (!owner) { log('未找到 usb Device.open 定义'); return; }

    const origOpen = owner.open;
    if (origOpen.__wrapped) return;
    const wrapped = function (...args) {
      try {
        return origOpen.apply(this, args);
      } catch (e) {
        const dd = this.deviceDescriptor || {};
        const vid = dd.idVendor ? dd.idVendor.toString(16) : '?';
        const pid = dd.idProduct ? dd.idProduct.toString(16) : '?';
        const isAccess = /ACCESS/i.test(e.message || '');
        log(`Device.open ${vid}:${pid} -> ${e.message}`);
        if (isAccess) {
          const err = new Error(ACCESS_HINT);
          err.cause = e;
          throw err;
        }
        throw e;
      }
    };
    wrapped.__wrapped = true;
    Object.defineProperty(owner, 'open', {
      value: wrapped,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    log('usb open() 诊断已安装');
  } catch (e) {
    log('安装 usb 诊断失败: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 2. node-hid 回退（默认关闭）                                         */
/* ------------------------------------------------------------------ */

function installHidFallback() {
  if (process.env.XIAOMI_C_HUB_HID_FALLBACK !== '1') return;

  let real;
  try {
    real = require('node-hid');
  } catch (e) {
    log('node-hid 不可用: ' + e.message);
    return;
  }

  const { XiaomiHidDevice, findDevice } = require('./xiaomi-hid.cjs');

  const realDevices = real.devices.bind(real);

  // 只有 interface 4 才代表厂商配置接口；interface 3（音量旋钮）
  // 在 Linux 上本来就有 hidraw，不能算“已可见”。
  const alreadyVisible = (list) =>
    list.some(
      (d) => d.vendorId === XIAOMI_VID && XIAOMI_PIDS.includes(d.productId) && d.interface === 4
    );

  const syntheticDescriptor = () => {
    const found = findDevice();
    if (!found) return null;
    const dd = found.device.deviceDescriptor;
    return {
      vendorId: dd.idVendor,
      productId: dd.idProduct,
      path: 'xiaomi-hid:vendor-interface',
      serialNumber: '',
      manufacturer: 'Xiaomi',
      product: 'Xiaomi C-HUB',
      release: dd.bcdDevice,
      interface: 4,
      usagePage: 0xff00,
      usage: 0x0001,
    };
  };

  const devices = () => {
    const list = realDevices();
    if (alreadyVisible(list)) return list;
    const extra = syntheticDescriptor();
    if (!extra) return list;
    log('注入合成 HID 设备 ' + extra.vendorId.toString(16) + ':' + extra.productId.toString(16));
    return [...list, extra];
  };
  const devicesAsync = async () => devices();

  const RealHID = real.HID;
  function HID(devicePath, ...rest) {
    if (typeof devicePath === 'string' && devicePath.startsWith('xiaomi-hid:')) {
      return new XiaomiHidDevice();
    }
    return new RealHID(devicePath, ...rest);
  }
  HID.prototype = RealHID.prototype;
  HID.devices = devices;
  HID.devicesAsync = devicesAsync;

  try {
    real.HID = HID;
    real.devices = devices;
    real.devicesAsync = devicesAsync;
    log('node-hid 回退已启用');
  } catch (e) {
    log('改写 node-hid 导出失败: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 3. wine 桥接（可选）                                                 */
/* ------------------------------------------------------------------ */

function installWineBridge() {
  if (process.env.XIAOMI_C_HUB_WINE !== '1') return;
  const cp = require('child_process');

  const origSpawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (typeof command === 'string' && /\.exe$/i.test(command)) {
      log('spawn -> wine: ' + command);
      return origSpawn.call(this, 'wine', [command, ...(args || [])], options);
    }
    return origSpawn.apply(this, arguments);
  };

  const origExecFile = cp.execFile;
  cp.execFile = function (file, args, options, callback) {
    if (typeof file === 'string' && /\.exe$/i.test(file)) {
      log('execFile -> wine: ' + file);
      return origExecFile.call(this, 'wine', [file, ...(args || [])], options, callback);
    }
    return origExecFile.apply(this, arguments);
  };

  // 渲染层通过 sendSync('getPlatform') 判断平台，非 win32 时会把固件升级
  // 入口隐藏并弹出“该平台不支持升级”的对话框。既然我们用 wine 跑烧写工具，
  // 就让它看到 win32，保持与 Windows 版一致的行为。
  try {
    const { ipcMain } = require('electron');
    const origOn = ipcMain.on.bind(ipcMain);
    ipcMain.on = function (channel, listener) {
      if (channel === 'getPlatform') {
        return origOn(channel, (event, ...args) => {
          event.returnValue = 'win32';
          return undefined;
        });
      }
      return origOn(channel, listener);
    };
    log('getPlatform 已伪装为 win32');
  } catch (e) {
    log('伪装 getPlatform 失败: ' + e.message);
  }

  log('wine 桥接已启用');
}

/* ------------------------------------------------------------------ */

if (process.platform === 'linux') {
  log('Linux 兼容层启动');
  installUsbDiagnostics();
  installHidFallback();
  installWineBridge();
}
