#!/usr/bin/env bash
# 组装可直接运行的 Linux 版 Xiaomi C-HUB
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

ELECTRON_VERSION=36.8.1
MSIX_APP="$ROOT/work/VFS/UserProgramFiles/Xiaomi%20C-HUB"
OUT="$ROOT/dist/electron"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/xiaomi-c-hub"
ZIP="$CACHE/electron-v${ELECTRON_VERSION}-linux-x64.zip"

if [ ! -d "$ROOT/work/app" ]; then
  echo "错误：work/app 不存在，请先运行 scripts/unpack.sh" >&2
  exit 1
fi

# 1. Electron 运行时
mkdir -p "$CACHE"
if [ ! -f "$ZIP" ]; then
  echo "==> 下载 Electron $ELECTRON_VERSION (linux-x64)"
  curl -fL --retry 3 -o "$ZIP" \
    "https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
fi

echo "==> 解压 Electron"
rm -rf "$OUT"
mkdir -p "$OUT"
unzip -q "$ZIP" -d "$OUT"

# 2. 关键：用 Windows 版快照文件覆盖 Linux 版
#
# out/main/index.jsc 是 V8 字节码。字节码里内嵌了生成它的 V8 快照的
# 外部引用表（external references）索引，运行时按索引从快照取函数指针。
# Linux 与 Windows 的 Electron 被打包时的快照不同（内置函数数量/顺序不同），
# 用 Linux 快照会直接 cachedDataRejected。
echo "==> 同步 Windows 版 V8 快照"
for f in snapshot_blob.bin v8_context_snapshot.bin; do
  if [ -f "$MSIX_APP/$f" ]; then
    cp "$MSIX_APP/$f" "$OUT/$f"
  else
    echo "    警告：$f 缺失（$MSIX_APP）" >&2
  fi
done

# 3. 应用内容
echo "==> 复制应用"
mkdir -p "$OUT/resources/app"
cp -r "$ROOT/work/app/." "$OUT/resources/app/"

# 4. 应用自带的资源（图标、固件工具、OTA 包）
#
# 注意：MSIX 的 resources/ 里还有 Windows 版的 app.asar / app.asar.unpacked，
# 绝不能一起复制 —— Electron 优先加载 resources/app.asar，会把我们的 app/ 目录
# （以及其中的 Linux 适配层）整个屏蔽掉。
echo "==> 复制应用资源"
if [ -d "$MSIX_APP/resources" ]; then
  for entry in "$MSIX_APP/resources"/*; do
    base="$(basename "$entry")"
    case "$base" in
      app.asar|app.asar.unpacked|app) continue ;;
    esac
    cp -r "$entry" "$OUT/resources/"
  done
fi

# app.asar 解包出来的 resources/ 里没有 app.asar 之外的东西，但图标在顶层
for f in icon.png icon16.png IAPBurner.exe upgrade_flash.exe; do
  [ -f "$ROOT/work/app/resources/$f" ] && cp "$ROOT/work/app/resources/$f" "$OUT/resources/$f"
done
[ -d "$ROOT/work/app/resources/OTA" ] && cp -r "$ROOT/work/app/resources/OTA" "$OUT/resources/"
[ -d "$ROOT/work/app/resources/ota2b03" ] && cp -r "$ROOT/work/app/resources/ota2b03" "$OUT/resources/"

# 5. Linux 适配层
echo "==> 安装 Linux 适配层"
cp "$ROOT/overlay/out/main/linux-shim.cjs" "$OUT/resources/app/out/main/"
cp "$ROOT/overlay/out/main/xiaomi-hid.cjs" "$OUT/resources/app/out/main/"
cat > "$OUT/resources/app/out/main/index.js" <<'EOF'
require("./linux-shim.cjs");
require("./bytecode-loader.cjs");
require("./index.jsc");
EOF

# 6. 可执行文件名改成程序期望的名字
if [ -f "$OUT/electron" ]; then
  mv "$OUT/electron" "$OUT/xiaomi-c-hub"
fi
chmod +x "$OUT/xiaomi-c-hub"
[ -f "$OUT/chrome-sandbox" ] && chmod 4755 "$OUT/chrome-sandbox" 2>/dev/null || true

echo
echo "==> 完成: $OUT"
echo "    运行: $OUT/xiaomi-c-hub"
echo "    首次运行前请安装 udev 规则：udev/60-xiaomi-c-hub.rules"
