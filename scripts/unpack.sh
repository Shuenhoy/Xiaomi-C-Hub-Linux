#!/usr/bin/env bash
# 解包 MSIX 并取出 Electron 应用内容
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
MSIX="$(ls *.Msix 2>/dev/null | head -1)"

if [ -z "$MSIX" ]; then
  echo "错误：找不到 MSIX 安装包" >&2
  exit 1
fi

echo "==> 解包 $MSIX"
rm -rf work
mkdir -p work
unzip -q "$MSIX" -d work
echo "    条目数: $(find work -mindepth 1 | wc -l)"

APP_DIR="$ROOT/work/VFS/UserProgramFiles/Xiaomi%20C-HUB"
if [ ! -d "$APP_DIR" ]; then
  echo "错误：找不到应用目录 $APP_DIR" >&2
  exit 1
fi

echo "==> 解包 resources/app.asar"
rm -rf work/app
npx --yes @electron/asar extract "$APP_DIR/resources/app.asar" work/app
echo "    文件数: $(find work/app -type f | wc -l)"

echo "==> 完成"
echo "    Electron 版本: $(grep -ao 'Electron/[0-9.]*' "$APP_DIR/Xiaomi C-HUB.exe" 2>/dev/null | head -1 || echo '未知')"
