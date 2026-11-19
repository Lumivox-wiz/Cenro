/**
 * 划词标注的坐标换算与绘制。
 *
 * 一套坐标走到底：**章节渲染后文本里的字符下标**（UTF-16 码元，
 * 与 JS `string.length`、DOM `Range` 的 offset 完全一致）。
 *
 * 为什么不直接用阅读进度那种「字节偏移 / 章内比例」：
 * 那种坐标是给「翻到大概位置」用的，粒度太粗——高亮要精确到字。
 * 也不按源文件偏移算，因为 EPUB 渲染前要清洗、改写图片地址，
 * 源坐标和屏幕上的字对不上；按「渲染出来的文本」算，画回去永远自洽。
 *
 * 代价是：章节内容变了（书被重新排版、换了译本）锚点会偏。
 * 这种情况宁可偏，也不要把划线画到别的句子上——所以 `paintMarks`
 * 会校验区间里取出来的文字与 `excerpt` 是否一致，不一致就不画。
 */

export interface Anchor {
  /** 章内起始字符下标 */
  start: number;
  /** 区间长度（码元数） */
  len: number;
}

export interface MarkSpec {
  id: string;
  anchor: Anchor;
  kind: "highlight" | "note";
  /** 原文。用于绘制前校验，避免文本改动后划错行 */
  excerpt?: string | null;
}

/** 选区快照：脱离 live selection 也能落库与定位浮条 */
export interface SelectionTarget {
  anchor: Anchor;
  text: string;
  /** 选区首行的视口矩形（不含滚动偏移） */
  rect: { left: number; top: number; right: number; bottom: number };
}

/** 容器内文本总长（码元）。用于把锚点裁到合法范围。 */
export function textLength(root: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    total += (node as Text).data.length;
  }
  return total;
}

/**
 * 把一个 DOM 位置换算成容器内字符下标。
 *
 * 用 Range 而不是自己遍历文本节点：选区端点可能落在元素节点上
 * （三击整段、拖到段落边界时就是这样），逐节点累加的写法要额外处理
 * 「元素节点 + childIndex」这一支，而 Range 天然懂。
 */
function offsetAt(root: Element, node: Node, offset: number): number | null {
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

/** 当前选区读成锚点。选区不完整落在 root 里、或只选了空白，都返回 null。 */
export function readSelection(root: Element): SelectionTarget | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const start = offsetAt(root, range.startContainer, range.startOffset);
  const end = offsetAt(root, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;

  const raw = range.toString();
  // 首尾空白不算「选中了文字」：手指拖过行尾很容易带上换行
  const text = raw.trim();
  if (!text) return null;
  const lead = raw.length - raw.trimStart().length;

  const rects = range.getClientRects();
  const first = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  return {
    anchor: { start: start + lead, len: text.length },
    text,
    rect: {
      left: first.left,
      top: first.top,
      right: first.right,
      bottom: first.bottom,
    },
  };
}

/** 清掉所有高亮节点，把文本节点重新接回去（`normalize` 合并回整段） */
export function clearMarks(root: Element) {
  const marks = root.querySelectorAll("mark[data-hl]");
  if (marks.length === 0) return;
  marks.forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  });
  root.normalize();
}

interface TextSpan {
  node: Text;
  start: number;
}

/** 把 root 里的文本节点逐个记下起始下标（一次遍历，之后偏移不再重算） */
function collectText(root: Element): TextSpan[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextSpan[] = [];
  let acc = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    spans.push({ node: text, start: acc });
    acc += text.data.length;
  }
  return spans;
}

/** 用 `<mark>` 包住一段，从后往前切，避免前面的偏移失效 */
function wrap(node: Text, from: number, to: number, mark: HTMLElement) {
  const target = from > 0 ? node.splitText(from) : node;
  const len = to - from;
  if (len < target.data.length) target.splitText(len);
  target.parentNode?.insertBefore(mark, target);
  mark.appendChild(target);
}

