# Xiaomi C-HUB（Linux 移植）

把 Windows MSIX 版 *Xiaomi C-HUB*（2.4.3.0，x64）
搬到 Linux 的工程。

程序本体是 **Electron 36.8.1** 应用，渲染层是纯 Web 技术，`app.asar` 里
**没有任何需要重编译的原生代码**（`usb` / `node-hid` 都带 linux-x64 prebuild）。
所以移植不是"重写"，而是让 Linux 版 Electron 能跑起来 + 解决 USB 访问权限。

> ⚠️ **本项目不是小米的官方产品，与其没有任何隶属或授权关系。**
> 代码与文档主要由生成式 AI（`deepseek-v4.1-flash-1017`）协助产出，
> 详见文末[免责声明](#免责声明)。

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

## 关键技术点

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

**状态帧的长度字节会少报 4 个字节。** 设备回的状态帧形如
`A5 5A FC <len> 90 03 <TLV...> 16`，`<len>` 声明 98，但真正的
终止符在 body 的第 102 字节，末尾还剩下 `01 8f 01 00 16`（键 142、143）。
渲染层 `initSpeakerConfig()` 用 `result.slice(6, 6 + result[3])` 解析，
于是**最后两个参数永远读不到**：

- `142` = `powerNoticeFlag`（开机/关机提示音）
- `143` = `mixLineChannelFlag`（混合输入）

后者有实际后果：`Home` 里「混合通道」是否可选由
`channelStatus[3] == 0 || mixLineChannelFlag === 0` 决定，漏读就恒为 0，
用户把混合输入打开后在通道选择里也选不到它（一直是灰的）。

适配层在 `xiaomi-hid.cjs` 的 `fixStateFrameLength()` 里按终止符反推真实
body 长度回填 `frame[3]`，其余字节不动。修好后 `powerNoticeFlag` 读到 1，
混合通道开关一亮，通道选择里的「混合通道」立刻可选。

**换通道会让设备重新枚举，读法也得跟着变。** 这台音箱会随输入通道
换一个 USB 描述符：

| | USB 通道 | 蓝牙通道 |
|---|---|---|
| PID | `2717:d009` | `2717:d00a` |
| 接口 | 5 个（含 3 个 Audio） | 只剩 1 个 HID |
| ALSA 声卡 | 有 | **消失** |
| Feature report 读 | 可能拿到真实帧 | 恒为默认帧 `00 01 00 03 00 00 80` |
| INPUT report 读 | 拿到真实帧 | 拿到真实帧 |
| `0x90` 查询 | 可能只回 1 字节回显 | 只回 1 字节回显 |
| `0x70` 查询 | 回完整状态帧 | 回完整状态帧 |

Windows 上 `HidD_GetFeature` 能应付这两种布局，libusb 下必须自己兜。
适配层的处理：

1. `acquire()` 每次校验 `busNumber:deviceAddress`，设备重新枚举就丢弃旧句柄
   重开（否则后续传输全是 `LIBUSB_ERROR_NO_DEVICE`）。
2. `getFeatureReport()` 先试 Feature report，拿不到合法状态帧（body < 16 字节，
   用于排除 1 字节回显帧）就改读 INPUT report。
3. 两种读法都失败时补发一条 `0x70` 查询再读 —— 渲染层发的是 `0x90`，
   而这个固件只对 `0x70` 回完整状态。
4. 探明路径后用 `preferredReadPath` 记住，后续直接把渲染层的 `0x90`
   改写成 `0x70`，不再每轮多跑一次失败探测。

不修这个的后果：插在蓝牙通道时 UI 参数全是默认值，通道选择里
「USB 通道」明明不灰却点了没反应 —— 因为读不到真实状态，写回去的
`channelStatus` 也对不上。

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

## 免责声明

**本项目是非官方的个人兼容性移植，与小米科技（Xiaomi）及其关联公司，
以及本软件的任何开发商、发行商，均无隶属、合作、赞助或授权关系。**
文中出现的 "Xiaomi"、"Redmi"、"小米"、"REDMI" 等名称与商标归各自权利人所有，
此处仅用于**指明被兼容的硬件型号**，不表示任何认可或背书。

### 1. 不含任何原厂代码

本仓库**不包含、也不分发** Xiaomi C-HUB 的任何一部分：

* 不包含 MSIX 安装包、`app.asar`、V8 字节码（`index.jsc`）、
  `snapshot_blob.bin` / `v8_context_snapshot.bin`、
  固件包（`*.MVAX`）或烧写工具（`IAPBurner.exe`、`upgrade_flash.exe`）。
* 唯一提交的是重新编写的适配层（`overlay/`）、安装脚本（`scripts/`）
  和 udev 权限规则 —— 这些代码与上述二进制文件没有内容重叠。
* 上述二进制**不会**出现在本仓库里，需要你自行从**合法获得的安装包**中解出，
  使用前提是你已经合法拥有该软件的使用权。

### 2. 使用风险自负

适配层通过 USB 直接与音箱通信，**写入的是真实硬件**。虽然已在本机
（REDMI 电脑音箱 2 Pro 套装，`2717:d009`）上验证了音量、灯效、亮度、
均衡器等常规设置，但：

* 任何对设备的写操作都可能因型号、固件版本差异而产生预期之外的结果。
* **不建议**通过本项目执行固件升级 —— 相关路径依赖 Windows 烧写工具，
  在 Linux 下未完整验证，写坏设备需自行承担。
* 作者不对设备损坏、数据丢失、保修失效或任何间接损失负责。

### 3. 无担保

本项目按 **"现状"（AS-IS）** 提供，不附带任何明示或暗示的担保，
包括但不限于适销性、特定用途适用性和不侵权担保。
在任何情况下，作者或贡献者均不对因使用本项目而产生的任何索赔、
损害或其他责任负责。

### 4. 权利人的请求

如果你是该软件或相关商标的权利人，认为本仓库的某些内容侵犯了你的权益，
请在本仓库的 Issue 区提出（标题注明 `DMCA`），说明涉及的文件或章节、
你的联系方式，以及所主张的权利。收到后我会立即移除相关内容。

### 5. 许可

本仓库**不附带开源许可证**，默认保留所有权利（All rights reserved）。
你可以在自己的机器上阅读、编译和使用它；但未经许可，请不要把它
打包发布到软件仓库、应用商店或以其他方式再分发。

### 6. 生成式人工智能的使用声明

**本项目的代码、脚本、文档绝大部分由生成式 AI 协助产出**，特此披露。

| 项目 | 说明 |
|------|------|
| 模型 | `deepseek-v4.1-flash-1017` |
| 运行环境 | [OpenCode](https://github.com/sst/opencode)（命令行 AI 编程代理） |
| 参与范围 | `overlay/` 适配层、`scripts/`、`udev/` 规则、README 全部章节、提交信息 |

具体来说，AI 完成了以下工作：解包分析 MSIX 与 `app.asar`、定位
V8 字节码必须配 Windows 快照的原因、逆向 USB 控制传输协议（`wLength=128`
的 Feature report 与 `wValue=0x0200` 的 Output report 写入）、编写
libusb 适配层与 udev 规则、在本机逐项验证音量/灯效/亮度/均衡器写入。

**关于可靠性的重要提示：**

* AI 生成的代码可能包含**不易察觉的错误**，尤其在错误处理、边界条件
  和并发路径上。虽然关键路径都在实机上验证过，但测试覆盖面有限
  （仅一个型号：`2717:d009` / REDMI 电脑音箱 2 Pro 套装）。
* 文档中关于 USB 协议、V8 快照机制的描述来自实测与推理，**可能存在
  错误或不完整**。涉及写硬件的操作，请自行复核后再使用。
* 本项目**不保证**适用于其他型号、其他固件版本或其他发行版。
* 使用前请自行审阅代码。因使用本项目导致的任何后果，按第 2、3 条
  由使用者自行承担。

如发现 AI 引入的错误，欢迎通过 Issue 指出。

