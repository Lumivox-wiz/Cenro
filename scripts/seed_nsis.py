"""为 tauri bundler 预置 NSIS 工具链到多个候选根目录。

背景：bundler 从 GitHub 下载 nsis-3.13.zip 被 hosts/代理拦断，
需要手动铺设。它检查的是 <tools>/NSIS/ 下 12 个相对路径，
但 tools 根目录的具体位置不确定，故一次性布置所有候选。
"""

import os
import shutil
import zipfile
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
TEMP = Path(os.environ.get("TEMP", "C:/Users/15770/AppData/Local/Temp"))

ZIP = TEMP / "nsis-3.13.zip"
DLL = TEMP / "nsis_tauri_utils.dll"

REQUIRED = [
    "Bin/makensis.exe",
    "Stubs/lzma-x86-unicode",
    "Stubs/lzma_solid-x86-unicode",
    "Plugins/x86-unicode/additional/nsis_tauri_utils.dll",
    "Include/MUI2.nsh",
    "Include/FileFunc.nsh",
    "Include/x64.nsh",
    "Include/nsDialogs.nsh",
    "Include/WinMessages.nsh",
    "Include/Win/COM.nsh",
    "Include/Win/Propkey.nsh",
    "Include/Win/RestartManager.nsh",
]

# 干净构建一份"模板"工具链
template = TEMP / "nsis_template"
if template.exists():
    shutil.rmtree(template)
template.mkdir(parents=True)
with zipfile.ZipFile(ZIP) as z:
    z.extractall(template)

root = template / "nsis-3.13"  # zip 内含顶层目录
# bundler 的 NSIS_REQUIRED_FILES 含根级文件（makensis.exe、NSIS.exe），
# 且会单独校验 NSIS.exe 的 SHA1，因此必须整体上提，不能只挑子目录。
for item in root.iterdir():
    dst = template / item.name
    if item.is_dir():
        shutil.copytree(item, dst, dirs_exist_ok=True)
    else:
        shutil.copy2(item, dst)

plugin_dir = template / "Plugins/x86-unicode/additional"
plugin_dir.mkdir(parents=True, exist_ok=True)
shutil.copy2(DLL, plugin_dir / "nsis_tauri_utils.dll")

missing = [f for f in REQUIRED if not (template / f).exists()]
print("模板完整性:", "通过" if not missing else f"缺 {missing}")

# 候选根目录
candidates = [
    HOME / "AppData/Local/tauri",
    HOME / "AppData/Roaming/tauri",
    HOME / ".tauri",
    HOME / "AppData/Local/tauri/bundler",
    HOME / "AppData/Local/tauri/tools",
    HOME / "AppData/Local/com.tauri.app",
    HOME / "AppData/Local/tauri-cli",
]

for c in candidates:
    target = c / "NSIS"
    if target.exists():
        shutil.rmtree(target)
    c.mkdir(parents=True, exist_ok=True)
    shutil.copytree(template, target)
    marker = target / ".probe_marker"
    marker.write_text("probe", encoding="utf-8")
    print(f"已布置 {target}  (makensis={'有' if (target / 'Bin/makensis.exe').exists() else '无'})")
