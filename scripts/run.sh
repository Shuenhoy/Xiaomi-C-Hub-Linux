#!/usr/bin/env bash
# 启动 Xiaomi C-HUB
set -uo pipefail

cd "$(dirname "$0")/.."
BIN="$PWD/dist/electron/xiaomi-c-hub"

if [ ! -x "$BIN" ]; then
  echo "错误：$BIN 不存在，请先运行 scripts/build.sh" >&2
  exit 1
fi

# 检查 USB 权限，避免用户对着"未连接"的界面猜
node=""
for d in /sys/bus/usb/devices/*; do
  [ -f "$d/idVendor" ] || continue
  [ "$(cat "$d/idVendor" 2>/dev/null)" = "2717" ] || continue
  busnum="$(cat "$d/busnum" 2>/dev/null)"
  devnum="$(cat "$d/devnum" 2>/dev/null)"
  [ -n "$busnum" ] && [ -n "$devnum" ] || continue
  node="$(printf '/dev/bus/usb/%03d/%03d' "$busnum" "$devnum")"
  break
done

if [ -n "$node" ] && [ -c "$node" ] && { [ ! -r "$node" ] || [ ! -w "$node" ]; }; then
  echo "警告：没有 $node 的读写权限，程序会显示“未连接”。" >&2
  echo "      请运行 ./scripts/install.sh 安装 udev 规则，然后拔插音箱。" >&2
  echo >&2
fi

exec "$BIN" "$@"
