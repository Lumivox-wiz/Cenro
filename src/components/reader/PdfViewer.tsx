import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Annotation, Anchor, SearchHit } from "../../api";
import {
  ArrowLeft,
  Bookmark,
  Columns2,
  FileText,
  HelpCircle,
  List,
  RotateCw,
  Rows3,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { annotationApi, errorText, fileUrl } from "../../api";
import type { Book, Progress, SpreadMode } from "../../types";
import ReaderExtras, { type ExtrasTab } from "./ReaderExtras";
import { extractFlatText, findInPage, type PageText } from "../../lib/pdfText";
import type { SpreadModePref } from "../../lib/prefs";
import { focusChromeBand } from "../../lib/a11y";
import { useAnnounce } from "../../lib/useAnnounce";
import { useFocusTrap } from "../../lib/useFocusTrap";
import PdfPage, { type PageHighlight } from "./PdfPage";
import SelectionActions from "./SelectionActions";
import { logError } from "../../lib/log";
import type { SelectionTarget } from "../../lib/highlight";
import ShortcutHelp, { type HelpSection } from "./ShortcutHelp";

type PdfjsModule = typeof import("pdfjs-dist");

/**
 * PDF 的选区怎么变成锚点。
 *
 * 文本类格式用的是「章内第几个字到第几个字」，PDF 没有这层偏移：
 * pdf.js 的文本层是绝对定位的 span，字符顺序与视觉顺序不一定一致。
 * 所以这里存**哪一页 + 若干归一化矩形**：矩形按页面尺寸折算到 0–1，
 * 换缩放、换窗口宽度、切单双页都不需要重算，也不会画偏。
 *
 * 跨页选择只取**起点所在页**的矩形：一条标注挂两页会让「跳转」「导出」
 * 都变得没法解释，不如把跨页这件事交给用户自己分两次选。
 */
function readPdfSelection(root: HTMLElement): SelectionTarget | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;

  const startNode = range.startContainer;
  const startEl =
    startNode.nodeType === Node.ELEMENT_NODE
      ? (startNode as Element)
      : startNode.parentElement;
  const pageEl = startEl?.closest<HTMLElement>(".pdf-page");
  if (!pageEl) return null;

  const pageIndex = Number(pageEl.dataset.page);
  if (!Number.isFinite(pageIndex)) return null;

  const box = pageEl.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const rects: [number, number, number, number][] = [];
  let first: DOMRect | null = null;

  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 1 || r.height < 1) continue;
    // 只要落在这页里的；跨页的其余部分丢掉
    if (r.bottom < box.top - 2 || r.top > box.bottom + 2) continue;
    if (!first) first = r;
    rects.push([
      clamp01((r.left - box.left) / box.width),
      clamp01((r.top - box.top) / box.height),
      clamp01((r.right - box.left) / box.width),
      clamp01((r.bottom - box.top) / box.height),
    ]);
  }
  if (!first || rects.length === 0) return null;

  return {
    anchor: { start: 0, len: 0, page: pageIndex, rects },
    text: text.slice(0, 300),
    rect: { left: first.left, top: first.top, right: first.right, bottom: first.bottom },
  };
}

/*
 * pdf.js 的运行时资源，缺任何一样都表现为「整页空白」：
 *
 * - `cmaps`：中文 PDF 多数字体是 CID 编码，没有 CMap 就无法映射成 Unicode，文字整段消失；
 * - `standard_fonts`：PDF 没内嵌字体时退回的 14 种标准字体；
 * - `wasm`：JBIG2 / JPEG2000 解码器 —— 扫描件几乎都用 JBIG2，缺了整页只剩白底。
 *
 * 文件在 `public/pdfjs/`，由 `scripts/copy-pdfjs-assets.mjs` 在构建前同步（prebuild）。
 * 这解释了为什么「页数读得到、文字有 900 多项，但屏幕上什么都没有」。
 */
const PDFJS_ASSET_ROOT = `${import.meta.env.BASE_URL}pdfjs/`;

