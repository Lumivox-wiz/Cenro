#!/usr/bin/env bash
# 把 release/ 里不属于「当前版本」的产物移进 release/历史产物/。
#
# 只移动、不删除；同名文件已存在时直接覆盖历史里的旧副本。
# 当前版本取自 package.json，所以版本号先改、再归档，顺序不能反。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"

# 归档目的地：外部归档盘存在就放过去，否则退回仓库内。
# 旧包一年多下来能到 GB 级，留在工作盘上只会拖慢备份与搜索。
ARCHIVE_ROOT="${CENRO_ARCHIVE:-H:/AAA项目归档文件/Cenro}"

# 用「能不能真的建出目录」来判断，而不是 `-d`。
# MSYS 对外部盘/断开的网络盘做 stat 时会给出误导性的结果：
# 归档盘明明已经不可写，`-d` 仍返回真，接着 mkdir 才报
# 「Not a directory」，把整条打包链一起拖死。
HISTORY="release/历史产物"
if mkdir -p "$ARCHIVE_ROOT/release/历史产物" 2>/dev/null; then
  HISTORY="$ARCHIVE_ROOT/release/历史产物"
else
  echo "==> 归档盘不可用，旧产物留在 release/history 下" >&2
  mkdir -p "$HISTORY"
fi

moved=0
for path in release/*; do
  [ -f "$path" ] || continue
  case "$path" in
    *"$VERSION"*) continue ;;   # 当前版本，留下
    *.bat) continue ;;          # 启动器之类的小工具，跟版本无关
  esac
  mv -f "$path" "$HISTORY/"
  moved=$((moved + 1))
done

if [ "$moved" -gt 0 ]; then
  echo "==> 已归档 $moved 个旧产物到 $HISTORY（当前版本 $VERSION）"
else
  echo "==> release/ 只有 $VERSION 的产物，无需归档"
fi

# 仓库内的空壳目录留着只会让人以为「旧包还在这儿」
rmdir release/历史产物 2>/dev/null || true
