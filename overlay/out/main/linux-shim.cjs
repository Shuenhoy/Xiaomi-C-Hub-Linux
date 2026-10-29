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
 * 3. node-hid 回退（默认开启）—— Linux 的 usbhid 不会为 interface 4 建 hidraw。
 *
 * 环境变量
 * --------
 *   XIAOMI_C_HUB_DEBUG=1        补充日志到 /tmp/xiaomi-c-hub-shim.log
 *   XIAOMI_C_HUB_WINE=1         对 .exe 的调用改走 wine
 *   XIAOMI_C_HUB_HID_FALLBACK=0 关闭合成 HID 设备（默认注入）
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

/* ------------------------------------------------------------------ */
/* 0. process.platform 伪装（实验开关）                                  */
/* ------------------------------------------------------------------ */

let platformOverridden = false;

/**
 * 主进程里的设备逻辑大量依赖 `process.platform === 'win32'`。
 * 这个开关把它伪装成 win32，用于验证 Linux 上被跳过的代码路径
 * 是否只是平台判断导致。默认关闭。
 */
function setPlatformSpoof(on) {
  const target = typeof on === 'string' ? on : (on ? 'win32' : 'linux');
  if (target === process.platform) {
    platformOverridden = target;
    return;
  }
  try {
    Object.defineProperty(process, 'platform', {
      value: target,
      configurable: true,
    });
    platformOverridden = target;
    log(`platform -> ${target}`);
  } catch (e) {
    log('伪装 platform 失败: ' + e.message);
  }
}