const PDFJS_DOC_PARAMS = {
  cMapUrl: `${PDFJS_ASSET_ROOT}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSET_ROOT}standard_fonts/`,
  wasmUrl: `${PDFJS_ASSET_ROOT}wasm/`,
} as const;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * 按需加载 pdf.js。
 *
 * 静态 import 会把 pdf.js 塞进入口 chunk，而它在**模块顶层**就执行
 * `typeof Iterator.prototype.join !== "function" && (...)`——
 * `Iterator` 是 Chrome 122+ 才有的全局，在停在 WebView2 109 的机器上直接抛
 * ReferenceError，整个前端一行都跑不起来（表现就是整窗纯黑）。
 *
 * 改成首次打开 PDF 时才加载：PDF 打不开是一件事，应用打不开是另一件事。
 */
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return pdfjsPromise;
}

const PDF_HELP: HelpSection[] = [
  {
    title: "工具栏",
    kind: "buttons",
    rows: [
      { label: "返回书架", hint: "顶栏 ←" },
      { label: "目录", hint: "顶栏列表图标（有书签的 PDF）" },
      { label: "操作提示", hint: "顶栏 ?" },
      { label: "缩放 / 适合宽度", hint: "底栏 － 宽 ＋" },
      { label: "旋转页面", hint: "底栏 ↻" },
      { label: "分页 / 滚动", hint: "底栏两格" },
      { label: "单页 / 双列", hint: "底栏两格或 D" },
    ],
  },
  {
    title: "键盘",
    kind: "keys",
    rows: [
      { label: "上一页 / 下一页", hint: "← / →" },
      { label: "翻页", hint: "Space / J / K" },
      { label: "单页 / 双列切换", hint: "D" },
      { label: "缩放", hint: "+ / -" },
      { label: "适合宽度", hint: "0" },
      { label: "打开目录", hint: "T" },
      { label: "顶栏 / 底栏切换聚焦", hint: "F6" },
      { label: "返回书架", hint: "Esc" },
    ],
  },
];

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

type PdfModePref = "auto" | "paged" | "scroll";

interface Props {
  book: Book;
  onExit: () => void;
  onProgress: (progress: Progress) => void;
  /** 单双页偏好（auto 按窗口宽自动判断） */
  spreadPref: SpreadModePref;
  onSpreadPref: (value: SpreadModePref) => void;
  /** 翻页 / 连续滚动。auto 时按缩放自动切换（UI §6.5） */
  modePref: PdfModePref;
  onModePref: (value: PdfModePref) => void;
}

type Mode = "paged" | "scroll";

interface OutlineEntry {
  title: string;
  /** 1 基页码；0 表示无法解析目标 */
  page: number;
  depth: number;
}

/** 把 pdf.js 的嵌套 outline 摊平成带层级的线性列表 */
async function loadOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const outline = await doc.getOutline();
  if (!outline) return [];

  const entries: OutlineEntry[] = [];

  const walk = async (nodes: typeof outline, depth: number) => {
    for (const node of nodes) {
      let page = 0;
      try {
        const dest =
          typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (ref) {
          page = (await doc.getPageIndex(ref)) + 1;
        }
      } catch {
        /* 目标解析失败就保留条目但不可跳转 */
      }
      entries.push({ title: node.title, page, depth });
      if (node.items?.length) await walk(node.items, depth + 1);
    }
  };

  await walk(outline, 0);
  return entries;
}

