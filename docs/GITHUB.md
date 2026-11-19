# 上传到 GitHub：一份流程清单

仓库已经在本机初始化好（`main` 分支、首个提交、`.gitignore` 与 `.gitattributes` 就位）。
下面这些步骤涉及「对外发布」，需要你自己确认后再执行。

## 0. 先决定两件事

| 决策 | 选项 | 影响 |
|---|---|---|
| 仓库可见性 | `--public` / `--private` | 公开仓库等于发布，GPL-3.0 义务随之生效；私有的可以之后再开放 |
| 仓库名 | 建议 `cenro` | 会出现在 clone URL 与 Release 链接里 |

## 1. 登录（只需一次）

```bash
gh auth login          # 选 GitHub.com → HTTPS → 浏览器授权
gh auth status         # 确认账号
```

如果不用 `gh`，也可以先在网页上建好空仓库，再 `git remote add origin <url>`。

## 2. 建仓库并推送

```bash
cd F:/Project/Reader

# 用 gh 一步到位（仓库已存在本地，所以用 --source .）
gh repo create cenro --public --source . --remote origin --push

# 或者手动：
# git remote add origin git@github.com:<账号>/cenro.git
# git push -u origin main
```

首次推送约 30–50 MB（源码 + 图标 + 文档 + 三张截图；`node_modules` / `dist` / `target` / `release` 都在忽略里）。

## 3. 检查忽略是否生效

```bash
git status --ignored --short | head -20     # 应看到 ignored 的 node_modules、dist、target、release
du -sh .git                                 # 正常在 50 MB 以内
```

**绝不能进仓库的东西**（已在 `.gitignore` 里，别用 `git add -f` 加回来）：

| 路径 | 原因 |
|---|---|
| `release/` | 安装包与 APK，走 Release 附件 |
| `src-tauri/target/` `dist/` `node_modules/` | 构建产物与依赖 |
| `.audit/` `cenro-logo-v2_assets/` | 过程截图与设计素材，6–8 MB |
| `.workbuddy/` | 工作区笔记（含本机路径与调试记录） |
| `.testdata/` | 本地测试书库 |

## 4. 打一个版本标签

版本号已在三处同步为 `0.21.0`（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`），
`CHANGELOG.md` 的对应段落也已定稿。

```bash
git tag -a v0.21.0 -m "岑序 0.21.0：划词标注、PDF 文字层搜索、标签与批量导出"
git push origin v0.21.0
```

推标签会触发 `.github/workflows/build.yml`：在 windows / ubuntu / macos 三平台跑 `tauri build`。
**macOS 与 Linux 目前没有实跑过**，第一次大概率会在依赖或系统库上出问题，可以在 Actions 里按需关掉这两条。

## 5. 发布 Release

CI 跑出来的产物是工作流附件，不是 Release。要让人下载，需要单独建 Release：

```bash
gh release create v0.21.0 \
  release/Cenro_0.21.0_x64-setup.exe \
  release/Cenro-0.21.0-win-x64-portable.exe \
  release/Cenro-0.21.0-android-arm64.apk \
  --title "岑序 0.21.0" \
  --notes-file <(sed -n '/## \[0.21.0\]/,/## \[0.20.9\]/p' CHANGELOG.md | head -n -1)
```

（`<(...)` 是 bash 的进程替换；在 PowerShell 里先 `git tag` 再手动粘贴 notes。）

## 6. 之后再要发版时

```bash
# 1) 三处版本号一起改（曾出现 Cargo 停在旧版本、另两处已改的事故）
#    package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
# 2) CHANGELOG 的 [Unreleased] 改成 [x.y.z] - 日期
# 3) 打包：Windows NSIS + 便携 exe、Android APK
# 4) git tag vX.Y.Z && git push origin main --tags
# 5) gh release create ...
```

## 附：仓库里没有的东西

- **签名与公证**：Windows 安装包未做代码签名（SmartScreen 会提示「未知发布者」），
  macOS 未签名也未公证。要签的话需要证书与对应 secrets，工作流里目前没有这一步。
- **应用商店**：没有上架任何商店。
- **CI 缓存**：工作流没配 Rust 缓存，首次构建约 10–15 分钟；后来可以加 `Swatinem/rust-cache`。
