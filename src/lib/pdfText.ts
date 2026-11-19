/**
 * PDF 文字层搜索。
 *
 * 和文字类书籍不同，PDF 的「正文」不是一个字符串，而是每页若干文本片段
 * （`getTextContent().items`），顺序由内容流决定。这里做两件事：
 *
 * 1. **拼**：按 items 顺序拼回一页的连续文字（`hasEOL` 补换行），
 *    再把所有空白压成单个空格——PDF 里一行常被拆成十几个 item，
 *    不压缩的话「关键词」很容易被换行切开。
 * 2. **找**：在压缩后的字符串里找子串，取前后各 `CONTEXT` 个字符做上下文。
 *
 * 命中区间的下标一律相对**压缩后**的字符串，和 UI 里显示的 excerpt 完全对齐，
 * 这样加粗关键词不用再算第二套坐标。
 *
 * 扫描件（图片型 PDF）没有文本片段，`extractFlatText` 会返回空串，
 * 调用方据此提示「这份 PDF 没有文字层」，而不是回一个空结果让人以为搜错了词。
 */

/** 命中上下文：前后各留这么多字符，够看清是哪一句 */
const CONTEXT = 36;

/** 一条命中在**页内**的形态；页码与 locator 由调用方补 */
export interface PageHit {
  /** 页内压缩文本里的起始下标 */
  matchStart: number;
  /** 结束下标（不含） */
  matchEnd: number;
  excerpt: string;
}

export interface PageText {
  /** 空白压缩后的整页文字 */
  flat: string;
  /** 有没有文字层。扫描件为 false */
  hasText: boolean;
}

interface RawItem {
  str?: string;
  hasEOL?: boolean;
}

/** 把 pdf.js 的 items 拼成一页的连续文字 */
export function extractFlatText(items: ArrayLike<RawItem>): PageText {
  let raw = "";
  let chars = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const str = item.str;
    if (typeof str !== "string" || str.length === 0) continue;
    raw += str;
    chars += str.length;
    if (item.hasEOL) raw += "\n";
  }

  if (chars === 0) return { flat: "", hasText: false };
  // 空白压缩：PDF 的换行、制表、多空格都只是排版残留，对搜索没有意义
  return { flat: raw.replace(/\s+/g, " ").trim(), hasText: true };
}

/**
 * 在一页里找出所有命中。
 *
 * 匹配是在**去掉所有空白**的副本上做的，原因很实际：PDF 的文本片段是排版产物，
 * 同一句话在不同页可能写成「低碳材料」也可能写成「低 碳材料」——
 * 中文 PDF 尤其常见，字与字之间被位置信息拆开、又补了空格。
 * 直接在带空格的串上找，短语短一点就漏。
 *
 * 命中后把下标映射回带空格的原文，这样摘出来的上下文仍然是正常句子，
 * 而高亮区间（`matchStart` / `matchEnd`）也落在摘出来的这段文字上。
 */
export function findInPage(flat: string, query: string): PageHit[] {
  const q = query.replace(/\s+/g, "");
  if (!flat || !q) return [];

  /*
   * compact：去掉空白、全角转半角、转小写；map：compact 的每个字符对应 flat 的哪个下标。
   * 全角这一步不是洁癖——中文 PDF 里的数字与英文经常是全角（「２０１６」「Ｉ」），
   * 不归一化的话用户按平常的写法搜「2016」永远搜不到。
   */
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < flat.length; i += 1) {
    const ch = flat[i];
    if (/\s/.test(ch)) continue;
    for (const part of ch.normalize("NFKC").toLowerCase()) {
      chars.push(part);
      map.push(i);
    }
  }
  const compact = chars.join("");

  const needle = q.normalize("NFKC").toLowerCase();
  const hits: PageHit[] = [];
  let from = 0;

  while (from <= compact.length - needle.length) {
    const index = compact.indexOf(needle, from);
    if (index < 0) break;

    const flatFrom = map[index];
    const flatTo = map[index + needle.length - 1] + 1;
    const start = Math.max(0, flatFrom - CONTEXT);
    const end = Math.min(flat.length, flatTo + CONTEXT);
    hits.push({
      matchStart: flatFrom - start,
      matchEnd: flatTo - start,
      excerpt: flat.slice(start, end),
    });

    // 从命中处往后跳一个词长：同一个词连写时不至于刷出几十条
    from = index + Math.max(1, needle.length);
  }
  return hits;
}
