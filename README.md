# Xiaomi C-HUB（Linux 移植）

把 Windows MSIX 版 *Xiaomi C-HUB*（2.4.3.0，x64）
搬到 Linux 的工程。

程序本体是 **Electron 36.8.1** 应用，渲染层是纯 Web 技术，`app.asar` 里
**没有任何需要重编译的原生代码**（`usb` / `node-hid` 都带 linux-x64 prebuild）。
所以移植不是"重写"，而是让 Linux 版 Electron 能跑起来 + 解决 USB 访问权限。

## 结论先说

| 项目 | 状态 |
|------|------|
| 窗口 / 界面 / 中英文 i18n / 图标 / 字体 | ✅ 完全正常 |
| 主进程逻辑、IPC、pinia store | ✅ 完全正常 |
| 连接音箱、读取全部配置 | ✅ 正常（音量 / 灯效 / EQ / 睡眠 / 固件版本都能读） |
| 音量、灯效、亮度、均衡器写入 | ✅ 已在真机验证，设备回读一致 |
| 固件升级 | ⚠️ 依赖 Windows PE 烧写工具，走 wine，未完整验证 |

**唯一的硬性前提：安装 `udev/60-xiaomi-c-hub.rules`。**
没装的话程序能启动、界面正常，但一直显示"未连接"。

## 快速开始

```bash
./scripts/unpack.sh     # 解包 MSIX → work/
./scripts/build.sh      # 组装 → dist/electron/
./scripts/install.sh    # 装 udev 规则 + 桌面入口（需要 sudo）
./dist/electron/xiaomi-c-hub
```

如果出问题先跑 `./scripts/doctor.sh`，它会直接告诉你卡在哪一步。

## 两个关键技术点

### 1. V8 字节码必须配 Windows 版快照

`out/main/index.jsc` 是 **V8 字节码**，不是 JS。`out/main/bytecode-loader.cjs`
用 `new vm.Script(dummyCode, { cachedData })` 加载它。

字节码里内嵌了生成它的 V8 快照的 **external references 索引**，运行时按索引
从快照里取函数指针。Linux 和 Windows 的 Electron 打包时快照不同（内置函数
数量/顺序不同），所以：

* 用 Linux 版 Electron 自带的 `snapshot_blob.bin` → `cachedDataRejected`
* 用 Windows 版原来的 `snapshot_blob.bin` / `v8_context_snapshot.bin` → 正常

`scripts/build.sh` 会自动从 MSIX 里把这两个文件复制过来：

```
snapshot_blob.bin         335,998 B   md5 67110f96279d74cfe0c5ad4b4915d101
v8_context_snapshot.bin   711,733 B   md5 7a10a1a95219111303de82baff73f491
```

`bytecode-loader.cjs` 只修补了 flag hash 头（offset 12）和 source hash 头
（offset 8，用 U+200B 填充伪造源码长度），外部引用表没法伪造 —— 所以换快照
是唯一解。

### 2. 音箱的配置通道在 Linux 上没有 hidraw 节点

音箱同时提供几个 USB 接口：

| 接口 | 类 | 端点 | Linux 状态 |
|------|----|------|-----------|
| 0 / 1 / 2 | Audio | 0 | `snd-usb-audio` 接管（出声靠这个） |
| 3 | HID | 1 个中断 IN | `usbhid` 接管 → `/dev/hidraw*`（音量旋钮，usagePage 12） |
| 4 | HID | **0 个** | `usbhid` 探测失败，**没有 hidraw 节点** |

内核实录：

```
usbhid 3-2:1.4: couldn't find an input interrupt endpoint
```

接口 4 才是配置通道（音量 / 灯效 / EQ / 固件版本）。因为 `usbhid` 无法为
它建立 hidraw，**hidapi / node-hid 在 Linux 上永远看不到它**。对 iface 3 的
hidraw 发 `GET_REPORT`（HIDIOCGFEATURE）会直接超时。

好消息是程序本来就没走 hidapi —— 这个版本（B03 系列）在主进程里用 `usb`
（libusb）**直接**操作接口 4，`out/main/index.jsc` 里能 grep 到：

```
selectConfiguration / claimInterface / "interface 4 claimed" / "interface 0 claimed"
```

实际做的控制传输是：

```
GET_REPORT   bmRequestType=0xA1  bRequest=0x01  wValue=0x0300  wIndex=4  wLength=128
SET_REPORT   bmRequestType=0x21  bRequest=0x09  wValue=0x0200  wIndex=4  len=128
```

这条路只需要 `/dev/bus/usb/BBB/DDD` 的读写权限，**不需要 hidraw**。

不过 `node-hid.devices()` 那一步程序仍然会走：它要找
`usagePage == 0xFF00 && usage == 0x55AA` 的设备确认"厂商接口在线"，
找不到就静默放弃（连界面都不切换）。Linux 上这个设备永远不存在，
所以需要 `xiaomi-hid.cjs` **合成一个挂在这个 filter 上的假设备**，
真正的读写全部由它用 libusb 完成。这部分默认开启。

### 2.1 读写通道的两个坑（都是实测出来的）

**读必须精确 128 字节。** 报告描述符为：

```
06 00 ff 0a aa 55 a1 01 15 00 26 ff 00 75 08 96 00 01 09 01 81 02
96 00 01 09 01 91 02 95 80 09 01 b1 02 c0
```

