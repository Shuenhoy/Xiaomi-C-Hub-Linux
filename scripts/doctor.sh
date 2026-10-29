#!/usr/bin/env bash
# 诊断：检查音箱是否插入、接口布局、权限是否就绪
set -uo pipefail

VID=2717
PIDS="d003 d004 d007 d008 d009 d00a d00b d00c"

echo "==> 1. 查找 Xiaomi 音箱"
found_dev=""
for pid in $PIDS; do
  for d in /sys/bus/usb/devices/*; do
    [ -f "$d/idVendor" ] || continue
    [ "$(cat "$d/idVendor" 2>/dev/null)" = "$VID" ] || continue
    [ "$(cat "$d/idProduct" 2>/dev/null)" = "$pid" ] || continue
    found_dev="$d"
    echo "    找到 $d  (VID:PID = $VID:$pid)"
    echo "    产品: $(cat "$d/product" 2>/dev/null || echo '?')"
    echo "    序列: $(cat "$d/serial" 2>/dev/null || echo '?')"
  done
done

if [ -z "$found_dev" ]; then
  echo "    没有找到。请确认音箱已用 USB 连接（不是蓝牙）。"
  exit 1
fi

echo
echo "==> 2. 接口布局"
for i in "$found_dev":*; do
  [ -d "$i" ] || continue
  iface="$(basename "$i")"
  cls="$(cat "$i/bInterfaceClass" 2>/dev/null || echo '?')"
  if [ -e "$i/driver" ]; then
    drv="$(basename "$(readlink -f "$i/driver")")"
  else
    drv="无（未绑定）"
  fi
  eps=$(ls -d "$i"/ep_* 2>/dev/null | wc -l)
  case "$cls" in
    01) clsname="Audio" ;;
    03) clsname="HID" ;;
    *)  clsname="class $cls" ;;
  esac
  printf "    %-22s %-8s 端点=%s 驱动=%s\n" "$iface" "$clsname" "$eps" "$drv"
done

echo
echo "==> 3. hidraw 节点"
shopt -s nullglob
for h in /sys/class/hidraw/hidraw*; do
  devpath="$(readlink -f "$h/device" 2>/dev/null)"
  case "$devpath" in
    *"${found_dev##*/}"*)
      node="/dev/$(basename "$h")"
      echo "    $node  权限 $(stat -c '%A %U:%G' "$node" 2>/dev/null)"
      ;;
  esac
done
shopt -u nullglob

echo
echo "==> 4. USB 设备节点权限（关键）"
busnum="$(cat "$found_dev/busnum")"
devnum="$(cat "$found_dev/devnum")"
node="$(printf '/dev/bus/usb/%03d/%03d' "$busnum" "$devnum")"
if [ -c "$node" ]; then
  perm="$(stat -c '%A %U:%G' "$node")"
  echo "    $node  $perm"
  if [ -r "$node" ] && [ -w "$node" ]; then
    echo "    ✅ 当前用户可读写，程序应该能连接到音箱"
  else
    echo "    ❌ 当前用户不能读写，程序会一直显示“未连接”"
    if [ -f /etc/udev/rules.d/60-xiaomi-c-hub.rules ]; then
      echo "       规则文件已存在，但设备节点还没更新 —— 请拔下音箱重新插上。"
    else
      echo "       请安装规则："
      echo "         sudo cp udev/60-xiaomi-c-hub.rules /etc/udev/rules.d/"
      echo "         sudo udevadm control --reload-rules && sudo udevadm trigger"
      echo "       然后拔下音箱重新插上。"
    fi
  fi
else
  echo "    ❌ $node 不存在"
fi

echo
echo "==> 5. 说明"
echo "    音箱的配置通道是 interface 4（HID class，0 个端点）。"
echo "    Linux usbhid 无法为它建立 hidraw 节点，"
echo "    所以 /dev/hidraw* 只能看到 interface 3（音量旋钮），"
echo "    控制数据必须走 libusb 对 /dev/bus/usb/BBB/DDD 做控制传输。"
