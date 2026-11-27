import { CUSTOM_FONT_FAMILY, ensureCustomFonts, type FontChoice } from "./fonts";

export type { FontChoice };
export type ThemePref = "light" | "dark" | "system";
export type ReaderTheme = "follow" | "light" | "dark" | "sepia" | "oled";

/**
 * 表面材质（v1.13）。
 *
 * 与 ThemePref **正交**：配色是「用什么颜色」，材质是「表面由什么构成」。
 * 液态玻璃既可以是亮玻璃也可以是暗玻璃，硬塞进 data-theme 会逼着 themes.css
 * 把亮色那 70 行变量整份复制一遍，且再也无法「液态 + 暗色」组合。
 *
 * flat 是默认值，此时不写任何 DOM 属性 —— 没选液态的用户，
 * CSS 里 `[data-material="liquid"]` 开头的规则一条都不会被匹配。
 */
export type SurfaceMaterial = "flat" | "liquid";
export type SidebarPref = "auto" | "expanded" | "collapsed";
export type ViewMode = "grid" | "list";
export type SortMode = "recent" | "added" | "title";
/** 单双页偏好。auto 时按窗口宽度决定（UI §6.3：≥1440 默认双页） */
export type SpreadModePref = "auto" | "single" | "double";

/** PDF 翻页 / 连续滚动。auto 时按缩放自动切换（UI §6.5） */
export type PdfModePref = "auto" | "paged" | "scroll";

/** 正文字体族。只给有把握在 Windows / Android / iOS 上都存在的几套。 */
export type ReaderFont = "serif" | "sans" | "kai" | "mono";

/** 双页模式下封面（单张）的对齐方式 */
export type SpreadCoverAlign = "center" | "edge";

/**
 * 书架背景图的填充方式（对应 CSS `object-fit`）。
 *
 * auto 走 cover：背景图的默认期待是「铺满窗口」，留白反而不像壁纸。
 * 想完整看到整张图时手动选「等比适应」。
 */
export type BgFit = "auto" | "cover" | "contain" | "fill";

/**
 * 书架背景图（v1.9）。
 *
 * 只作用于书架层，不进阅读页：正文纸面必须保持纯色，
 * 背景图会让长文阅读变成"透过一层纱看字"（UI_SPEC §2.9 同一条理由）。
 */
export interface ShelfBackground {
  /** 图片绝对路径；null 表示未设置 */
  path: string | null;
  fit: BgFit;
  /** 0~100。默认 100 由遮罩负责可读性，而不是靠图片本身发虚 */
  opacity: number;
  /** 0~40 px。模糊与遮罩是两种手段：模糊盖住细节，遮罩压住亮度 */
  blur: number;
  /** 图片与内容之间叠一层纸色。关掉时正文可读性全靠图片本身 */
  scrim: boolean;
}

/**
 * 莫奈取色（v1.9）：从背景图取一个主色相，派生成强调色 / 选中底 / 光晕。
 *
 * 缓存 `source` 是为了判断「色板还配不配得上现在这张图」——
 * 换图后不重算会留下一套与画面无关的配色，比不做还奇怪。
 */
export interface MonetSetting {
  enabled: boolean;
  /** 色板来自哪张图；与 background.path 不一致即视为过期 */
  source: string | null;
  /** 0~360 */
  hue: number;
  /** 0~1，原图的加权平均饱和度（派生时会提纯，不直接当强调色） */
  saturation: number;
  /** 0~1 */
  lightness: number;
  /** 有效像素占比。低于 0.02 视为「这张图没有色调」 */
  coverage: number;
}

export interface Prefs {
  theme: ThemePref;
  readerTheme: ReaderTheme;
  sidebar: SidebarPref;
  view: ViewMode;
  readerFontSize: number;
  readerLineHeight: number;
  readerPageWidth: number;
  /** 正文字体族（衬线 / 黑体 / 楷体 / 等宽） */
  readerFont: ReaderFont;
  /** 自定义中文字体；null 表示跟随上面的字体族 */
  readerFontCjk: FontChoice | null;
  /** 自定义西文字体；排在中文之前，负责拉丁字母与数字 */
  readerFontLatin: FontChoice | null;
  /** 段间距，单位 em。0 表示不留空行 */
  readerParaGap: number;
  /** 页边距（左右各多少 px）。0 表示贴满版心 */
  readerMargin: number;
  /**
   * 顶部安全区补偿（px）。挖孔屏/灵动岛各家高度不一，env() 又不一定报得准，
   * 留一个手动补差值的口子——补一次就一劳永逸，不必等我们适配某个机型。
   */
  safeTopExtra: number;
  /** 书架排序，默认最近阅读（UX §6.3） */
  sort: SortMode;
  /**
   * 漫画 / PDF 的单双页。auto 表示跟随窗口宽度：
   * ≥1440 默认双页，<1440 单页；手动选择后锁定，不随窗口变化（UI §6.3）。
   */
  spreadMode: SpreadModePref;
  /**
   * PDF 模式。auto：缩放 >110% 切连续滚动、<95% 切回翻页；
   * 手动选过之后锁定，直到用户再点一次解除（UI §6.5）。
   */
  pdfMode: PdfModePref;
  /**
   * 双页封面对齐。规范 §6.3 要求靠边（日漫右 / 西漫左），
   * 用户此前明确偏好居中，故默认为 center，可切回 edge。
   */
  spreadCover: SpreadCoverAlign;
  /**
   * 漫画首次进入时的一次性方向提示（UX §4.2）。
   * 关掉后不再弹出；已弹过一次的设备不再重复。
   */
  comicDirHint: boolean;
  /** 书架背景图（v1.9） */
  background: ShelfBackground;
  /** 莫奈取色（v1.9） */
  monet: MonetSetting;
  /** 表面材质（v1.13）：flat 标准 / liquid 液态玻璃 */
  material: SurfaceMaterial;
  /**
   * 翻译服务：OpenAI 兼容端点。默认指向本机 5001 端口（koboldcpp 的默认口）。
   *
   * 不做成「厂商」下拉：本地推理服务五花八门，但几乎都兼容
   * `/v1/chat/completions`。填一个地址比维护一张厂商表可靠。
   */
  translateEndpoint: string;
  /** 模型名。本地服务多半忽略它，但协议要求带上 */
  translateModel: string;
  /** 目标语言，直接写进提示词 */
  translateTarget: string;
  /** 可选 Bearer；本地服务留空即可 */
  translateApiKey: string;
}

