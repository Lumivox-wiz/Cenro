# 宣传素材（GitHub 用）

对外发布用的图。源文件是 SVG，交付物是 PNG——原因见末节。

## 文件

| 文件 | 尺寸 | 用在哪 |
|---|---|---|
| `cenro-banner@2x.png` | 2560×800（显示 1280×400） | README 顶部横幅，**引用这个** |
| `cenro-banner.png` | 1280×400 | 同上，1x 版；不想让仓库多背 240 KB 时用 |
| `cenro-social-preview.png` | 1280×640 | GitHub 仓库 Settings → Social preview（分享链接时的预览图） |
| `cenro-banner.svg` | 1280×400 | 源文件，改文案改配色在这里动 |
| `cenro-social.svg` | 1280×640 | 源文件 |
| `render-*.html` | — | 出图脚手架，无头 Edge 截图用 |

## 用法

README 顶部（放在标题下方、正文之前）：

```markdown
![岑序 Cenro：所有格式，一座书架](docs/promo/cenro-banner@2x.png)
```

GitHub 会把图缩到内容区宽度（约 880 px），2x 图在 retina 上不糊。

社交预览：仓库 **Settings → General → Social preview → Edit**，上传 `cenro-social-preview.png`。这是唯一生效的地方，README 里的图不会自动充当预览卡。

## 改文案后重新出图

改对应 `.svg`，然后在 `docs/promo/` 下执行：

```bash
EDGE="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

"$EDGE" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,400 --virtual-time-budget=3000 \
  --screenshot="cenro-banner@2x.png" "file:///$PWD/render-banner.html"

"$EDGE" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,640 --virtual-time-budget=3000 \
  --screenshot="cenro-social-preview.png" "file:///$PWD/render-social.html"
```

`--force-device-scale-factor=2` 出 2x，`=1` 出 1x。截图尺寸 = `window-size × scale`，实测无边框偏移。

## 设计参数

**配色**（取自 `src/styles/tokens.css` 与既有品牌包）

| 角色 | 值 |
|---|---|
| 背景 | `#FDFDFE` → `#F8FAFE` → `#E6EFFB`（对角） |
| 远山 / 中山 / 近山 | `#E2EBF9`·`#D3E1F5` / `#C5D7EF`·`#AFC6E8` / `#94B0DA`·`#7B9BCF` |
| 标题墨色 | `#1B2129` |
| 次级文字 | `#4E5867` / `#7C8698` / `#A6B1C2` |
| 山形标记 | `#1E3F7A` → `#355FA3` → `#5885CC`（沿用 `logo-mark.svg`） |

**字**：中文 `PingFang SC / Microsoft YaHei`，西文 `Inter / SF Pro Display`。标题 600、无衬线，字距 +2（CV 越大越要放松字距，否则四个字糊成一坨）。

**构图**：三层山脊从右下向左上递进，峰高 330 / 406 / 484（1280×640 版），每层右坡带一条白色高光线。文字全部左对齐，压左上角，与右下角的山形成对角平衡。

## 为什么交付 PNG 而不是 SVG

GitHub 用 `<img>` 加载 SVG，**不会加载外部字体**，`<text>` 会掉到访问者的系统字体上：Windows 出微软雅黑、macOS 出苹方、Linux 可能出思源或无衬线兜底。中文大字标题在不同平台的字宽差异足以让两行标语折行错位。

所以 SVG 只作源文件留档，对外一律用 PNG。若必须用 SVG（例如要放进网页做矢量缩放），先在 Illustrator / Figma 里把文字转曲。

顺带：SVG 里的渐变在 GitHub 上能正常渲染，`filter` 不能——这套图没有用 filter，所以即使失误引用了 SVG 也不会崩，只是字体不对。