即 Input 256B、Output 256B、**Feature 128B**，无 report ID。用 129 或
22 字节去 GET_REPORT 只会拿到默认帧 `00 01 00 03 04 00 80 ...`；
**只有 128 字节**才返回真正的应答 `A5 5A FC 62 90 03 30 01 01 31 ... 16`，
其中 `[3] == 0x62` 正是渲染层 `initSpeakerConfig()` 需要的 `dataLength`
（之前 UI 参数全空就是这个原因）。

**写必须走 Output report（`wValue=0x0200`），不是 Feature report。**
同一个帧用 `0x0300` 写，设备直接丢弃并回空帧；用 `0x0200` 就立刻生效。
这是整个移植里最不直观的一处 —— 程序调用的 API 叫
`sendFeatureReport`，Windows 上走 `HidD_SetFeature` 能用，换成 libusb
就必须改成 Output report 才能对得上设备固件的行为。

B03 系列的写入帧是 8 字节，**没有 size 字段**：

```
[0xA5, 0x5A, 0xFC, 0x03, <paramId>, 0x02, <value>, 0x16]
```

实测有效的几组（设备回读完全一致）：

| 功能 | paramId | 帧示例 |
|------|---------|--------|
| 音量（0–16，×6 = 百分比） | 0x74 (116) | `a5 5a fc 03 74 02 05 16` → 30% |
| 灯效模式 | 0x30 (48) | `a5 5a fc 03 30 02 02 16` |
| 亮度 | 0x31 (49) | `a5 5a fc 03 31 02 04 16` |
| 均衡器 10 段 | 0x8C (140) | `a5 5a fc 0c 8c 02 06 06 ... 16`（17 字节） |


### 3. 为什么必须装 udev 规则

```
$ stat -c '%A %U:%G' /dev/bus/usb/003/006
crw-rw-r-- root:root
```

普通用户只有读权限，`libusb_open()` 直接返回 `LIBUSB_ERROR_ACCESS`。
程序启动时会遍历**全部** USB 设备逐个 `open()`，所以你会看到一连串
`LIBUSB_ERROR_ACCESS`，然后 UI 停在 disconnect。

装规则即可（`TAG+="uaccess"` 由 systemd-logind 把 ACL 授给当前会话用户，
不依赖某个特定的组）：

```bash
sudo cp udev/60-xiaomi-c-hub.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
# 拔掉音箱重新插上
```

## 目录结构

```
.
├── overlay/out/main/          # 覆盖到 resources/app/out/main 的适配文件
│   ├── linux-shim.cjs         # 诊断 + 可选 hidraw 回退 + 可选 wine 桥接
│   └── xiaomi-hid.cjs         # 纯 libusb 的 HID 后端（回退用）
├── udev/60-xiaomi-c-hub.rules # USB 权限规则（必须安装）
├── scripts/
│   ├── unpack.sh              # 解包 MSIX + app.asar
│   ├── build.sh               # 组装 dist/electron
│   ├── install.sh             # 装 udev 规则 + .desktop
│   └── doctor.sh              # 诊断脚本
├── work/                      # unpack.sh 产物（解包后的 MSIX）
└── dist/electron/             # build.sh 产物（可直接运行）
```

`linux-shim.cjs` 默认做两件事：**诊断**（记录 `Device.open()` 失败原因、
把 `LIBUSB_ERROR_ACCESS` 换成能看懂的提示）和 **node-hid 回退**
（`xiaomi-hid.cjs` 让程序在 Linux 上也能完成设备识别与读写）。
另有两个可选开关：

| 环境变量 | 作用 |
|---------|------|
| `XIAOMI_C_HUB_DEBUG=1` | 写日志到 `/tmp/xiaomi-c-hub-shim.log` |
| `XIAOMI_C_HUB_WINE=1` | 对 `.exe` 的 spawn 改走 wine，并把 `getPlatform` 伪装成 win32，让固件升级入口显示 |
| `XIAOMI_C_HUB_HID_FALLBACK=0` | 关闭合成 HID 设备（用于对比原生行为，正常使用不要关） |

## 调试

```bash
XIAOMI_C_HUB_DEBUG=1 ./dist/electron/xiaomi-c-hub \
  --remote-debugging-port=9222 --inspect=9229

tail -f /tmp/xiaomi-c-hub-shim.log                  # 适配层日志
tail -f ~/.config/"Xiaomi C-HUB"/logs/main.log      # 程序自身日志
```

窗口状态存在 `~/.config/Xiaomi C-HUB/window-state.json`。

## 已知噪声（无害）

* `The vm module of Node.js is unsupported in Electron's renderer process`
  —— 渲染层打包时没排除 `vm`。
* `ERROR:ui/gfx/x/connection.cc:738] Cannot send request of length 18662432`
  —— X 服务器（尤其嵌套 Xephyr）拒绝超大请求，不影响功能。
* `ERROR:components/viz/service/main/viz_main_impl.cc:183] Exiting GPU process`
  —— GPU 进程初始化失败后回退到软件渲染。
* 启动时的 `.lnk` / `cscript` / 快捷方式逻辑会打印
  `Non-Windows platform, exiting`，属于预期的平台判断。