if (process.env.XIAOMI_C_HUB_SPOOF_PLATFORM === '1') {
  // 注意：不能在启动时立刻伪装 —— usb / node-hid 的原生模块会按
  // process.platform 选 prebuild 目录，伪装成 win32 会去加载 .node
  // 的 Windows 版本（invalid ELF header）。所以先加载原生模块，
  // 再在 IPC 处理器执行期间临时伪装。
  try {
    require('usb');
    require('node-hid');
  } catch (e) {
    log('预加载原生模块失败: ' + e.message);
  }
  if (process.env.XIAOMI_C_HUB_PLATFORM_ALWAYS === '1') {
    setPlatformSpoof(process.env.XIAOMI_C_HUB_PLATFORM_ALWAYS_VALUE || 'win32');
    log('platform 伪装已就绪（永久）');
  } else {
    log('platform 伪装已就绪（仅在 IPC 处理器执行期间生效）');
  }
}

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
        const r = origOpen.apply(this, args);
        const dd = this.deviceDescriptor || {};
        if (dd.idVendor === XIAOMI_VID) {
          const stack = (new Error().stack || '').split('\n').slice(1, 6).join(' | ');
          log(`Device.open ${dd.idVendor.toString(16)}:${dd.idProduct.toString(16)} -> OK  ${stack}`);
        }
        return r;
      } catch (e) {
        const dd = this.deviceDescriptor || {};
        const vid = dd.idVendor ? dd.idVendor.toString(16) : '?';
        const pid = dd.idProduct ? dd.idProduct.toString(16) : '?';
        const isAccess = /ACCESS/i.test(e.message || '');
        log(`Device.open ${vid}:${pid} -> ${e.message}`);
        if (isAccess && dd.idVendor === XIAOMI_VID) {
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
  // 默认开启：Linux 的 usbhid 不会为 interface 4（无中断端点）创建 hidraw，
  // node-hid 永远看不到厂商配置接口，不注入合成设备程序就会一直显示“未连接”。
  // 想对比原生行为可设 XIAOMI_C_HUB_HID_FALLBACK=0。
  if (process.env.XIAOMI_C_HUB_HID_FALLBACK === '0') return;

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
      usage: 0x55aa,
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
/* 2. USB 控制传输追踪（调试用）                                        */
/* ------------------------------------------------------------------ */

function traceArray(arr) {
  return new Proxy(arr, {
    get(t, k, recv) {
      const v = Reflect.get(t, k, recv);
      if (typeof v === 'function' && typeof k === 'string') {
        return function (...a) {
          // 对 filter / find / some 包裹回调，记录每个候选对象和判定结果
          if (['filter', 'find', 'some', 'findIndex'].includes(k) && typeof a[0] === 'function') {
            const cb = a[0];
            a[0] = function (item, ...rest) {
              const r = cb.call(this, item, ...rest);
              if (!(r && typeof r.then === 'function')) {
                let brief;
                try {
                  brief = JSON.stringify({
                    v: item && item.vendorId, p: item && item.productId,
                    i: item && item.interface, up: item && item.usagePage,
                    u: item && item.usage, pth: item && item.path,
                  });
                } catch (_) { brief = '?'; }
                log(`ARR.${k} cb(${brief}) -> ${String(r)}`);
              }
              return r;
            };
          }
          const r = v.apply(t, a);
          let out;
          if (Array.isArray(r)) out = `[${r.map((d) => `${d.vendorId}:${d.productId}`).join(',')}]`;
          else out = typeof r === 'object' && r !== null ? `[${r.constructor ? r.constructor.name : 'obj'}]` : String(r);
          log(`ARR.${k}(...) -> ${Array.isArray(r) ? r.length + ' ' : ''}${String(out).slice(0, 150)}`);
          return Array.isArray(r) ? traceArray(r) : r;
        };
      }
      if (k === 'length') log(`ARR.length = ${v}`);
      return v;
    },
  });
}

function traceDevice(d) {
  const fakePid = process.env.XIAOMI_C_HUB_FAKE_PID
    ? parseInt(process.env.XIAOMI_C_HUB_FAKE_PID, 0)
    : 0;
  return new Proxy(d, {
    get(t, k, recv) {
      if (fakePid && k === 'productId') {
        log(`FAKE productId -> 0x${fakePid.toString(16)}`);
        return fakePid;
      }
      const v = Reflect.get(t, k, recv);
      if (typeof v === 'function') {
        return function (...a) {
          log(`CALL ${String(k)}(${a.map((x) => {
            try { return typeof x === 'object' ? JSON.stringify(x).slice(0, 80) : String(x); } catch (_) { return '?'; }
          }).join(',')})`);
          let out;
          try {
            out = v.apply(t, a);
          } catch (e) {
            log(`CALL ${String(k)} -> THROW ${e.message}`);
            throw e;
          }
          if (out && typeof out.then === 'function') {
            return out.then(
              (res) => {
                log(`CALL ${String(k)} -> ok ${res === undefined ? '' : String(typeof res === 'object' ? JSON.stringify(res).slice(0, 120) : res)}`);
                return res;
              },
              (e) => { log(`CALL ${String(k)} -> REJECT ${e && e.message}`); throw e; }
            );
          }
          log(`CALL ${String(k)} -> ${typeof out === 'object' && out ? '[obj]' : String(out)}`);
          return out;
        };
      }
      let desc;
      try {
        desc = typeof v === 'object' && v !== null
          ? `[${v.constructor ? v.constructor.name : 'obj'}]`
          : String(v);
      } catch (_) { desc = '?'; }
      const st = process.env.XIAOMI_C_HUB_TRACE_STACK === '1'
        ? ' @ ' + (new Error().stack || '').split('\n').slice(2, 5)
          .map((s) => s.trim().replace(/^at\s+/, '')).map((s) => {
            const m = s.match(/index\.jsc:(\d+):(\d+)/);
            return m ? `jsc:${m[2]}` : s.split(' (')[0];
          }).join(' < ')
        : '';
      log(`PROP ${String(k)} = ${String(desc).slice(0, 120)}${st}`);
      return v;
    },
  });
}

function installUsbTrace() {
  if (process.env.XIAOMI_C_HUB_TRACE_USB !== '1') return;

  let usb;
  try {
    usb = require('usb');
  } catch (e) {
    log('usb 模块不可用: ' + e.message);
    return;
  }

  const sample = usb.getDeviceList()[0];
  if (!sample) return;

  let proto = Object.getPrototypeOf(sample);
  let owner = null;
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'controlTransfer');
    if (desc && typeof desc.value === 'function') { owner = proto; break; }
    proto = Object.getPrototypeOf(proto);
  }
  if (!owner) { log('未找到 controlTransfer 定义'); return; }

  const orig = owner.controlTransfer;
  if (orig.__traced) return;

  const traced = function (bmRequestType, bRequest, wValue, wIndex, dataOrLength, callback) {
    const dd = this.deviceDescriptor || {};
    const tag = `${(dd.idVendor || 0).toString(16)}:${(dd.idProduct || 0).toString(16)}`;
    const isIn = !!(bmRequestType & 0x80);
    const len = isIn ? dataOrLength : (Buffer.isBuffer(dataOrLength) ? dataOrLength.length : '?');
    const outHex = !isIn && Buffer.isBuffer(dataOrLength) ? dataOrLength.toString('hex') : '';
    log(`CTRL ${tag} rt=0x${bmRequestType.toString(16)} req=0x${bRequest.toString(16)} ` +
        `val=0x${(wValue >>> 0).toString(16)} idx=${wIndex} len=${len} ${isIn ? 'IN' : 'OUT ' + outHex}`);

    const wrapped = typeof callback === 'function'
      ? function (err, buf) {
          if (err) {
            log(`CTRL ${tag} req=0x${bRequest.toString(16)} -> ERR ${err.message}`);
          } else if (isIn) {
            log(`CTRL ${tag} req=0x${bRequest.toString(16)} -> IN ${Buffer.from(buf).toString('hex')}`);
          } else {
            log(`CTRL ${tag} req=0x${bRequest.toString(16)} -> OK ${buf}`);
          }
          return callback.apply(this, arguments);
        }
      : undefined;

    return orig.call(this, bmRequestType, bRequest, wValue, wIndex, dataOrLength, wrapped);
  };
  traced.__traced = true;

  Object.defineProperty(owner, 'controlTransfer', {
    value: traced,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  log('USB 控制传输追踪已启用');

  // 同时追踪 setConfiguration / claimInterface，这两步在 Linux 上最容易失败
  const traceMethod = (obj, name, label) => {
    let p = obj;
    let holder = null;
    while (p) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (d && typeof d.value === 'function') { holder = p; break; }
      p = Object.getPrototypeOf(p);
    }
    if (!holder) return;
    const fn = holder[name];
    if (fn.__traced) return;
    const w = function (...args) {
      try {
        const r = fn.apply(this, args);
        log(`${label}.${name}(${args.map((a) => JSON.stringify(a)).join(',')}) -> ok` +
            (r && r.then ? '' : ''));
        if (r && typeof r.then === 'function') {
          r.catch((e) => log(`${label}.${name} -> ERR ${e.message}`));
        }
        return r;
      } catch (e) {
        log(`${label}.${name} -> ERR ${e.message}`);
        throw e;
      }
    };
    w.__traced = true;
    // 有些绑定方法（如 __setConfiguration）是 native 的不可重定义属性，
    // 尝试失败就跳过，不要影响启动。
    try {
      Object.defineProperty(holder, name, { value: w, configurable: true, writable: true, enumerable: false });
    } catch (e) {
      log(`${label}.${name} 无法包装（${e.message}），跳过`);
    }
  };

  traceMethod(sample, 'setConfiguration', 'device');
  traceMethod(sample, 'claimInterface', 'device');
  traceMethod(sample, 'detachKernelDriver', 'device');
  traceMethod(sample, 'setAutoDetachKernelDriver', 'device');

  // 程序很可能直接用 `__` 前缀的原始绑定方法
  for (const name of [
    '__setConfiguration', '__claimInterface', '__releaseInterface', '__setInterface',
    '__detachKernelDriver', '__attachKernelDriver', '__setAutoDetachKernelDriver',
    '__isKernelDriverActive', '__open', '__close',
  ]) {
    traceMethod(sample, name, 'device');
  }

  // 接口对象的 claim/release
  try {
    const { Interface } = require('usb/dist/usb/interface');
    if (Interface) {
      traceMethod(Interface.prototype, 'claim', 'iface');
      traceMethod(Interface.prototype, 'release', 'iface');
    }
  } catch (_) { /* ignore */ }
  log('USB 配置/接口调用追踪已启用');

  // 追踪设备枚举：程序自己调 getDeviceList / findByIds 时记录结果
  const traceUsbFn = (name) => {
    const orig = usb[name];
    if (typeof orig !== 'function' || orig.__traced) return;
    const w = function (...args) {
      const r = orig.apply(this, args);
      if (name === 'getDeviceList' && Array.isArray(r)) {
        const sig = r.map((d) => {
          const dd = d.deviceDescriptor || {};
          return `${(dd.idVendor || 0).toString(16)}:${(dd.idProduct || 0).toString(16)}`;
        });
        log(`usb.${name}() -> ${r.length} 个 [${sig.join(', ')}]`);
      } else {
        log(`usb.${name}(${args.join(',')}) -> ${r ? 'found' : 'null'}`);
      }
      return r;
    };
    w.__traced = true;
    try { usb[name] = w; } catch (_) { /* ignore */ }
  };
  traceUsbFn('getDeviceList');
  traceUsbFn('findByIds');

  // node-hid 是另一条可能的分支：程序可能先用 hidraw 找 interface 4
  try {
    const hid = require('node-hid');
    const origDevices = hid.devices;
    if (typeof origDevices === 'function' && !origDevices.__traced) {
      const d = function (...a) {
        const r = origDevices.apply(this, a);
        log(`node-hid.devices() -> ${r.length} 个, 小米: ` +
            JSON.stringify(r.filter((x) => x.vendorId === XIAOMI_VID)));
        if (process.env.XIAOMI_C_HUB_TRACE_PROPS !== '1') return r;
        return traceArray(r.map((x) => (x.vendorId === XIAOMI_VID ? traceDevice(x) : x)));
      };
      d.__traced = true;
      Object.defineProperty(hid, 'devices', { value: d, configurable: true, writable: true });
      log('node-hid.devices 追踪已启用');
    }
    const OrigHID = hid.HID;
    if (typeof OrigHID === 'function' && !OrigHID.__traced) {
      function TracedHID(path, ...rest) {
        log(`new HID(${JSON.stringify(path)})`);
        return new OrigHID(path, ...rest);
      }
      TracedHID.__traced = true;
      TracedHID.prototype = OrigHID.prototype;
      TracedHID.devices = hid.devices;
      Object.defineProperty(hid, 'HID', { value: TracedHID, configurable: true, writable: true });
      log('node-hid.HID 追踪已启用');
    }
  } catch (e) {
    log('安装 node-hid 追踪失败: ' + e.message);
  }

  // 程序走 WebUSB（usb/dist/webusb）路径，追踪其关键方法
  try {
    const { WebUSBDevice } = require('usb/dist/webusb/webusb-device');
    const { WebUSB } = require('usb/dist/webusb');
    const P = WebUSBDevice.prototype;

    const wrap = (name, label) => {
      const orig = P[name];
      if (typeof orig !== 'function' || orig.__traced) return;
      const w = async function (...args) {
        log(`${label}.${name}(${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(',')})`);
        try {
          const r = await orig.apply(this, args);
          log(`${label}.${name} -> ok${r === undefined ? '' : ' ' + (typeof r === 'object' ? JSON.stringify(r).slice(0, 200) : String(r))}`);
          return r;
        } catch (e) {
          log(`${label}.${name} -> ERR ${e.message}`);
          throw e;
        }
      };
      w.__traced = true;
      try {
        Object.defineProperty(P, name, { value: w, configurable: true, writable: true, enumerable: false });
      } catch (e) {
        log(`${label}.${name} 包装失败: ${e.message}`);
      }
    };

    for (const n of ['open', 'close', 'selectConfiguration', 'claimInterface', 'releaseInterface',
                     'reset', 'controlTransferIn', 'controlTransferOut', 'getStringDescriptor']) {
      wrap(n, 'WebUSBDevice');
    }

    // 记录 WebUSB 实例的构造参数（allowedDevices 过滤器是匹配失败的关键）
    const OrigCtor = WebUSB;
    // 不能直接替换 module 导出（bytecode 里已 require 过），改为包装原型方法
    const origGetDevicesAll = WebUSB.prototype.getDevices;
    const origLoadDevices = WebUSB.prototype.loadDevices;
    if (typeof origLoadDevices === 'function' && !origLoadDevices.__traced) {
      const l = async function (preFilters) {
        log(`WebUSB.loadDevices preFilters=${JSON.stringify(preFilters)} ` +
            `allowAll=${this.options && this.options.allowAllDevices} ` +
            `allowed=${JSON.stringify(this.options && this.options.allowedDevices)}`);
        const r = await origLoadDevices.apply(this, arguments);
        log(`WebUSB.loadDevices -> ${r.length}`);
        if (process.env.XIAOMI_C_HUB_TRACE_PROPS !== '1') return r;
        return traceArray(r.map(traceDevice));
      };
      l.__traced = true;
      Object.defineProperty(WebUSB.prototype, 'loadDevices', {
        value: l, configurable: true, writable: true, enumerable: false,
      });
    }

    // WebUSB.getDevices 的返回结果
    const origGet = WebUSB.prototype.getDevices;
    if (typeof origGet === 'function' && !origGet.__traced) {
      const g = async function (...args) {
        const r = await origGet.apply(this, args);
        log(`WebUSB.getDevices -> ${r.length} 个: ` + r.map((d) =>
          `${d.vendorId.toString(16)}:${d.productId.toString(16)}`).join(', '));
        if (process.env.XIAOMI_C_HUB_TRACE_PROPS !== '1') return r;
        return traceArray(r.map(traceDevice));
      };
      g.__traced = true;
      Object.defineProperty(WebUSB.prototype, 'getDevices', { value: g, configurable: true, writable: true, enumerable: false });
    }
    log('WebUSB 追踪已启用');
  } catch (e) {
    log('安装 WebUSB 追踪失败: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 3. 主进程 → 渲染进程事件追踪（调试用）                               */
/* ------------------------------------------------------------------ */

function installIpcTrace() {
  if (process.env.XIAOMI_C_HUB_TRACE_IPC !== '1') return;
  try {
    const electron = require('electron');
    const { ipcMain, app } = electron;

    // 1) 记录渲染进程发来的所有 IPC 通道
    const origOn = ipcMain.on.bind(ipcMain);
    ipcMain.on = function (channel, listener) {
      log(`IPC-ON 注册 ${channel}`);
      return origOn(channel, function (...args) {
        const arg = args[1];
        let repr;
        try { repr = JSON.stringify(arg); } catch (_) { repr = String(arg); }
        log(`IPC-RECV ${channel} ${String(repr).slice(0, 300)}`);

        // 主进程里几乎所有设备逻辑都有 `process.platform === 'win32'` 守卫，
        // 在 Linux 上会直接 return。这里在处理器执行后保持一段时间
        // 伪装成 win32，用来验证这个假设（处理器常常把真正的异步工作
        // 交给一个未被 await 的内部函数，立刻恢复会覆盖不到）。
        const spoof = process.env.XIAOMI_C_HUB_SPOOF_PLATFORM === '1';
        if (spoof) {
          setPlatformSpoof(true);
          clearTimeout(global.__xchSpoofTimer);
          global.__xchSpoofTimer = setTimeout(() => setPlatformSpoof(false), 10000);
        }

        let r;
        try {
          r = listener.apply(this, args);
        } catch (e) {
          log(`IPC-RECV ${channel} -> THROW ${e.message}`);
          throw e;
        }
        if (r && typeof r.then === 'function') {
          r.then(
            (v) => log(`IPC-RECV ${channel} -> resolved ${v === undefined ? '' : String(v).slice(0, 200)}`),
            (e) => log(`IPC-RECV ${channel} -> REJECTED ${e && e.message}`)
          );
        }
        return r;
      });
    };
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = function (channel, listener) {
      log(`IPC-HANDLE 注册 ${channel}`);
      return origHandle(channel, listener);
    };

    // 2) 主进程 → 渲染进程：webContents 实例在启动早期还不存在，
    //    所以轮询直到能拿到实例原型再包装 send。
    let patched = false;
    const tryPatch = () => {
      if (patched) return true;
      try {
        const list = electron.webContents.getAllWebContents();
        if (!list || !list.length) return false;
        const proto = Object.getPrototypeOf(list[0]);
        const desc = Object.getOwnPropertyDescriptor(proto, 'send');
        if (!desc || typeof desc.value !== 'function') return false;
        const orig = desc.value;
        if (orig.__traced) { patched = true; return true; }
        const w = function (channel, ...args) {
          let repr;
          try { repr = JSON.stringify(args); } catch (_) { repr = String(args); }
          log(`SEND ${channel} ${String(repr).slice(0, 400)}`);
          return orig.call(this, channel, ...args);
        };
        w.__traced = true;
        Object.defineProperty(proto, 'send', { value: w, configurable: true, writable: true, enumerable: false });
        patched = true;
        log('IPC 发送追踪已启用');
        return true;
      } catch (e) {
        log('安装 IPC 追踪失败: ' + e.message);
        return true;
      }
    };

    const timer = setInterval(() => {
      if (tryPatch()) clearInterval(timer);
    }, 100);
    if (app) app.once('ready', () => { tryPatch(); });
    setTimeout(() => clearInterval(timer), 30000);
  } catch (e) {
    log('安装 IPC 追踪失败: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 4. wine 桥接（可选）                                                 */
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
  installUsbTrace();
  installIpcTrace();
  installHidFallback();
  installWineBridge();
}