/**
 * 把一段区间按段落切开。
 *
 * 为什么要切：`white-space: pre-wrap` 下，段落结尾那个换行符如果被包进
 * `<mark>`，浏览器会把荧光带一直画到行尾空白处——每段最后一行都拖一条尾巴，
 * 看着像排版坏了。开头的全角缩进同理，会拖出一条两字宽的孤立色块。
 * 所以按 `\n` 分段、再把段首尾空白削掉，只给真正的文字上色。
 */
function segments(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = from;
  while (cursor < to) {
    const nl = text.indexOf("\n", cursor);
    const end = nl === -1 || nl >= to ? to : nl;
    let a = cursor;
    let b = end;
    while (a < b && /\s/.test(text[a])) a += 1;
    while (b > a && /\s/.test(text[b - 1])) b -= 1;
    if (b > a) out.push([a, b]);
    if (nl === -1 || nl >= to) break;
    cursor = nl + 1;
  }
  return out;
}

/**
 * 按锚点画高亮。返回真正画上去的 id 集合——
 * 文本对不上的（书变了、锚点越界）不画，调用方可以据此提示。
 *
 * 每次都先清再画：重复调用是幂等的，不需要调用方记状态。
 */
export function paintMarks(root: Element, marks: MarkSpec[]): Set<string> {
  clearMarks(root);
  const painted = new Set<string>();
  if (marks.length === 0) return painted;

  const spans = collectText(root);
  const full = spans.map((s) => s.node.data).join("");
  const total = full.length;

  interface Job {
    id: string;
    kind: "highlight" | "note";
    from: number;
    to: number;
  }
  const jobs: Job[] = [];

  for (const spec of marks) {
    const from = Math.max(0, spec.anchor.start);
    const to = Math.min(total, spec.anchor.start + spec.anchor.len);
    if (to <= from) continue;

    // 原文校验：取出来的字对不上就不画，免得在别的句子上划线
    if (spec.excerpt && spec.excerpt.trim()) {
      if (normalizeSpace(full.slice(from, to)) !== normalizeSpace(spec.excerpt)) continue;
    }
    for (const [a, b] of segments(full, from, to)) {
      jobs.push({ id: spec.id, kind: spec.kind, from: a, to: b });
    }
    painted.add(spec.id);
  }

  // 从后往前：先画靠后的区间，切线不会影响前面还没画的偏移
  jobs.sort((a, b) => b.from - a.from);
  for (const job of jobs) {
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      const spanEnd = span.start + span.node.data.length;
      const lo = Math.max(job.from, span.start) - span.start;
      const hi = Math.min(job.to, spanEnd) - span.start;
      if (hi <= lo) continue;

      const mark = document.createElement("mark");
      mark.className = job.kind === "note" ? "hl hl-note" : "hl";
      mark.dataset.hl = job.id;
      wrap(span.node, lo, hi, mark);
    }
  }
  return painted;
}

/** 空白差异不该导致校验失败：换行、缩进在 HTML 里本来就会被折叠 */
function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 找一个标注画出来的 mark 元素（跳转时用来定位） */
export function findMark(root: Element | null, id: string): HTMLElement | null {
  if (!root) return null;
  return root.querySelector<HTMLElement>(`mark[data-hl="${CSS.escape(id)}"]`);
}

/**
 * mark 落在第几列（分页模式）。
 * 列容器的 transform 会同时平移 mark 与容器，相减正好抵消。
 */
export function columnOf(mark: HTMLElement, columns: HTMLElement, columnWidth: number, gap: number) {
  const offset = mark.getBoundingClientRect().left - columns.getBoundingClientRect().left;
  if (columnWidth + gap <= 0) return 0;
  return Math.max(0, Math.round(offset / (columnWidth + gap)));
}

/** 页面或窗口尺寸变化时，正在显示的浮条就没意义了，交给调用方收起 */
export function watchRectChange(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  window.addEventListener("scroll", onChange, true);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("scroll", onChange, true);
  };
}
