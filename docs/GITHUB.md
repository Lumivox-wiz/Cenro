# 上传到 GitHub：一份流程清单

仓库已经在本机初始化好（`main` 分支、首个提交、`.gitignore` 与 `.gitattributes` 就位）。
下面这些步骤涉及「对外发布」，需要你自己确认后再执行。

## 0. 先决定两件事

| 决策 | 选项 | 影响 |
|---|---|---|
| 仓库可见性 | `--public` / `--private` | 公开仓库等于发布，GPL-3.0 义务随之生效；私有的可以之后再开放 |
| 仓库名 | `Cenro`（与本地 `package.json` 的 name 对应；URL 大小写不敏感） | 会出现在 clone URL 与 Release 链接里 |

## 1. 登录（只需一次）

```bash
gh auth login          # 选 GitHub.com → HTTPS → 浏览器授权
gh auth status         # 确认账号与 scope：推送与建仓需要 `repo`
```

如果不用 `gh`，也可以先在网页上建好空仓库，再 `git remote add origin <url>`。

> **建仓时三个开关都别开**：README、`.gitignore`、license 一律选「不添加」。
> 本地仓库这三样都有，网页上再生成一份会让首次 push 直接被拒（non-fast-forward）。

## 2. 建仓库并推送

```bash
cd F:/Project/Reader

# 用 gh 一步到位（仓库已存在本地，所以用 --source .）
gh repo create Cenro --public --source . --remote origin --push

# 或者手动（仓库已在网页上建好时）：
# git remote add origin https://github.com/Lumivox-wiz/Cenro.git
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

版本号已在三处同步为 `1.0.0`（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`），
`CHANGELOG.md` 的 `[1.0.0]` 段落已定稿。

```bash
git tag -a v1.0.0 -m "岑序 1.0.0：首个正式版"
git push origin v1.0.0
```

推标签会触发 `.github/workflows/build.yml`。**当前只跑 `windows-latest`**：
macOS 与 Linux 从未在这台机器上跑通过，放开就是给每个 tag 挂两个红叉。
矩阵里那两行已经写好、只是注释掉了，谁在对应系统上跑通一次，取消注释即可。

## 5. 发布 Release

CI 跑出来的产物是工作流附件，不是 Release。要让人下载，需要单独建 Release：

```bash
gh release create v1.0.0 \
  release/Cenro_1.0.0_x64-setup.exe \
  release/Cenro-1.0.0-win-x64-portable.exe \
  release/Cenro-1.0.0-android-arm64.apk \
  --title "岑序 1.0.0" \
  --notes-file <(sed -n '/## \[1.0.0\]/,/^## 关于版本号/p' CHANGELOG.md | head -n -2)
```

（`<(...)` 是 bash 的进程替换；在 PowerShell 里先 `git tag` 再手动粘贴 notes。）

## 5.5 仓库 About（描述 / 主页 / 话题）

右侧 About 面板空着时，搜索里既不显示一句话介绍，也进不了话题聚合页。填好一次即可：

| 字段 | 值 |
|---|---|
| Description | 把小说、漫画、PDF 收进同一个书架的本机阅读器。不联网、不要账号，阅读记录就是本机的一个 SQLite 文件。Tauri 2 + React 19。 |
| Website | `https://github.com/Lumivox-wiz/Cenro/releases/latest` |
| Topics | `ebook-reader` `pdf` `comic-reader` `tauri` `rust` `typescript` `android` `local-first` |

网页上改：仓库首页右侧 **About 旁边的齿轮** → 填完点 Save changes。

```bash
# 命令行也可以，但需要 Administration 写权限；只有 repo 内容写权限的 token 会拿到 404
gh api -X PATCH repos/<owner>/<repo> \
  -f description="…" -f homepage="…" \
  -f 'topics[]=ebook-reader' -f 'topics[]=pdf' -f 'topics[]=comic-reader' \
  -f 'topics[]=tauri' -f 'topics[]=rust' -f 'topics[]=typescript' \
  -f 'topics[]=android' -f 'topics[]=local-first'
```

> 那个 404 不是路径写错，也不是仓库名写错：**token 没有 `repo` scope 时，GitHub 对这条端点回 404 而不是 403**。
> 这次踩到的具体情形是环境变量里有一个空的 `GITHUB_TOKEN`，把凭据管理器里的正常 token 顶掉了。
> 排查顺序：`echo ${#GITHUB_TOKEN}` 看有没有被环境变量劫持 → `X-Oauth-Scopes` 看范围 → 最后才怀疑路径。

## 6. 之后再要发版时

```bash
# 1) 三处版本号一起改（曾出现 Cargo 停在旧版本、另两处已改的事故）
#    package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
# 2) CHANGELOG 的 [Unreleased] 改成 [x.y.z] - 日期
# 3) 打包：Windows NSIS + 便携 exe、Android APK
# 4) git tag vX.Y.Z && git push origin main --tags
# 5) gh release create ...
# 6) scripts/mirror-gitee.sh          # 同步代码与标签到 Gitee
# 7) GITEE_TOKEN=xxx python scripts/release-gitee.py vX.Y.Z --notes docs/release-notes.md
```

## 7. Gitee 镜像

代码在 [gitee.com/Lumivox/cenro](https://gitee.com/Lumivox/cenro) 留一份，给国内访问不稳的人。
代码、标签、发行版（含安装包）都有。

首次：

```bash
git remote add gitee https://gitee.com/Lumivox/cenro.git
git push gitee main
git push gitee --tags
```

之后每次发完版跑一次：

```bash
scripts/mirror-gitee.sh
```

脚本里显式清了 `GITHUB_TOKEN` / `GH_TOKEN` 两个环境变量。原因见 §5.5：
这套环境会注入一个空 scope 的 `GITHUB_TOKEN`，它会把凭据管理器里的正常 token 顶掉，
表现为 `git push` 报 `403 ... denied`，而 `gh auth status` 看起来一切正常。

发行版用脚本建，幂等——同一个 tag 重跑只补缺的文件：

```bash
# 令牌：Gitee → 设置 → 私人令牌，勾选 projects
GITEE_TOKEN=xxx python scripts/release-gitee.py v1.0.0 \
  --name "岑序 Cenro 1.0.0" --notes docs/release-notes.md
```

`docs/release-notes.md` 是**当前版本**的发行说明（给下载者看的那份，不是 CHANGELOG），
每次发版改它，GitHub 与 Gitee 共用。

**Gitee 侧的注意事项**：

- 公开仓库要过「开源审核」（提交后一般几十分钟），审核期间只有自己能看到；
- 大于 100 MB 的单文件不允许入库，二进制别提交进仓库；
- 附件名用 ASCII：非 ASCII 文件名在 GitHub 会被吞掉（`兼容模式启动.bat` → `.bat`），
  两边统一用 `Cenro-1.0.0-compat-mode.bat` 这种写法；
- 没有 GitHub Actions 那样的免费 CI，标签推过去只是标签，不会自动构建。

## 附：仓库里没有的东西

- **签名与公证**：Windows 安装包未做代码签名（SmartScreen 会提示「未知发布者」），
  macOS 未签名也未公证。要签的话需要证书与对应 secrets，工作流里目前没有这一步。
- **应用商店**：没有上架任何商店。
- **CI 缓存**：工作流没配 Rust 缓存，首次构建约 10–15 分钟；后来可以加 `Swatinem/rust-cache`。
