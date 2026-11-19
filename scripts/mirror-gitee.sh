#!/usr/bin/env bash
# 把本地 main 与标签同步到 Gitee 镜像。
#
# 为什么单独写一条：Gitee 与 GitHub 的凭据是两套，且这个环境里注入过一个
# 空 scope 的 GITHUB_TOKEN，会把凭据管理器里的正常 token 顶掉 —— 推送前必须清掉，
# 否则报 403 而看不出原因。
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${GITEE_REMOTE:-gitee}"

if ! git remote | grep -qx "$REMOTE"; then
  echo "没有名为 $REMOTE 的远端。先执行：" >&2
  echo "  git remote add $REMOTE https://gitee.com/Lumivox/cenro.git" >&2
  exit 1
fi

echo "→ 推送 main"
env -u GITHUB_TOKEN -u GH_TOKEN git push "$REMOTE" main
echo "→ 推送标签"
env -u GITHUB_TOKEN -u GH_TOKEN git push "$REMOTE" --tags
echo "完成：$(git rev-parse --short HEAD) 已同步到 $REMOTE"
