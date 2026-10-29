#!/usr/bin/env bash
# 一键安装：udev 规则 + .desktop 入口
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
RULE="$ROOT/udev/60-xiaomi-c-hub.rules"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
BIN="$ROOT/dist/electron/xiaomi-c-hub"

if [ ! -x "$BIN" ]; then
  echo "错误：$BIN 不存在，请先运行 scripts/build.sh" >&2
  exit 1
fi

echo "==> 安装 udev 规则（需要 sudo）"
sudo cp "$RULE" /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor=2717
echo "    完成。如果音箱已经插着，请拔下再插上。"

echo "==> 安装桌面入口"
mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
if [ -f "$ROOT/dist/electron/resources/icon.png" ]; then
  cp "$ROOT/dist/electron/resources/icon.png" "$ICON_DIR/xiaomi-c-hub.png"
fi

cat > "$DESKTOP_DIR/xiaomi-c-hub.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Xiaomi C-HUB
Name[zh_CN]=小米电脑音箱
Comment=Control Xiaomi Desktop Speaker
Exec=$BIN
Icon=xiaomi-c-hub
Terminal=false
Categories=AudioVideo;Audio;
StartupWMClass=xiaomi-c-hub
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" || true

echo
echo "==> 完成。可以从应用菜单启动，或直接运行："
echo "    $BIN"
