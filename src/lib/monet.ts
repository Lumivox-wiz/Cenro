import type { MonetSetting } from "./prefs";

/**
 * 莫奈取色的派生层。
 *
 * 后端（`src-tauri/src/monet.rs`）只给一个色相与饱和/明度，这里是「把色相变成能用的配色」。
 * 难点不在取色，在**对比度**：同一个色相在亮色纸面上要压暗才看得清，
 * 到暗色纸面上又得提亮，两边不可能共用一组 RGB。所以派生按主题各算一遍。
 *
 * 所有对比度都实算（WCAG 相对亮度），不靠调参试出来——
 * 取色是个开放输入，任何一张图都可能给出极端色相（柠檬黄 / 藏青），
 * 靠预设的明度阶一定会有一档翻车。
 */

/** 派生结果，全部是可直接写进 CSS 变量的字符串 */
export interface MonetPalette {
  accent: string;
  accentText: string;
  accentHover: string;
  accentSubtle: string;
  bgSelected: string;
  borderFocus: string;
  glowA: string;
  glowB: string;
}

/** 与 tokens.css / themes.css 的 --c-bg-app 一致，用于实算对比度 */
const PAPER: Record<"light" | "dark", RGB> = {
  dark: [23, 25, 30], // #17191e
  light: [243, 244, 246], // #f3f4f6
};

type RGB = [number, number, number];

/** 有效像素低于这个比例就认为「这张图没有色调」，开关置灰而不是给一套灰配色 */
export const MONET_MIN_COVERAGE = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** h 0~360, s/l 0~1 → 0~255 的 RGB */
function hslToRgb(h: number, s: number, l: number): RGB {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const m = l - c / 2;
  return [
    Math.round(clamp(r + m, 0, 1) * 255),
    Math.round(clamp(g + m, 0, 1) * 255),
    Math.round(clamp(b + m, 0, 1) * 255),
  ];
}

