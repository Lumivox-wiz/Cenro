#!/usr/bin/env bash
# Android 构建 + 签名一键脚本。
#
# 为什么不能只跑 `npx tauri android build`：
#   Tauri CLI 不会把新的前端产物写进 gen/android/app/src/main/assets
#   （早期为了绕开符号链接问题手动 cp 过，之后一直是旧文件），
#   结果打出来的 APK 里是上一次的 JS/CSS。这里显式同步一次。
#
# 用法：bash scripts/build-android.sh [--no-build]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export ANDROID_HOME="${ANDROID_HOME:-C:\\Users\\15770\\AppData\\Local\\Android\\Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME\\ndk\\27.0.12077973}"
export JAVA_HOME="${JAVA_HOME:-D:\\Program Files}"

SDK_WIN="$ANDROID_HOME"
BT="$(cygpath -u "$SDK_WIN" 2>/dev/null || echo "$SDK_WIN")/build-tools/36.0.0"
JAVA_BIN="$(cygpath -u "$JAVA_HOME" 2>/dev/null || echo "$JAVA_HOME")/bin/java"
ASSETS="src-tauri/gen/android/app/src/main/assets"

echo "==> 1/6 构建前端"
npm run build

echo "==> 2/6 同步前端产物到 Android assets"
rm -rf "$ASSETS/assets" "$ASSETS/index.html"
cp -r dist/* "$ASSETS"/

echo "==> 3/6 编译 Rust 并打包（gradle）"
npx tauri android build --apk --target aarch64

UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
VERSION="$(node -p "require('./package.json').version")"
OUT="release/Cenro-${VERSION}-android-arm64.apk"
mkdir -p release

echo "==> 4/6 归档旧产物"
# 归档只是收拾旧文件，失败不该拦住出包（归档盘掉线过一次）
bash scripts/archive-old-artifacts.sh || echo "==> 归档跳过，继续构建" >&2

echo "==> 5/6 对齐并签名"
"$BT/zipalign.exe" -f -p 4 "$UNSIGNED" /tmp/aligned.apk
"$JAVA_BIN" -jar "$BT/lib/apksigner.jar" sign \
  --ks "$HOME/.android/debug.keystore" \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$OUT" /tmp/aligned.apk

echo "==> 6/6 校验"
"$JAVA_BIN" -jar "$BT/lib/apksigner.jar" verify "$OUT"
ls -lh "$OUT"