const KEY = "reader.prefs.v1";

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  readerTheme: "follow",
  sidebar: "auto",
  view: "grid",
  readerFontSize: 18,
  readerLineHeight: 1.75,
  readerPageWidth: 680,
  readerFont: "serif",
  readerFontCjk: null,
  readerFontLatin: null,
  readerParaGap: 0.9,
  readerMargin: 0,
  safeTopExtra: 0,
  sort: "recent",
  spreadMode: "auto",
  pdfMode: "auto",
  spreadCover: "center",
  comicDirHint: true,
  background: {
    path: null,
    fit: "auto",
    opacity: 100,
    blur: 0,
    scrim: true,
  },
  monet: {
    enabled: false,
    source: null,
    hue: 0,
    saturation: 0,
    lightness: 0,
    coverage: 0,
  },
  material: "flat",
  translateEndpoint: "http://127.0.0.1:5001/v1/chat/completions",
  translateModel: "local",
  translateTarget: "简体中文",
  translateApiKey: "",
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    /*
     * 嵌套对象要逐层合并：v1.9 之前存下的 prefs 里没有 background / monet，
     * 只做顶层展开会得到 undefined，随后每次读 background.path 都要写 `?.`。
     * 合并一次，之后所有调用点都是完整对象。
     */
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      background: { ...DEFAULT_PREFS.background, ...(parsed.background ?? {}) },
      monet: { ...DEFAULT_PREFS.monet, ...(parsed.monet ?? {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式等场景写入失败不影响运行 */
  }
}

/** system 解析为实际值：data-theme 只接受 light / dark（规范 3.1）。 */
export function resolveAppTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

export function applyAppTheme(pref: ThemePref) {
  document.documentElement.dataset.theme = resolveAppTheme(pref);
}

/**
 * 应用表面材质（v1.13）。
 *
 * flat 时**移除**属性而不是写 data-material="flat"：
 * 默认路径不该为一个可选主题多付一条选择器匹配，也让「有没有开液态」
 * 在 DevTools 里一眼可读（有这个属性就是开了）。
 */
export function applyMaterial(pref: SurfaceMaterial) {
  const el = document.documentElement;
  if (pref === "liquid") el.dataset.material = "liquid";
  else delete el.dataset.material;
}

/** 阅读主题仅在「跟随应用」时同步；独立设置时不随系统变化（规范 3.2）。 */
export function resolveReaderTheme(readerTheme: ReaderTheme): string {
  if (readerTheme !== "follow") return readerTheme;
  return resolveAppTheme(loadPrefs().theme);
}

/**
 * 字体族只列各平台**自带**的字体，不引 web font：
 * 本地优先的阅读器不该为一行字去下载几百 KB。
 * 每条都给足回退，缺字体时退到系统同类，不会掉成方块。
 */
export const READER_FONT_STACK: Record<ReaderFont, string> = {
  serif: '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif',
  sans: '"Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif',
  mono: '"JetBrains Mono", "Cascadia Code", Consolas, "Noto Sans Mono CJK SC", monospace',
};

export function applyReaderVars(prefs: Prefs) {
  const root = document.documentElement.style;
  root.setProperty("--reader-font-size", `${prefs.readerFontSize}px`);
  root.setProperty("--reader-line-height", String(prefs.readerLineHeight));
  root.setProperty("--reader-page-width", `${prefs.readerPageWidth}px`);
  /*
   * 字体栈：西文 → 中文 → 系统字体族。
   * 浏览器按「第一个有该字形的字体」取字，所以西文字体只吃拉丁字母与数字，
   * 汉字自然落到后面的中文字体——「中西文分设」因此不需要切内容。
   */
  const families: string[] = [];
  if (prefs.readerFontLatin?.path) families.push(`"${CUSTOM_FONT_FAMILY.latin}"`);
  if (prefs.readerFontCjk?.path) families.push(`"${CUSTOM_FONT_FAMILY.cjk}"`);
  families.push(READER_FONT_STACK[prefs.readerFont ?? "serif"]);
  root.setProperty("--font-reader", families.join(", "));
  // 注册是异步的：字体就绪后浏览器会自动重绘，不需要等它再设置变量
  ensureCustomFonts(prefs);
  root.setProperty("--reader-para-gap", `${prefs.readerParaGap ?? 0.9}em`);
  root.setProperty("--reader-margin", `${prefs.readerMargin ?? 0}px`);
  root.setProperty("--safe-top-extra", `${prefs.safeTopExtra ?? 0}px`);
}
