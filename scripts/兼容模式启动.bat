@echo off
REM ============================================================
REM  岑序 · 兼容模式启动
REM
REM  用这个启动如果界面正常、直接双击 exe 却是一片黑，
REM  说明这台机器的 WebView2 在用 GPU 合成时渲染失败
REM  （老 Intel 核显 + 旧驱动最常见，远程桌面/虚拟机里也会）。
REM
REM  用法：把本文件放在 exe 同一个目录，双击即可。
REM  它只对本次启动生效，不改系统设置、不写注册表。
REM ============================================================

set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu --disable-gpu-compositing

set TARGET=
for %%F in ("%~dp0Cenro-*-win-x64-portable.exe") do set TARGET=%%~fF

if "%TARGET%"=="" (
  echo 没找到 Cenro-*-win-x64-portable.exe。
  echo 请把本文件和 exe 放在同一个目录里再运行。
  pause
  exit /b 1
)

echo 以兼容模式启动：%TARGET%
echo 参数：%WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS%
start "" "%TARGET%"
