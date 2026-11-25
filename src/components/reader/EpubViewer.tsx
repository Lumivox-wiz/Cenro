import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  Columns2,
  HelpCircle,
  List,
  Rows3,
  Search,
  Settings,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { annotationApi, epubApi, errorText, type Annotation } from "../../api";
import type { Book, EpubMeta, Progress } from "../../types";
import type { Prefs } from "../../lib/prefs";
import { sanitizeXhtml } from "../../lib/sanitize";
import { rewriteImages } from "../../lib/epubAssets";
import { resolvePageWidth } from "../../lib/pageWidth";
import { focusChromeBand } from "../../lib/a11y";
import { findAnchor, looksLikeFootnote, readFootnote } from "../../lib/footnote";
import { useAnnounce } from "../../lib/useAnnounce";
import { useFocusTrap } from "../../lib/useFocusTrap";
import ShortcutHelp, { type HelpSection } from "./ShortcutHelp";
import ReaderExtras, { type ExtrasTab } from "./ReaderExtras";
import SelectionActions from "./SelectionActions";
import FootnoteCard from "./FootnoteCard";
import {
  clearMarks,
  columnOf,
  findMark,
  paintMarks,
  textLength,
  type MarkSpec,
  type SelectionTarget,
} from "../../lib/highlight";

const PAGE_GAP = 64;

const EPUB_HELP: HelpSection[] = [
  {
    title: "工具栏",
    kind: "buttons",
    rows: [
      { label: "返回书架", hint: "顶栏 ←" },
      { label: "目录", hint: "点书名或列表图标" },
      { label: "操作提示", hint: "顶栏 ?" },
      { label: "设置", hint: "顶栏齿轮" },
      { label: "分页 / 滚动", hint: "底栏右下两格" },
      { label: "跳转进度", hint: "拖动底栏进度条" },
      { label: "脚注", hint: "点正文里的数字标记，就地弹窗" },
    ],
  },
  {
    title: "键盘",
    kind: "keys",
    rows: [
      { label: "上一页 / 下一页", hint: "← / →" },
      { label: "下一页 / 上一页", hint: "Space / Shift+Space" },
      { label: "下一页 / 上一页", hint: "J / K" },
      { label: "打开目录", hint: "T" },
      { label: "顶栏 / 底栏切换聚焦", hint: "F6" },
      { label: "返回书架", hint: "Ctrl + B" },
      { label: "关闭抽屉 / 隐藏工具栏 / 返回", hint: "Esc" },
    ],
  },
];

interface Props {
  book: Book;
  prefs: Prefs;
  onExit: () => void;
  onProgress: (progress: Progress) => void;
  onOpenSettings: () => void;
}