/** WCAG 相对亮度（sRGB 逆 gamma） */
function relativeLuminance([r, g, b]: RGB): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function hex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function rgba([r, g, b]: RGB, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 往「够对比」的方向挪明度，直到达标或撞到边界。
 *
 * 亮色往暗走、暗色往亮走——不是审美选择，是纸面方向决定的：
 * 亮纸上只有更暗的东西才会显得"更靠前"。
 */
function fitLightness(
  hue: number,
  saturation: number,
  startL: number,
  paper: RGB,
  need: number,
  dark: boolean,
): RGB {
  let l = startL;
  let rgb = hslToRgb(hue, saturation, l);
  for (let i = 0; i < 60 && contrastRatio(rgb, paper) < need; i++) {
    l += dark ? 0.01 : -0.01;
    if (l <= 0.02 || l >= 0.98) break;
    rgb = hslToRgb(hue, saturation, l);
  }
  return rgb;
}

/**
 * 从一个色相派生整套配色。
 *
 * @param hue 0~360
 * @param saturation 原图加权平均饱和度（0~1）。会被提纯，因为照片的平均饱和
 *   通常只有 0.15~0.3，直接当强调色是一块洗不干净的脏色。
 * @param lightness 原图加权平均明度。只在需要判断「图整体偏暗」时用。
 * @param dark 当前是否是暗色主题
 */
export function derivePalette(
  hue: number,
  saturation: number,
  lightness: number,
  dark: boolean,
): MonetPalette {
  const paper = dark ? PAPER.dark : PAPER.light;

  // 提纯：下限保证"看得出是有颜色的"，上限防止推到荧光。
  // 原图本来就更饱和时（花、霓虹）不必强行拉到 0.72，保留它的性格。
  const s = clamp(saturation * 1.55, dark ? 0.42 : 0.5, 0.74);

  // 起点：亮色 0.46 / 暗色 0.62。这是多数色相刚好能过 3:1 的位置。
  const accentRgb = fitLightness(hue, s, dark ? 0.62 : 0.46, paper, 3.0, dark);

  /*
   * 文字版强调色（--c-accent-text）必须 ≥4.5:1。
   * 它和 accent 是两件事：accent 画竖条、进度条、图标（3:1 即可），
   * accent-text 是文字（4.5:1）。过去把两者混用，结果不是文字太淡就是图形太闷。
   *
   * 起点在 accent 基础上再走 8%，让二者肉眼可分；不够再继续挪。
   */
  const accentL = dark ? 0.62 : 0.46;
  const textStart = dark ? accentL + 0.08 : accentL - 0.08;
  const textRgb = fitLightness(hue, s, textStart, paper, 4.5, dark);

  // hover 在 accent 基础上再走一档，方向与文字一致（亮色更深、暗色更亮）
  const hoverRgb = fitLightness(
    hue,
    s,
    clamp(accentL + (dark ? 0.08 : -0.08), 0.05, 0.95),
    paper,
    3.0,
    dark,
  );

  /*
   * 光晕沿用 v1.6 的幅度（亮 0.075/0.065、暗 0.055/0.045）。
   * 原图整体很暗时再降一档：暗色纸面上叠一层深色光晕等于没画，
   * 而亮色纸面上深色光晕会变成一块脏斑。
   */
  const glowScale = lightness < 0.25 ? 0.7 : 1;
  const glowA = dark ? 0.055 * glowScale : 0.075 * glowScale;
  const glowB = dark ? 0.045 * glowScale : 0.065 * glowScale;

  return {
    accent: hex(accentRgb),
    accentText: hex(textRgb),
    accentHover: hex(hoverRgb),
    accentSubtle: rgba(accentRgb, dark ? 0.13 : 0.09),
    bgSelected: rgba(accentRgb, dark ? 0.16 : 0.12),
    borderFocus: hex(accentRgb),
    glowA: rgba(accentRgb, glowA),
    glowB: rgba(accentRgb, glowB),
  };
}

/**
 * 莫奈取色接管了哪些变量。
 *
 * 只接管「强调色一族 + 光晕」。纸面底色、文字色、卡片色一律不动：
 * 那些是正文可读性的地基，跟着取色走会把整套对比度一起带翻
 * （详见 docs/UI_SPEC.md §2.9.2）。
 */
const MONET_VARS = [
  "--c-accent",
  "--c-accent-text",
  "--c-accent-hover",
  "--c-accent-subtle",
  "--c-bg-selected",
  "--c-border-focus",
  "--glow-a",
  "--glow-b",
] as const;

/** 取色是否真的可用（开了但色板过期 / 图没色调时都不算） */
export function monetReady(monet: MonetSetting, path: string | null): boolean {
  return monet.enabled && monet.coverage >= MONET_MIN_COVERAGE && !!path && monet.source === path;
}

/**
 * 把莫奈配色写进根节点。
 *
 * 走 inline style 而不是 data 属性 + 选择器：配色是**算出来的连续值**，
 * 穷举成选择器组合表（36 个色相 × 两套主题）不现实。
 * inline 变量优先级高于任何样式表，关闭时 removeProperty 就干净退回 tokens。
 */
export function applyMonet(monet: MonetSetting, path: string | null): void {
  const root = document.documentElement.style;
  if (!monetReady(monet, path)) {
    for (const key of MONET_VARS) root.removeProperty(key);
    return;
  }

  const dark = document.documentElement.dataset.theme !== "light";
  const palette = derivePalette(monet.hue, monet.saturation, monet.lightness, dark);

  root.setProperty("--c-accent", palette.accent);
  root.setProperty("--c-accent-text", palette.accentText);
  root.setProperty("--c-accent-hover", palette.accentHover);
  root.setProperty("--c-accent-subtle", palette.accentSubtle);
  root.setProperty("--c-bg-selected", palette.bgSelected);
  root.setProperty("--c-border-focus", palette.borderFocus);
  root.setProperty("--glow-a", palette.glowA);
  root.setProperty("--glow-b", palette.glowB);
}

/** 设置页预览用：拿到两套主题下的实际色值，而不只是一个色相 */
export function previewPalette(monet: MonetSetting): {
  light: MonetPalette;
  dark: MonetPalette;
} | null {
  if (monet.coverage < MONET_MIN_COVERAGE) return null;
  return {
    light: derivePalette(monet.hue, monet.saturation, monet.lightness, false),
    dark: derivePalette(monet.hue, monet.saturation, monet.lightness, true),
  };
}
