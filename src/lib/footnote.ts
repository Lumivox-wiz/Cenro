/**
 * 脚注识别与取文。
 *
 * EPUB 里「脚注」没有统一写法：有的用 `epub:type="noteref"`，有的只给个
 * `<a href="#fn1">1</a>`，注释本体可能在章末的 `<aside>`、也可能藏在
 * `<section class="footnotes">` 里。所以这里不追求严格语义，只做一件事：
 * **判断这个链接像不像脚注引用**，像就把目标那段文字弹出来，不像就照旧跳转。
 *
 * 判断错也不会有严重后果：真跳转的目标仍然能跳（用户多按一下而已），
 * 而弹窗只是把「跳走再跳回来」这一步省掉。
 */

/** 目标内容超过这个长度就不当脚注——多半是「第 3 章」这种章节内跳转 */
const MAX_FOOTNOTE_CHARS = 1200;

export interface FootnoteTarget {
  /** 去掉了首尾空白与回跳标记的正文 */
  text: string;
  /** 目标元素，跳转时还要用 */
  element: HTMLElement;
}

/** 在正文容器里按 id 找锚点（包含 `name`，老排版常用 `<a name>`） */
export function findAnchor(root: Element | null, id: string): HTMLElement | null {
  if (!root || !id) return null;
  const byId = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
  if (byId) return byId;
  return root.querySelector<HTMLElement>(`a[name="${CSS.escape(id)}"]`);
}

/**
 * 这个链接是不是脚注引用。
 *
 * 三条线索任一成立即可：
 * 1. 语义属性（`epub:type` / `role`）写了 note；
 * 2. 目标元素的 id / class 里有 fn / note / footnote；
 * 3. 链接文字是纯编号（`1`、`[2]`、`①`、`iv`）——这是最常见的写法。
 */
export function looksLikeFootnote(link: HTMLAnchorElement, target: HTMLElement): boolean {
  const type = (
    target.getAttribute("epub:type") ??
    link.getAttribute("epub:type") ??
    target.getAttribute("role") ??
    ""
  ).toLowerCase();
  if (/footnote|endnote|noteref|doc-noteref|annotation/.test(type)) return true;

  const id = (target.id || target.getAttribute("name") || "").toLowerCase();
  const cls = typeof target.className === "string" ? target.className.toLowerCase() : "";
  if (/(^|[-_ ])(fn|note|footnote|endnote)([-_ ]|$)/.test(id)) return true;
  if (/footnote|endnote|(^|[-_ ])note([-_ ]|$)/.test(cls)) return true;

  const label = (link.textContent ?? "").trim();
  // 纯编号：阿拉伯数字、圈码、罗马数字，允许被括号/方括号包起来
  return /^[\[（(]?[\d①-⑳]{1,3}[\]）)]?$/.test(label) || /^\[?(i{1,3}|iv|vi{0,3}|ix|x)\]?$/i.test(label);
}

/**
 * 取出注释正文。
 *
 * 优先 `innerText`：章末注释常被 CSS 隐藏（`display:none` 等），
 * 那种情况下 `innerText` 是空的，退回 `textContent` 才拿得到字。
 * 末尾的「返回」「↩」这类回跳标记会被削掉——弹窗里它没有意义。
 */
export function readFootnote(target: HTMLElement): FootnoteTarget | null {
  const raw = (target.innerText || target.textContent || "").replace(/\s+/g, " ").trim();
  const text = raw.replace(/[\s^↩↑]*(返回|回到正文|back|return)[\s↩↑]*$/i, "").trim();
  if (!text || text.length > MAX_FOOTNOTE_CHARS) return null;
  return { text, element: target };
}