export default function EpubViewer({
  book,
  prefs,
  onExit,
  onProgress,
  onOpenSettings,
}: Props) {
  const [meta, setMeta] = useState<EpubMeta | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [html, setHtml] = useState("");
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // 初值不超过窗口宽，避免首帧列宽超过屏幕（Android WebView 默认尺寸布局）
  const [pageWidth, setPageWidth] = useState(() =>
    resolvePageWidth(null, prefs.readerPageWidth, prefs.readerMargin),
  );
  const [enterDir, setEnterDir] = useState<"next" | "prev">("next");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * 工具栏初始可见（v1.14）。
   *
   * 原来是 false：点进一本书，屏幕上没有返回、没有书名、没有读到哪，
   * 中间点一下能唤出工具栏，但没有任何东西提示可以点。
   */
  const [chrome, setChrome] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  /** 书签 / 搜索面板 */
  const [extras, setExtras] = useState<ExtrasTab | null>(null);
  const [tocQuery, setTocQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const [mode, setMode] = useState<"paging" | "scroll">("paging");
  const [scrollRatio, setScrollRatio] = useState(0);
  // 目录抽屉焦点陷阱（UX §8.1）
  const tocTrap = useFocusTrap(true);
  // 分页视口高度：工具栏显隐会改变正文让位，进而改变每页能放多少行
  const [viewportH, setViewportH] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageFocusRef = useRef<HTMLDivElement>(null);
  const pendingRatio = useRef<number | null>(null);
  // 上次参与分页的视口高度，用来判断这次重算是不是「高度变了」
  const layoutHRef = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;
  const hideTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  const downPoint = useRef<{ x: number; y: number; t: number } | null>(null);
  const pageWindowRef = useRef<HTMLDivElement>(null);
  const initialProgress = useRef(book.progress);
  // 正文节点：划词与划线都作用在这里
  const textRef = useRef<HTMLDivElement>(null);
  // 待精确定位的标注（翻章按比例，落哪一页要等排版完成）
  const pendingMark = useRef<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [markBusy, setMarkBusy] = useState(false);
  const [markNotice, setMarkNotice] = useState<string | null>(null);
  /** 脚注弹窗：贴在被点的引用标记旁边，不打断阅读位置 */
  const [footnote, setFootnote] = useState<{
    text: string;
    rect: { left: number; top: number; bottom: number; right: number };
  } | null>(null);
  const closeFootnote = useCallback(() => setFootnote(null), []);

  const chapters = meta?.chapters ?? [];

  // 打开
  useEffect(() => {
    let cancelled = false;
    epubApi
      .open(book.id)
      .then((next) => {
        if (cancelled) return;
        setMeta(next);

        const saved = initialProgress.current;
        if (saved && saved.kind === "epub" && next.chapters.length > 0) {
          const index = next.chapters.findIndex((c) => c.href === saved.href);
          if (index >= 0) {
            pendingRatio.current = Math.min(1, Math.max(0, saved.progression));
            setChapterIndex(index);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [book.id]);

  // 载入章节
  useEffect(() => {
    const chapter = chapters[chapterIndex];
    if (!chapter) return;

    let cancelled = false;
    setLoading(true);
    setHtml("");
    setScrollRatio(0);
    scrollRef.current?.scrollTo({ top: 0 });

    epubApi
      .chapter(book.id, chapter.href)
      .then(async (raw) => {
        if (cancelled) return;
        // 先清理标签与属性，再把 zip 内图片改写成本地 asset URL
        const { html: clean } = sanitizeXhtml(raw);
        const withAssets = await rewriteImages(clean, chapter.href, book.id);
        if (!cancelled) setHtml(withAssets);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // chapters 由 meta 派生
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, chapterIndex, book.id]);

  // 版心宽度与视口高度
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let heightTimer: number | undefined;

    const measure = () => {
      // 传容器进去：用实测宽度算，比拿窗口宽更贴近实际可用空间
      setPageWidth(resolvePageWidth(viewport, prefs.readerPageWidth, prefs.readerMargin));

      // 高度变化带 160ms 过渡，只取最后一帧，避免逐帧重排
      window.clearTimeout(heightTimer);
      if (viewport.clientHeight > 0) {
        heightTimer = window.setTimeout(() => {
          setViewportH((prev) =>
            Math.abs(prev - viewport.clientHeight) > 1 ? viewport.clientHeight : prev,
          );
        }, 120);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      window.clearTimeout(heightTimer);
      observer.disconnect();
    };
  }, [prefs.readerPageWidth]);

  // 测量页数（仅分页）
  useLayoutEffect(() => {
    if (mode !== "paging") return;
    if (!html) return;
    const el = columnsRef.current;
    if (!el) return;

    /*
     * 视口高度变了（工具栏呼出 / 收起）时页序不变、每页内容却变了，
     * 读者会被甩到别处。先记章内比例，重算页数后落回原位置。
     */
    const currentH = viewportRef.current?.clientHeight ?? 0;
    if (
      layoutHRef.current > 0 &&
      Math.abs(layoutHRef.current - currentH) > 2 &&
      pendingRatio.current == null &&
      pageCountRef.current > 1
    ) {
      pendingRatio.current = pageRef.current / (pageCountRef.current - 1);
    }
    layoutHRef.current = currentH;

    const count = Math.max(1, Math.ceil((el.scrollWidth + PAGE_GAP) / (pageWidth + PAGE_GAP)));
    setPageCount(count);

    if (pendingRatio.current != null) {
      const target = Math.min(
        count - 1,
        Math.max(0, Math.round(pendingRatio.current * (count - 1))),
      );
      pendingRatio.current = null;
      el.style.transition = "none";
      setPage(target);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.transition = "";
        });
      });
    } else {
      setPage((current) => Math.min(current, count - 1));
    }
  }, [html, mode, pageWidth, prefs.readerFontSize, prefs.readerLineHeight, viewportH]);

  /*
   * 滚动模式：工具栏呼出 / 收起改变正文让位，滚动容器位置随之变化。
   * scrollTop 是绝对像素值，容器上移多少，读者眼前的文字就会跳多少，
   * 这里按位移量反向补偿。
   */
  useLayoutEffect(() => {
    if (mode !== "scroll") return;
    const el = scrollRef.current;
    if (!el) return;

    let lastTop = el.getBoundingClientRect().top;
    const observer = new ResizeObserver(() => {
      const top = el.getBoundingClientRect().top;
      const shift = top - lastTop;
      if (Math.abs(shift) > 0.5) {
        el.scrollTop += shift;
        lastTop = top;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode, chapterIndex]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollRatio(max > 0 ? el.scrollTop / max : 0);
  }, []);

  // 滚动模式下的定位：正文就位后把 scrollTop 落到目标比例
  useLayoutEffect(() => {
    if (mode !== "scroll" || pendingRatio.current == null) return;
    if (!html) return;
    const el = scrollRef.current;
    if (!el) return;
    const ratio = pendingRatio.current;
    pendingRatio.current = null;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTo({ top: max * ratio });
    setScrollRatio(ratio);
  }, [html, mode]);

  const goChapter = useCallback(
    (index: number, ratio = 0) => {
      pendingRatio.current = ratio;
      setEnterDir(index >= chapterIndex ? "next" : "prev");
      setHtml("");
      setChapterIndex(index);
      setPage(0);
    },
    [chapterIndex],
  );

  const scrollByViewport = useCallback((delta: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      top: el.clientHeight * 0.8 * delta,
      behavior: "smooth",
    });
  }, []);

  const goNext = useCallback(() => {
    if (mode === "scroll") {
      const el = scrollRef.current;
      const atBottom = el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 8 : true;
      if (atBottom) {
        if (chapterIndex + 1 < chapters.length) goChapter(chapterIndex + 1, 0);
      } else {
        scrollByViewport(1);
      }
      return;
    }
    if (page + 1 < pageCount) {
      setPage(page + 1);
      return;
    }
    if (chapterIndex + 1 < chapters.length) goChapter(chapterIndex + 1, 0);
  }, [mode, page, pageCount, chapterIndex, chapters.length, goChapter, scrollByViewport]);

  const goPrev = useCallback(() => {
    if (mode === "scroll") {
      const el = scrollRef.current;
      const atTop = el ? el.scrollTop <= 8 : true;
      if (atTop) {
        if (chapterIndex > 0) goChapter(chapterIndex - 1, 1);
      } else {
        scrollByViewport(-1);
      }
      return;
    }
    if (page > 0) {
      setPage(page - 1);
      return;
    }
    if (chapterIndex > 0) goChapter(chapterIndex - 1, 1);
  }, [mode, page, chapterIndex, goChapter, scrollByViewport]);

  const chapterRatio =
    mode === "scroll" ? scrollRatio : pageCount > 1 ? page / (pageCount - 1) : 0;

  /** 切换模式时保留章内位置 */
  const switchMode = useCallback(
    (next: "paging" | "scroll") => {
      if (next === mode) return;
      pendingRatio.current = chapterRatio;
      setMode(next);
    },
    [mode, chapterRatio],
  );

  const percent = useMemo(() => {
    if (chapters.length === 0) return 0;
    return Math.min(
      100,
      Math.max(0, ((chapterIndex + chapterRatio) / chapters.length) * 100),
    );
  }, [chapters.length, chapterIndex, chapterRatio]);

  const jumpToPercent = useCallback(
    (target: number) => {
      if (chapters.length === 0) return;
      const position = (Math.min(100, Math.max(0, target)) / 100) * chapters.length;
      const index = Math.min(chapters.length - 1, Math.floor(position));
      const ratio = Math.min(1, Math.max(0, position - index));

      if (index === chapterIndex) {
        setPage(Math.min(pageCount - 1, Math.max(0, Math.round(ratio * (pageCount - 1)))));
        return;
      }
      goChapter(index, ratio);
    },
    [chapters.length, chapterIndex, pageCount, goChapter],
  );

  // 进度落库
  useEffect(() => {
    const chapter = chapters[chapterIndex];
    if (!chapter || !meta) return;

    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      onProgress({
        kind: "epub",
        cfi: null,
        href: chapter.href,
        progression: chapterRatio,
      });
    }, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [meta, chapters, chapterIndex, chapterRatio, onProgress]);

  /** 当前位置：与保存进度同一坐标（href + 章内比例） */
  const currentLocator = useCallback(() => {
    const chapter = chapters[chapterIndex];
    if (!chapter) return null;
    return {
      kind: "epub" as const,
      cfi: null,
      href: chapter.href,
      progression: chapterRatio,
    };
  }, [chapterIndex, chapterRatio, chapters]);

  const currentLabel = useCallback(() => {
    const title = chapters[chapterIndex]?.title?.trim();
    const percent = Math.round(((chapterIndex + chapterRatio) / Math.max(1, chapters.length)) * 100);
    return title ? `${title} · ${percent}%` : `第 ${chapterIndex + 1} 章 · ${percent}%`;
  }, [chapterIndex, chapterRatio, chapters]);

  // ---------------- 划词标注 ----------------
  // 换章或翻页后旧脚注就没有对应关系了，直接收起
  useEffect(() => {
    setFootnote(null);
  }, [chapterIndex, page]);

  const loadAnnotations = useCallback(async () => {
    try {
      setAnnotations(await annotationApi.list(book.id));
    } catch (e) {
      setMarkNotice(errorText(e));
    }
  }, [book.id]);

  useEffect(() => {
    void loadAnnotations();
  }, [loadAnnotations]);

  useEffect(() => {
    if (!markNotice) return;
    const t = window.setTimeout(() => setMarkNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [markNotice]);

  const currentHref = chapters[chapterIndex]?.href ?? "";

  /** 本章要画的区间：EPUB 的章身份是 href，不是序号 */
  const chapterMarks = useMemo<MarkSpec[]>(() => {
    const out: MarkSpec[] = [];
    if (!currentHref) return out;
    for (const item of annotations) {
      if (!item.anchor) continue;
      if (item.locator.kind !== "epub" || item.locator.href !== currentHref) continue;
      out.push({
        id: item.id,
        anchor: item.anchor,
        kind: item.kind === "note" ? "note" : "highlight",
        excerpt: item.excerpt,
      });
    }
    return out;
  }, [annotations, currentHref]);

  /*
   * 画线。EPUB 的正文是 React 用 innerHTML 塞进去的，
   * 每次换章都是整块替换，所以这里只要在提交之后重画就行，
   * 不需要像纯文本那样自己接管节点。
   */
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !html) return;
    if (chapterMarks.length === 0) {
      clearMarks(el);
      return;
    }
    paintMarks(el, chapterMarks);
  }, [html, chapterMarks]);

  const createMark = useCallback(
    async (kind: "highlight" | "note", target: SelectionTarget, note: string | null) => {
      const chapter = chapters[chapterIndex];
      const root = textRef.current;
      if (!chapter || !root) return;
      const chars = Math.max(1, textLength(root));
      const progression = Math.min(1, Math.max(0, target.anchor.start / chars));
      setMarkBusy(true);
      try {
        await annotationApi.add(
          book.id,
          kind,
          { kind: "epub", cfi: null, href: chapter.href, progression },
          { label: note, excerpt: target.text, anchor: target.anchor },
        );
        setMarkNotice(null);
        await loadAnnotations();
      } catch (e) {
        setMarkNotice(errorText(e));
      } finally {
        setMarkBusy(false);
      }
    },
    [book.id, chapterIndex, chapters, loadAnnotations],
  );

  const jumpToLocator = useCallback(
    (locator: Progress, markId?: string) => {
      if (locator.kind !== "epub") return;
      const index = chapters.findIndex((c) => c.href === locator.href);
      if (index < 0) return;
      pendingMark.current = markId ?? null;
      goChapter(index, Math.min(1, Math.max(0, locator.progression)));
    },
    [chapters, goChapter],
  );

  /** 精确落到划线所在的那一列 */
  useLayoutEffect(() => {
    const id = pendingMark.current;
    if (!id || !html) return;
    const mark = findMark(textRef.current, id);
    if (!mark) return;
    pendingMark.current = null;

    if (mode === "scroll") {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const delta = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - 32) });
      return;
    }
    const columns = columnsRef.current;
    if (!columns) return;
    setPage(Math.min(pageCount - 1, Math.max(0, columnOf(mark, columns, pageWidth, PAGE_GAP))));
  }, [chapterMarks, html, mode, pageCount, pageWidth]);

  /*
   * 首次进入「钉住」工具栏：不自动收起，等用户自己动手。
   *
   * 工具栏显隐会改正文让位（`data-chrome` → stage 的上下内边距），
   * 收起时会整页重排。若这个重排发生在用户刚开始读的第 3 秒，等于把他正在看的那一行
   * 抽走——比一开始就不给工具栏更糟。所以入场不设倒计时，
   * 用户第一次动作（点正文 / 鼠标进工具栏 / 滚轮）之后才恢复 3 秒自动隐藏。
   */
  const chromePinned = useRef(true);

  const scheduleHide = useCallback(() => {
    if (chromePinned.current) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 3000);
  }, []);

  // 屏幕阅读器播报（UX §7.3）：小说播报「第 X 章，Y%」，播报用逗号、视觉用间隔点（§4.1）
  // EPUB 的 spine 至少一项；单项时没有章节可言，降级为「位置 Y%」
  const noChapters = chapters.length <= 1;
  const positionText = noChapters
    ? `位置 ${Math.round(percent)}%`
    : `第 ${chapterIndex + 1} 章 · ${Math.round(percent)}%`;
  const announce = useAnnounce(
    !meta
      ? ""
      : noChapters
        ? `位置 ${Math.round(percent)}%`
        : `第 ${chapterIndex + 1} 章，${Math.round(percent)}%`,
    !!meta,
  );

  const reveal = useCallback(() => {
    chromePinned.current = false;
    setChrome(true);
    scheduleHide();
  }, [scheduleHide]);

  const pauseHide = useCallback(() => {
    chromePinned.current = false;
    window.clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (helpOpen) {
      window.clearTimeout(hideTimer.current);
      setChrome(true);
      return;
    }
    scheduleHide();
  }, [helpOpen, scheduleHide]);

  const handleEsc = useCallback(() => {
    if (footnote) {
      setFootnote(null);
      return;
    }
    if (extras) {
      setExtras(null);
      return;
    }
    if (helpOpen) {
      setHelpOpen(false);
      return;
    }
    if (tocOpen) {
      setTocOpen(false);
      return;
    }
    if (chrome) {
      stageFocusRef.current?.focus();
      setChrome(false);
      return;
    }
    onExit();
  }, [extras, footnote, helpOpen, tocOpen, chrome, onExit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F6 先于输入框判断：焦点在进度条上时也要能切回顶栏
      if (e.key === "F6") {
        e.preventDefault();
        setChrome(true);
        window.clearTimeout(hideTimer.current);
        focusChromeBand(e.shiftKey);
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.isContentEditable)) {
        if (e.key === "Escape") {
          e.preventDefault();
          (target as HTMLInputElement).blur();
        }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        onExit();
        return;
      }
      if (mod || e.altKey) return;

      switch (e.key) {
        case "ArrowLeft":
        case "k":
        case "K":
          e.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
        case "j":
        case "J":
        case " ":
          e.preventDefault();
          if (e.key === " " && e.shiftKey) goPrev();
          else goNext();
          break;
        case "t":
        case "T":
          e.preventDefault();
          setTocOpen((v) => !v);
          break;
        case "Escape":
          e.preventDefault();
          handleEsc();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, handleEsc, onExit]);

  /** 轻点才触发；拖动或长按视为选字，并顺手清掉残留选区 */
  const clickIfNotDrag = useCallback((e: React.MouseEvent, action: () => void) => {
    const down = downPoint.current;
    if (down) {
      if (Math.abs(e.clientX - down.x) > 8 || Math.abs(e.clientY - down.y) > 8) return;
      if (Date.now() - down.t > 250) return;
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();

    action();
  }, []);

  /** 章内锚点：滚动模式滚过去，分页模式翻到含该元素的那一页 */
  const goToAnchor = useCallback(
    (id: string) => {
      if (!id) return;
      const container = columnsRef.current ?? scrollRef.current;
      const el = container?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
      if (!el) return;
      if (mode === "scroll") {
        el.scrollIntoView({ block: "start" });
        return;
      }
      const columns = columnsRef.current;
      if (!columns) return;
      const offset = el.getBoundingClientRect().left - columns.getBoundingClientRect().left;
      const target = Math.round(offset / (pageWidth + PAGE_GAP));
      setPage(Math.min(pageCount - 1, Math.max(0, target)));
    },
    [mode, pageCount, pageWidth],
  );

  /**
   * 这个引用标记要不要弹脚注。判不出来就返回 null，交回原来的「跳过去」。
   * 只看本章内：跨文件的注释链接（`notes.xhtml#fn3`）仍按普通链接处理。
   */
  const footnoteAt = useCallback((link: HTMLAnchorElement, id: string): string | null => {
    const el = findAnchor(textRef.current, id);
    if (!el || !looksLikeFootnote(link, el)) return null;
    return readFootnote(el)?.text ?? null;
  }, []);

  /** 点击分区：链接优先，其余按左/中/右分派（三块热区会挡死链接，改在 stage 上判定） */
  const handleStageClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".reader-topbar, .reader-bottombar, .toc, .footnote-card")) return;

      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (anchor) {
        e.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (href.startsWith("#")) {
          const id = decodeURIComponent(href.slice(1));
          const note = footnoteAt(anchor, id);
          if (note) {
            const rect = anchor.getBoundingClientRect();
            setFootnote({
              text: note,
              rect: { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right },
            });
            return;
          }
          goToAnchor(id);
        } else if (/^(https?:|mailto:)/i.test(href)) {
          void openUrl(href).catch(() => {});
        }
        return;
      }

      // 正文里的按钮（错误提示的「返回书架」等）自己会处理点击，不再参与翻页分区
      if (target.closest("button, input, select, textarea")) return;

      // 点在划线上：不翻页，把这条标注的内容念出来
      const markEl = target.closest("mark[data-hl]");
      if (markEl) {
        const item = annotations.find((a) => a.id === markEl.getAttribute("data-hl"));
        if (item) {
          const note = item.label?.trim();
          setMarkNotice(note ? `笔记：${note}` : item.kind === "note" ? "这条笔记还没写内容" : "已划线");
        }
        return;
      }

      const rect = stageFocusRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      clickIfNotDrag(e, () => {
        if (ratio < 0.25) goPrev();
        else if (ratio > 0.75) goNext();
        else if (chrome) {
          // 用户自己收起的：解除入场钉住，之后按正常 3 秒节奏
          chromePinned.current = false;
          setChrome(false);
        } else reveal();
      });
    },
    [annotations, chrome, clickIfNotDrag, footnoteAt, goNext, goPrev, goToAnchor, reveal],
  );

  const filteredChapters = useMemo(() => {
    const q = tocQuery.trim().toLowerCase();
    const list = chapters.map((c, i) => ({ ...c, index: i }));
    if (!q) return list;
    return list.filter((c) => c.title.toLowerCase().includes(q));
  }, [chapters, tocQuery]);

  const body = error ? (
    <div className="reader-notice">
      <div className="reader-notice-title">打不开这本书</div>
      <div>{error}</div>
      <button className="btn btn-secondary" onClick={onExit}>
        返回书架
      </button>
    </div>
  ) : loading && !meta ? (
    <div className="reader-notice">
      <div>正在载入…</div>
    </div>
  ) : mode === "scroll" ? (
    <div
      key={chapterIndex}
      className="reader-scroll epub-scroll"
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={-1}
    >
      <div className="reader-scroll-inner">
        <div
          ref={textRef}
          className="reader-text epub-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  ) : (
    <div className="reader-viewport" ref={viewportRef} tabIndex={-1}>
      <div
        key={chapterIndex}
        ref={pageWindowRef}
        className="reader-page-window"
        data-enter={enterDir}
        style={
          {
            // 宽度由 CSS 的 min(--reader-page-width, 100%) 决定
            "--enter-x": enterDir === "prev" ? "-100%" : "100%",
          } as React.CSSProperties
        }
      >
        <div
          ref={columnsRef}
          className="reader-columns"
          style={{
            // 列宽交给 CSS 的 width:100%，位移用元素自身宽度百分比，
            // 两者都由布局引擎算，不依赖 JS 的 px 推算值
            columnWidth: `${pageWidth}px`,
            columnGap: `${PAGE_GAP}px`,
            transform: `translateX(calc(${-page} * (100% + ${PAGE_GAP}px)))`,
          }}
        >
          <div
            ref={textRef}
            className="reader-text epub-content"
            // 已由 sanitizeXhtml 移除脚本、事件属性与外部资源引用
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="reader-shell"
      data-chrome={chrome ? "on" : "off"}
      data-reader-theme={prefs.readerTheme === "follow" ? undefined : prefs.readerTheme}
      /*
       * 滚轮也算「动手了」。只在点击时解除钉住的话，全程用滚轮读的人
       * 会一直被工具栏占着版面，永远等不到它收起。
       */
      onWheel={() => {
        chromePinned.current = false;
        scheduleHide();
      }}
    >
      <div
        className="reader-stage"
        ref={stageFocusRef}
        tabIndex={-1}
        onPointerDown={(e) => {
          downPoint.current = { x: e.clientX, y: e.clientY, t: Date.now() };
        }}
        onClick={handleStageClick}
      >
        {body}
      </div>

      <div className="reader-chrome-hotzone reader-chrome-hotzone-top" onMouseEnter={reveal} />
      <div
        className="reader-topbar"
        data-hidden={!chrome}
        onMouseEnter={pauseHide}
        onMouseLeave={scheduleHide}
      >
        <button className="reader-toolbar-btn" onClick={onExit} aria-label="返回书架">
          <ArrowLeft size={20} strokeWidth={2} />
        </button>

        <button
          className="reader-title-btn"
          onClick={() => setTocOpen(true)}
          title={chapters[chapterIndex]?.title ?? book.title}
        >
          <span className="reader-book-title">{book.title}</span>
        </button>

        <button
          className="reader-toolbar-btn"
          onClick={() => setTocOpen((v) => !v)}
          aria-label="目录"
          title="目录（T）"
        >
          <List size={20} strokeWidth={2} />
        </button>

        <button
          className="reader-toolbar-btn"
          onClick={() => setExtras("annotation")}
          aria-label="标注"
          title="标注与划线"
        >
          <Bookmark size={20} strokeWidth={2} />
        </button>

        <button
          className="reader-toolbar-btn"
          onClick={() => setExtras("search")}
          aria-label="书内搜索"
          title="书内搜索"
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

        <button
          className="reader-toolbar-btn"
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置（Ctrl+,）"
        >
          <Settings size={20} strokeWidth={2} />
        </button>
      </div>

      {/* 常驻进度线：底栏收起后唯一能读出「读到哪」的东西（样式见 reader.css） */}
      <div className="reader-progress-line" data-hidden={chrome} aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, dragPercent ?? percent))}%` }} />
      </div>

      <div
        className="reader-chrome-hotzone reader-chrome-hotzone-bottom"
        onMouseEnter={reveal}
      />
      <div
        className="reader-bottombar"
        data-hidden={!chrome}
        onMouseEnter={pauseHide}
        onMouseLeave={scheduleHide}
      >
        <div className="reader-progress">
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={dragPercent ?? percent}
            onChange={(e) => setDragPercent(Number(e.target.value))}
            onPointerUp={() => {
              if (dragPercent != null) {
                jumpToPercent(dragPercent);
                setDragPercent(null);
              }
            }}
            onKeyUp={() => {
              if (dragPercent != null) {
                jumpToPercent(dragPercent);
                setDragPercent(null);
              }
            }}
            aria-label="阅读进度"
          />
        </div>

        <div className="reader-page-indicator">{positionText}</div>

        <div className="reader-mode-toggle" role="group" aria-label="阅读模式">
          <button
            aria-pressed={mode === "paging"}
            onClick={() => switchMode("paging")}
            title="分页"
          >
            <Columns2 size={14} strokeWidth={2} />
          </button>
          <button
            aria-pressed={mode === "scroll"}
            onClick={() => switchMode("scroll")}
            title="滚动"
          >
            <Rows3 size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <ShortcutHelp open={helpOpen} sections={EPUB_HELP} onClose={() => setHelpOpen(false)} />

      {footnote && (
        <FootnoteCard text={footnote.text} anchor={footnote.rect} onClose={closeFootnote} />
      )}

      <SelectionActions
        getRoot={() => textRef.current}
        enabled={!loading && !error && !!html}
        busy={markBusy}
        onCreate={(kind, target, note) => void createMark(kind, target, note)}
      />

      {markNotice && (
        <p className="reader-toast" role="status">
          {markNotice}
        </p>
      )}

      {/* 屏幕阅读器播报位：视觉隐藏，不占布局 */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>

      {tocOpen && (
        <>
          <div className="overlay" style={{ background: "transparent" }} onClick={() => setTocOpen(false)} />
          <aside className="toc glass" role="dialog" aria-modal="true" aria-label="目录" ref={tocTrap}>
            <div className="drawer-head">
              <span className="drawer-title">目录</span>
              <button className="icon-btn" onClick={() => setTocOpen(false)} aria-label="关闭目录">
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
                  placeholder="搜索章节"
                  spellCheck={false}
                  aria-label="搜索章节"
                />
              </div>
            </div>

            <div className="toc-list">
              {filteredChapters.map((chapter) => (
                <button
                  key={chapter.index}
                  className="toc-item"
                  aria-current={chapter.index === chapterIndex}
                  onClick={() => {
                    goChapter(chapter.index, 0);
                    setTocOpen(false);
                  }}
                  title={chapter.title}
                >
                  {chapter.title}
                </button>
              ))}
              {filteredChapters.length === 0 && (
                <div className="field-hint" style={{ padding: "var(--sp-3)" }}>
                  没有匹配的章节。
                </div>
              )}
            </div>
          </aside>
        </>
      )}

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
          onChanged={() => void loadAnnotations()}
          orderOf={(loc) => {
            if (loc.kind !== "epub") return null;
            const index = chapters.findIndex((c) => c.href === loc.href);
            return index < 0 ? null : index * 1000 + loc.progression * 999;
          }}
        />
      )}
    </div>
  );
}
