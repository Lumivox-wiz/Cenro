#!/usr/bin/env python3
"""在 Gitee 上建发行版并上传 release/ 里的安装包。

为什么要有这个：Gitee 的发行版没有 GitHub 那样的 `gh release create`，
网页上传又是原生文件对话框（脚本没法填路径）。用 API 的话一条命令就能复现，
而且**幂等**——同一 tag 重复跑不会报错、不会传重，只补缺的文件。

用法：

    GITEE_TOKEN=xxx python scripts/release-gitee.py v1.0.0 \\
        --name "岑序 Cenro 1.0.0" --notes docs/gitee-notes.md

令牌在 Gitee「设置 → 私人令牌」生成，勾选 `projects` 即可。
脚本只读 `release/` 目录，不上传仓库里没有的东西。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

API = "https://gitee.com/api/v5"
OWNER = "Lumivox"
REPO = "cenro"

# 只传「用户要下载的东西」。黑名单不够用：apksigner 会顺手产出一个 .idsig，
# 第一次跑就把这个副作用文件当安装包传上去了（后来手动删掉并改成白名单）。
DISTRIBUTABLE = {".exe", ".msi", ".apk", ".bat", ".zip", ".dmg", ".appimage", ".deb"}


def call(path: str, token: str, data: dict | None = None, method: str = "GET"):
    url = f"{API}{path}"
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Authorization": f"token {token}"} if token else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise SystemExit(f"{method} {path} → HTTP {e.code}：{detail}")


def find_release(token: str, tag: str):
    releases = call(f"/repos/{OWNER}/{REPO}/releases?per_page=100", token) or []
    for item in releases:
        if item.get("tag_name") == tag:
            return item
    return None


def create_release(token: str, tag: str, name: str, body: str):
    return call(
        f"/repos/{OWNER}/{REPO}/releases",
        token,
        {
            "tag_name": tag,
            "name": name or tag,
            "body": body,
            "target_commitish": "main",
            "prerelease": "false",
        },
        method="POST",
    )


def upload_asset(token: str, release_id: int, path: str):
    """手搓 multipart：标准库没有现成的，而为一个上传装 requests 不划算。"""
    boundary = f"----cenro{uuid.uuid4().hex}"
    filename = os.path.basename(path)
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(path, "rb") as fh:
        payload = fh.read()

    chunks = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="access_token"\r\n\r\n'.encode(),
        f"{token}\r\n".encode(),
        f"--{boundary}\r\n".encode(),
        (
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode(),
        payload,
        f"\r\n--{boundary}--\r\n".encode(),
    ]

    req = urllib.request.Request(
        f"{API}/repos/{OWNER}/{REPO}/releases/{release_id}/attach_files",
        data=b"".join(chunks),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise SystemExit(f"上传 {filename} → HTTP {e.code}：{detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description="建 Gitee 发行版并上传 release/ 里的安装包")
    ap.add_argument("tag", help="要挂到哪个标签上，例如 v1.0.0")
    ap.add_argument("--name", default="", help="发行版标题，默认与 tag 相同")
    ap.add_argument("--notes", default="", help="说明正文的 Markdown 文件")
    ap.add_argument(
        "--dir",
        default="release",
        help="安装包所在目录，默认 release/（这些文件不入库，需先打包）",
    )
    args = ap.parse_args()

    token = os.environ.get("GITEE_TOKEN", "").strip()
    if not token:
        print("缺少 GITEE_TOKEN。生成方式：Gitee → 设置 → 私人令牌（勾选 projects）", file=sys.stderr)
        return 2

    body = ""
    if args.notes:
        with open(args.notes, encoding="utf-8") as fh:
            body = fh.read()

    release = find_release(token, args.tag)
    if release:
        print(f"发行版已存在：{args.tag}（id {release['id']}），只补文件")
    else:
        release = create_release(token, args.tag, args.name, body)
        print(f"已创建发行版：{args.tag}（id {release['id']}）")

    existing = {a.get("name") for a in (release.get("assets") or [])}
    wanted = sorted(
        os.path.join(args.dir, f)
        for f in os.listdir(args.dir)
        if os.path.isfile(os.path.join(args.dir, f))
        and os.path.splitext(f)[1].lower() in DISTRIBUTABLE
    )
    if not wanted:
        print(f"{args.dir}/ 里没有可上传的文件——先打包", file=sys.stderr)
        return 1

    uploads = 0
    for path in wanted:
        name = os.path.basename(path)
        size = os.path.getsize(path) / 1048576
        if not name.isascii():
            # GitHub 会把附件名里的非 ASCII 字符整段吃掉（曾把「兼容模式启动.bat」变成「.bat」），
            # Gitee 虽然没有这个问题，但两边用同一份 ASCII 文件名最省心。
            print(f"  跳过 {name}（文件名含非 ASCII，请改成 ASCII 再传）")
            continue
        if name in existing:
            print(f"  跳过 {name}（已存在）")
            continue
        upload_asset(token, release["id"], path)
        print(f"  上传 {name}（{size:.2f} MB）")
        uploads += 1

    print(f"完成：新上传 {uploads} 个文件 → https://gitee.com/{OWNER}/{REPO}/releases/tag/{args.tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
