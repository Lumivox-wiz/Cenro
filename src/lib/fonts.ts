/**
 * 自定义字体。
 *
 * 只做一件事：把用户选中的字体文件注册成两条固定家族名，
 * 由 `--font-reader` 的字体栈去引用。这样切换自定义字体不需要动 CSS 文件，
 * 也不用往样式表里塞 `@font-face`（那份 CSS 是打包产物，改不了）。
 *
 * 家族顺序有讲究：`cenro-latin` 排在 `cenro-cjk` 前面。
 * 浏览器的规则是「逐个字体找字形」，西文字体先命中拉丁字母、缺的汉字落到中文字体，
 * 于是「西文用一套、中文用另一套」是自然结果，不需要按字符切内容。
 *
 * 加载失败（文件被删、不是字体、被 CSP 拦）不报错给用户：
 * 家族名解析不到字形时正文会自动落到栈里的下一档系统字体，
 * 只在日志里留一条，便于排查「选了字体但没变化」。
 */
import { fileUrl } from "../api";
import { logWarn } from "./log";

/** 供设置页展示与 `--font-reader` 拼栈使用 */
export const CUSTOM_FONT_FAMILY = {
  latin: "cenro-latin",
  cjk: "cenro-cjk",
} as const;

export interface FontChoice {
  /** 字体文件绝对路径 */
  path: string;
  /** 展示名，取自文件名 */
  name: string;
}

/** 已注册的字体，键为「家族|路径」。换字体不会重复注册同一个文件 */
const registered = new Map<string, FontFace>();

async function register(family: string, choice: FontChoice | null) {
  if (!choice?.path) return;
  const key = `${family}|${choice.path}`;
  if (registered.has(key)) return;

  const url = fileUrl(choice.path);
  if (!url) return;

  try {
    const face = new FontFace(family, `url("${url}")`);
    await face.load();
    document.fonts.add(face);
    registered.set(key, face);
  } catch (e) {
    // 不是字体文件、路径失效、CSP 不允许 —— 都退化成系统字体，只记日志
    logWarn(`自定义字体加载失败：${choice.name}（${String(e)}）`);
  }
}

/** 按当前偏好注册自定义字体。重复调用是幂等的 */
export function ensureCustomFonts(prefs: {
  readerFontCjk: FontChoice | null;
  readerFontLatin: FontChoice | null;
}): void {
  void register(CUSTOM_FONT_FAMILY.latin, prefs.readerFontLatin);
  void register(CUSTOM_FONT_FAMILY.cjk, prefs.readerFontCjk);
}

/** 从文件路径里取一个像名字的东西：`SourceHanSerifSC-Regular.otf` → `SourceHanSerifSC-Regular` */
export function fontNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "") || "自定义字体";
}