export default function PdfViewer({
  book,
  onExit,
  onProgress,
  spreadPref,
  onSpreadPref,
  modePref,
  onModePref,
}: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  /*
   * 每页提取过的文字。全本扫一遍挺贵（几百页要十几秒），
   * 而读者往往会连续换几个词搜，缓存让第二次起几乎是瞬时的。
   * 换书时清空——页码对不上就是错的缓存。
   */
  const pageText = useRef<Map<number, PageText>>(new Map());
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  // auto 模式下由缩放推导出的模式；用户锁定后直接使用 prefs 里的值
  const [autoMode, setAutoMode] = useState<Mode>("paged");
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [baseSize, setBaseSize] = useState({ w: 0, h: 0 });
  const [stageWidth, setStageWidth] = useState(0);
  // 单双页阈值按「窗口宽度」判断；stageWidth 只用于算适合宽度
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  /** 书签面板；PDF 没有文字层，搜索不可用 */
  const [extras, setExtras] = useState<ExtrasTab | null>(null);
  const [tocQuery, setTocQuery] = useState("");
  // 目录抽屉焦点陷阱（UX §8.1）
  const tocTrap = useFocusTrap(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // 打开文档
  useEffect(() => {
    let cancelled = false;
    const url = fileUrl(book.path);
    if (!url) {
      setError("无法生成文件地址");
      return;
    }

    // pdf.js 是懒加载的：先把它取回来，再走原来的打开流程
    pageText.current.clear();
    let task: ReturnType<PdfjsModule["getDocument"]> | null = null;

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;

        task = pdfjs.getDocument({ url, ...PDFJS_DOC_PARAMS });
        const next = await task.promise;
        if (cancelled) return;

        setDoc(next);
        setPageCount(next.numPages);

        const first = await next.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        setBaseSize({ w: viewport.width, h: viewport.height });

        const saved = book.progress;
        if (saved && saved.kind === "paged") {
          setPage(Math.min(next.numPages, Math.max(1, saved.page + 1)));
          // 单双页由 prefs 决定，进度里的 spread 不再反向覆盖用户设置
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // 仅换书时重开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // 加载 PDF 书签树
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    loadOutline(doc)
      .then((entries) => {
        if (!cancelled) setOutline(entries);
      })
      .catch(() => {
        /* 没有 outline 或解析失败：静默，不显示目录入口 */
      });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 舞台宽度 → 适合宽度
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    /*
     * clientWidth 包含 padding，而 padding 桌面 48px、手机 24px（还要改成 8px）。
     * 直接用 clientWidth 再减一个写死的 96，手机上会多扣一倍，页面只剩 75% 屏宽。
     * 这里把真实左右内边距量出来减掉，`available` 就不再需要硬编码常量。
     */
    const measure = () => {
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      setStageWidth(Math.max(0, el.clientWidth - padX));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /*
   * UI §6.3 自动阈值：≥1440 默认双页，<1440 单页；<1200 即使手动选了双页
   * 也回落单列（两列各不到 500px，正文无法辨认）。用户选择本身保留，
   * 窗口变宽后自动恢复。
   */
  const wantedSpread: "single" | "double" =
    spreadPref === "auto"
      ? viewportWidth >= 1440
        ? "double"
        : "single"
      : spreadPref;
  const doubleBlocked =
    wantedSpread === "double" && viewportWidth > 0 && viewportWidth < 1200;
  const spread: "single" | "double" =
    wantedSpread === "double" && !doubleBlocked ? "double" : "single";
  const columnsPerView = spread === "double" ? 2 : 1;

  const baseWidth = rotation % 180 === 0 ? baseSize.w : baseSize.h;
  // stageWidth 已经是内容宽（measure 里减过 padding），这里只留双页之间的列距
  const available =
    stageWidth > 0
      ? Math.max(200, stageWidth - (columnsPerView > 1 ? 16 : 0)) / columnsPerView
      : 0;
  const fitScale = baseWidth > 0 && available > 0 ? available / baseWidth : 0;
  const scale = fitWidth && fitScale > 0 ? fitScale : zoom;

  /*
   * UI §6.5：缩放 >110% 切连续滚动，<95% 切回翻页。
   * 10% / 5% 的缓冲是为避免在 100% 附近来回跳变；用户手动锁定后不再自动切换。
   */
  const relZoom = !fitWidth && fitScale > 0 ? zoom / fitScale : 1;

  useEffect(() => {
    if (modePref !== "auto" || fitScale <= 0) return;
    setAutoMode((prev) => {
      if (prev === "paged" && relZoom > 1.1) return "scroll";
      if (prev === "scroll" && relZoom < 0.95) return "paged";
      return prev;
    });
  }, [relZoom, fitScale, modePref]);

  const mode: Mode = modePref === "auto" ? autoMode : modePref;

  /** 当前位置：与保存进度同构（page 存 0 基，界面用 1 基） */
  /**
   * 在文字层里搜。
   *
   * PDF 的正文只在 pdf.js 里，后端那份文件是二进制的，所以这活儿由阅读器自己干：
   * 逐页取 `getTextContent()`、拼接、压缩空白、找子串。
   * 扫描件没有文字片段，结果自然为空——调用方用 `searchEmptyHint` 解释这一点。
   */
  const searchPdf = useCallback(
    async (
      query: string,
      report: (done: number, total: number) => void,
    ): Promise<SearchHit[]> => {
      if (!doc) return [];
      const q = query.trim();
      if (!q) return [];

      const limit = 200;
      const hits: SearchHit[] = [];
      const total = doc.numPages;
      // 与「保存进度」同一套坐标，跳转因此不需要额外处理
      const spreadMode: SpreadMode =
        mode === "scroll" ? "single" : spread === "double" ? "double" : "single";

      for (let n = 1; n <= total; n += 1) {
        let text = pageText.current.get(n);
        if (!text) {
          const pdfPage = await doc.getPage(n);
          const content = await pdfPage.getTextContent();
          text = extractFlatText(content.items as unknown as Array<{ str?: string; hasEOL?: boolean }>);
          pageText.current.set(n, text);
        }

        for (const hit of findInPage(text.flat, q)) {
          hits.push({
            chapter: n - 1,
            chapter_title: `第 ${n} 页`,
            locator: {
              kind: "paged",
              page: n - 1,
              total,
              zoom: fitWidth ? 1 : zoom,
              spread: spreadMode,
            },
            excerpt: hit.excerpt,
            match_start: hit.matchStart,
            match_end: hit.matchEnd,
          });
          if (hits.length >= limit) break;
        }

        report(n, total);
        if (hits.length >= limit) break;
      }
      return hits;
    },
    [doc, fitWidth, mode, spread, zoom],
  );

  const [marks, setMarks] = useState<Annotation[]>([]);
  const [markBusy, setMarkBusy] = useState(false);
  const [markNotice, setMarkNotice] = useState<string | null>(null);

  const loadMarks = useCallback(async () => {
    try {
      setMarks(await annotationApi.list(book.id));
    } catch (e) {
      logError(`读取 PDF 标注失败：${errorText(e)}`);
    }
  }, [book.id]);

  useEffect(() => {
    void loadMarks();
  }, [loadMarks]);

  /** 这一页上要画的标注；没有就返回 undefined，免得每页都建一个空数组 */
  const highlightsFor = useCallback(
    (pageIndex: number): PageHighlight[] | undefined => {
      const list: PageHighlight[] = [];
      for (const item of marks) {
        if (item.kind === "bookmark") continue;
        const rects = item.anchor?.rects;
        if (!rects || item.anchor?.page !== pageIndex) continue;
        list.push({ id: item.id, kind: item.kind, rects });
      }
      return list.length > 0 ? list : undefined;
    },
    [marks],
  );

  const createMark = useCallback(
    async (kind: "highlight" | "note", target: SelectionTarget, note: string | null) => {
      const anchor: Anchor = target.anchor;
      const pageIndex = anchor.page ?? Math.max(0, page - 1);
      setMarkBusy(true);
      try {
        await annotationApi.add(
          book.id,
          kind,
          { kind: "paged", page: pageIndex, total: pageCount, zoom: fitWidth ? 1 : zoom, spread },
          { label: note, excerpt: target.text, anchor },
        );
        await loadMarks();
        setMarkNotice(kind === "note" ? "笔记已保存" : "已划线");
        window.setTimeout(() => setMarkNotice(null), 2400);
      } catch (e) {
        setMarkNotice(errorText(e));
      } finally {
        setMarkBusy(false);
      }
    },
    [book.id, fitWidth, loadMarks, page, pageCount, spread, zoom],
  );

  const currentLocator = useCallback(
    () => ({
      kind: "paged" as const,
      page: Math.max(0, page - 1),
      total: pageCount,
      zoom: fitWidth ? 1 : zoom,
      spread,
    }),
    [fitWidth, page, pageCount, spread, zoom],
  );

  const currentLabel = useCallback(() => {
    const pct = pageCount > 0 ? Math.round((page / pageCount) * 100) : 0;
    return `第 ${page} 页 / 共 ${pageCount} 页 · ${pct}%`;
  }, [page, pageCount]);

  const jumpToLocator = useCallback(
    (locator: Progress) => {
      if (locator.kind !== "paged") return;
      setPage(Math.min(Math.max(1, locator.page + 1), Math.max(1, pageCount)));
    },
    [pageCount],
  );

  const go = useCallback(
    (delta: number) => {
      if (mode === "scroll") {
        scrollRef.current?.scrollBy({
          top: window.innerHeight * 0.85 * delta,
          behavior: "smooth",
        });
        return;
      }
      setPage((current) => {
        const next = current + delta * columnsPerView;
        return Math.min(pageCount || 1, Math.max(1, next));
      });
    },
    [mode, columnsPerView, pageCount],
  );

  const zoomBy = (dir: 1 | -1) => {
    const current = fitWidth ? 1 : zoom;
    const index = ZOOM_STEPS.findIndex((z) => z >= current - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + dir))] ?? 1;
    setFitWidth(false);
    setZoom(next);
  };

  const rotate = () => setRotation((r) => (r + 90) % 360);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F6 先于输入框判断：焦点在进度条上时也要能切回顶栏
      if (e.key === "F6") {
        e.preventDefault();
        focusChromeBand(e.shiftKey);
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.isContentEditable)) return;

      // Ctrl/Cmd + B 返回书架：与文本 / EPUB / HTML 阅读器同一套键位
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        onExit();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case "ArrowLeft":
        case "k":
        case "K":
          e.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
        case "j":
        case "J":
        case " ":
          e.preventDefault();
          if (e.key === " " && e.shiftKey) go(-1);
          else go(1);
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomBy(1);
          break;
        case "-":
          e.preventDefault();
          zoomBy(-1);
          break;
        case "0":
          e.preventDefault();
          setFitWidth(true);
          break;
        case "d":
        case "D": {
          e.preventDefault();
          onSpreadPref(spread === "double" ? "single" : "double");
          break;
        }
        case "t":
        case "T":
          e.preventDefault();
          if (outline.length > 0) setTocOpen((v) => !v);
          break;
        case "Escape":
          e.preventDefault();
          if (helpOpen) setHelpOpen(false);
          else if (tocOpen) setTocOpen(false);
          else onExit();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // zoomBy 读取 zoom/fitWidth，需要随它们重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, onExit, helpOpen, tocOpen, outline.length, zoom, fitWidth, spread, onSpreadPref]);

  // 进度落库
  useEffect(() => {
    if (pageCount === 0) return;
    const timer = window.setTimeout(() => {
      const spreadMode: SpreadMode =
        mode === "scroll" ? "single" : spread === "double" ? "double" : "single";
      onProgress({
        kind: "paged",
        page: Math.max(0, page - 1),
        total: pageCount,
        zoom: fitWidth ? 1 : zoom,
        spread: spreadMode,
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [page, pageCount, zoom, fitWidth, mode, spread, onProgress]);

  /** 连续滚动时回填页码：只向前推进，避免初始批量可见导致页码乱跳 */
  const handleVisible = useCallback((index: number) => {
    setPage((current) => (index + 1 > current ? index + 1 : current));
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const ratio = el.scrollTop / max;
    setPage(Math.min(pageCount, Math.max(1, Math.round(ratio * (pageCount - 1)) + 1)));
  }, [pageCount]);

  const jumpToPage = useCallback(
    (target: number) => {
      setPage(target);
      if (mode === "scroll") {
        // 双列滚动时按行对齐，跳到该页所在行的起始页
        const rowStart = Math.floor((target - 1) / columnsPerView) * columnsPerView;
        const el = scrollRef.current?.querySelector(`[data-pdf-page="${rowStart}"]`);
        el?.scrollIntoView({ block: "start" });
      }
    },
    [mode, columnsPerView],
  );

  const filteredOutline = useMemo(() => {
    const q = tocQuery.trim().toLowerCase();
    if (!q) return outline;
    return outline.filter((entry) => entry.title.toLowerCase().includes(q));
  }, [outline, tocQuery]);

  const percent = pageCount > 1 ? ((page - 1) / (pageCount - 1)) * 100 : 0;

  // 屏幕阅读器播报（UX §7.3）：翻页报页码，连续滚动报百分比
  const announce = useAnnounce(
    pageCount === 0
      ? ""
      : mode === "scroll"
        ? `已读 ${Math.round(percent)}%`
        : `第 ${page} 页，共 ${pageCount} 页`,
    pageCount > 0,
  );

  const pagesInView =
    mode === "paged" && doc
      ? (spread === "double" ? [page, page + 1] : [page]).filter((p) => p <= pageCount)
      : [];

  return (
    <div className="reader-shell" data-reader-theme="light">
      {/* 屏幕阅读器播报位：视觉隐藏，不占布局 */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      <div className="reader-topbar" data-hidden={false}>
        <button className="reader-toolbar-btn" onClick={onExit} aria-label="返回书架">
          <ArrowLeft size={20} strokeWidth={2} />
        </button>
        <span className="reader-book-title">{book.title}</span>
        <div className="reader-spacer" />
        {outline.length > 0 && (
          <button
            className="reader-toolbar-btn"
            onClick={() => setTocOpen((v) => !v)}
            aria-label="目录"
            title="目录（T）"
          >
            <List size={20} strokeWidth={2} />
          </button>
        )}
        <button
          className="reader-toolbar-btn"
          onClick={() => setExtras("annotation")}
          aria-label="标注"
          title="书签与标注"
        >
          <Bookmark size={20} strokeWidth={2} />
        </button>

        <button
          className="reader-toolbar-btn"
          onClick={() => setExtras("search")}
          aria-label="书内搜索"
          title="在文字层里搜索"
        >
          <Search size={20} strokeWidth={2} />
        </button>

        <button
          className="reader-toolbar-btn"
          onClick={() => setHelpOpen(true)}
          aria-label="操作提示"
          title="操作提示"
        >
          <HelpCircle size={20} strokeWidth={2} />
        </button>
      </div>

      <div className="reader-stage pdf-stage" ref={stageRef}>
        {error ? (
          <div className="reader-notice">
            <div className="reader-notice-title">PDF 打开失败</div>
            <div>{error}</div>
            <button className="btn btn-secondary" onClick={onExit}>
              返回书架
            </button>
          </div>
        ) : !doc ? (
          <div className="reader-notice">
            <div>正在载入…</div>
          </div>
        ) : mode === "paged" ? (
          <>
            <div className="pdf-pages" data-spread={spread}>
              {pagesInView.map((p) => (
                <PdfPage
                  key={`${p}-${rotation}-${scale.toFixed(3)}`}
                  doc={doc}
                  index={p - 1}
                  scale={scale}
                  rotation={rotation}
                  highlights={highlightsFor(p - 1)}
                />
              ))}
            </div>

            {/*
             * 左右点击翻页。只盖住两侧各 14%，中间留给阅读与右键菜单；
             * 滚动模式下不出现——那里点一下不该跳页。
             */}
            <div className="pdf-tap-layer">
              <button className="pdf-tap" onClick={() => go(-1)} aria-label="上一页" tabIndex={-1} />
              <button className="pdf-tap" onClick={() => go(1)} aria-label="下一页" tabIndex={-1} />
            </div>
          </>
        ) : (
          <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="pdf-scroll-inner">
              {Array.from({ length: Math.ceil(pageCount / columnsPerView) }, (_, row) => {
                const start = row * columnsPerView;
                const indexes = Array.from(
                  { length: columnsPerView },
                  (_unused, k) => start + k,
                ).filter((i) => i < pageCount);

                return (
                  <div className="pdf-page-slot" data-pdf-page={start} key={row}>
                    {indexes.map((i) => (
                      <PdfPage
                        key={i}
                        doc={doc}
                        index={i}
                        scale={scale}
                        rotation={rotation}
                        lazy
                        onVisible={handleVisible}
                        highlights={highlightsFor(i)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="reader-bottombar" data-hidden={false}>
        <div className="reader-progress">
          <input
            className="slider"
            type="range"
            min={1}
            max={pageCount || 1}
            step={1}
            value={page}
            onChange={(e) => jumpToPage(Number(e.target.value))}
            aria-label="页码"
          />
        </div>

        <div className="reader-page-indicator">
          {page} / {pageCount || "—"}
        </div>

        <div className="reader-mode-toggle" role="group" aria-label="缩放">
          <button onClick={() => zoomBy(-1)} aria-label="缩小" title="缩小（-）">
            <ZoomOut size={14} strokeWidth={2} />
          </button>
          <button onClick={() => setFitWidth(true)} aria-pressed={fitWidth} title="适合宽度（0）">
            <FileText size={14} strokeWidth={2} />
          </button>
          <button onClick={() => zoomBy(1)} aria-label="放大" title="放大（+）">
            <ZoomIn size={14} strokeWidth={2} />
          </button>
        </div>

        <button className="reader-toolbar-btn" onClick={rotate} aria-label="旋转" title="旋转 90°">
          <RotateCw size={16} strokeWidth={2} />
        </button>

        <div className="reader-mode-toggle" role="group" aria-label="阅读模式">
          <button
            aria-pressed={mode === "paged"}
            onClick={() => onModePref(mode === "paged" ? "auto" : "paged")}
            title={
              mode === "paged" && modePref !== "auto"
                ? "分页（已锁定，再点恢复自动）"
                : "分页"
            }
          >
            <Columns2 size={14} strokeWidth={2} />
          </button>
          <button
            aria-pressed={mode === "scroll"}
            onClick={() => onModePref(mode === "scroll" ? "auto" : "scroll")}
            title={
              mode === "scroll" && modePref !== "auto"
                ? "连续滚动（已锁定，再点恢复自动）"
                : "连续滚动"
            }
          >
            <Rows3 size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="reader-mode-toggle pdf-spread-group" role="group" aria-label="页数">
          <button
            aria-pressed={spread === "single"}
            onClick={() => onSpreadPref("single")}
            title="单页（D 切换）"
          >
            单
          </button>
          <button
            aria-pressed={spread === "double"}
            onClick={() => onSpreadPref("double")}
            title={
              doubleBlocked
                ? "窗口较窄，暂按单列显示（≥1200px 生效）"
                : "双页 / 双列（D 切换）"
            }
          >
            双
          </button>
        </div>

        <span className="reader-page-indicator" style={{ minWidth: 44 }}>
          {Math.round(percent)}%
        </span>
      </div>

      {tocOpen && (
        <>
          <div
            className="overlay"
            style={{ background: "transparent" }}
            onClick={() => setTocOpen(false)}
          />
          <aside className="toc glass" role="dialog" aria-modal="true" aria-label="目录" ref={tocTrap}>
            <div className="drawer-head">
              <span className="drawer-title">目录</span>
              <button
                className="icon-btn"
                onClick={() => setTocOpen(false)}
                aria-label="关闭目录"
              >
                <X size={20} strokeWidth={2} />
              </button>
            </div>

            <div className="toc-search">
              <div className="search-box" style={{ maxWidth: "100%" }}>
                <Search size={16} strokeWidth={2} aria-hidden="true" />
                <input
                  className="search-input"
                  value={tocQuery}
                  onChange={(e) => setTocQuery(e.target.value)}
                  placeholder="搜索目录"
                  spellCheck={false}
                  aria-label="搜索目录"
                />
              </div>
            </div>

            <div className="toc-list">
              {filteredOutline.map((entry) => (
                <button
                  key={`${entry.title}-${entry.page}-${entry.depth}`}
                  className="toc-item"
                  style={{ paddingLeft: `calc(var(--sp-3) + ${entry.depth * 14}px)` }}
                  disabled={entry.page === 0}
                  onClick={() => {
                    if (entry.page === 0) return;
                    jumpToPage(entry.page);
                    setTocOpen(false);
                  }}
                  title={entry.title}
                >
                  {entry.title}
                </button>
              ))}
              {filteredOutline.length === 0 && (
                <div className="field-hint" style={{ padding: "var(--sp-3)" }}>
                  没有匹配的目录项。
                </div>
              )}
            </div>
          </aside>
        </>
      )}

      <ShortcutHelp open={helpOpen} sections={PDF_HELP} onClose={() => setHelpOpen(false)} />

      {extras && (
        <ReaderExtras
          bookId={book.id}
          bookTitle={book.title}
          tab={extras}
          onTab={setExtras}
          onClose={() => setExtras(null)}
          currentLocator={currentLocator}
          currentLabel={currentLabel}
          onJump={jumpToLocator}
          searchable
          onSearch={searchPdf}
          searchEmptyHint="如果这份 PDF 是扫描件（每页是图片），就没有文字层，换个文字版才能搜。"
          orderOf={(loc) => (loc.kind === "paged" ? loc.page : null)}
          onChanged={() => void loadMarks()}
        />
      )}

      {/* 划词浮条与提示：PDF 用自己那套选区解释器，其余与文字书共用同一个组件 */}
      <SelectionActions
        getRoot={() => stageRef.current}
        enabled={!error && !!doc}
        busy={markBusy}
        resolve={readPdfSelection}
        onCreate={(kind, target, note) => void createMark(kind, target, note)}
      />

      {markNotice && (
        <p className="reader-toast" role="status">
          {markNotice}
        </p>
      )}
    </div>
  );
}
