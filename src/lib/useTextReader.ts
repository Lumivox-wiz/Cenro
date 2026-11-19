import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolvePageWidth } from "./pageWidth";
import { errorText, textApi } from "../api";
import type { Book, Progress, TextBook } from "../types";
import type { Prefs } from "./prefs";

/** 列间距，与 reader.css 的 column-gap 必须一致 */
const PAGE_GAP = 64;

export type ReaderMode = "paging" | "scroll";

interface Options {
  book: Book;
  prefs: Prefs;
  onProgress: (progress: Progress) => void;
}

export function useTextReader({ book, prefs, onProgress }: Options) {
  const [meta, setMeta] = useState<TextBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ReaderMode>("paging");
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // 初值先按偏好，但不超过当前窗口宽，避免首帧画出比屏幕还宽的列
  const [pageWidth, setPageWidth] = useState(() =>
    resolvePageWidth(null, prefs.readerPageWidth, prefs.readerMargin),
  );
  const [scrollRatio, setScrollRatio] = useState(0);
  // 分页视口高度：工具栏显隐会改变正文让位，进而改变每页能放多少行
  const [viewportH, setViewportH] = useState(0);
  // 换章进入方向：决定入场动效从哪一侧推进
  const [enterDir, setEnterDir] = useState<"next" | "prev">("next");

  const viewportRef = useRef<HTMLDivElement>(null);
  const pageWindowRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 待恢复的章内比例，测量出页数后再落地
  const pendingRatio = useRef<number | null>(null);
  // 上次参与分页的视口高度，用来判断这次重跑是不是「高度变了」
  const layoutHRef = useRef(0);
  // 测量 effect 不能依赖 page/pageCount（每次翻页都会重算），用 ref 读最新值
  const pageRef = useRef(page);
  pageRef.current = page;
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;
  const saveTimer = useRef<number | undefined>(undefined);

  const chapters = meta?.chapters ?? [];

  // 只在打开时消费一次初始进度：book 对象会随进度保存而更新，
  // 若把它放进依赖会导致整本书被反复重新加载。
  const initialProgress = useRef(book.progress);

  // 打开：解码 + 切章 + 恢复进度
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    textApi
      .open(book.id)
      .then((next) => {
        if (cancelled) return;
        setMeta(next);

        if (next.chapters.length === 0) {
          setLoading(false);
          return;
        }

        const progress = initialProgress.current;
        if (progress && progress.kind === "text") {
          const index = Math.max(0, Math.min(progress.chapter, next.chapters.length - 1));
          const chapter = next.chapters[index];
          const span = Math.max(1, chapter.end - chapter.start);
          const ratio = (progress.offset - chapter.start) / span;
          pendingRatio.current = Math.min(1, Math.max(0, ratio));
          setChapterIndex(index);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(errorText(e));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [book.id]);

  // 取当前章正文
  useEffect(() => {
    const chapter = chapters[chapterIndex];
    if (!chapter) return;

    let cancelled = false;
    setLoading(true);
    setContent("");

    textApi
      .range(book.id, chapter.start, chapter.end)
      .then((text) => {
        if (!cancelled) setContent(text);
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
    // chapters 由 meta 派生，依赖 meta 即可
  }, [book.id, meta, chapterIndex]);

  /*
   * 版心宽度以「页窗口实际渲染宽度」为准，而不是 JS 自己推算。
   *
   * 页窗口的宽度由 CSS 决定（`min(--reader-page-width, 100%)`），
   * 浏览器算出来的值一定是屏幕上真实可用的宽度；JS 无论用
   * clientWidth / innerWidth / 文档宽，都可能拿到 WebView 的
   * 旧布局尺寸，进而算出比屏幕更宽的列，导致文字被裁。
   * 这里只做一件事：把 CSS 的结果读回来，供列宽与翻页位移使用。
   */
  useLayoutEffect(() => {
    if (mode !== "paging") return;

    /*
     * 视口高度会变：工具栏呼出/收起时正文区的上下让位不同（见 reader.css）。
     * 列高按视口高度取整到行高倍数，高度一变就必须重算，否则会按旧列高分列，
     * 底部空一截或末行被切。
     *
     * 但切换过程带 160ms 过渡，ResizeObserver 会连着报十几帧，逐帧重排会卡。
     * 这里延迟 120ms 只取最后一帧的结果。
     */
    let heightTimer: number | undefined;

    const measure = () => {
      const el = pageWindowRef.current;
      if (!el) return;
      const width = el.getBoundingClientRect().width;
      // 首帧元素可能还未布局，宽度为 0 时保留初值
      if (width > 0) setPageWidth(Math.round(width));

      const height = viewportRef.current?.clientHeight ?? 0;
      window.clearTimeout(heightTimer);
      if (height > 0) {
        heightTimer = window.setTimeout(() => {
          setViewportH((prev) => (Math.abs(prev - height) > 1 ? Math.round(height) : prev));
        }, 120);
      }
    };

    measure();
    const raf = requestAnimationFrame(measure);

    // 观察稳定的外层容器：页窗口会随章节重建，容器不会
    const target = viewportRef.current;
    const observer = target ? new ResizeObserver(measure) : null;
    observer?.observe(target as Element);

    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);

    return () => {
      window.clearTimeout(heightTimer);
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [mode, chapterIndex, prefs.readerPageWidth]);

  // 测量页数：columns 容器宽度固定为单列宽，scrollWidth 即全部列总宽
  useLayoutEffect(() => {
    if (mode !== "paging") return;
    // 换章时会先把正文清空一帧，此时测量得到 1 页会把 pendingRatio 提前消耗掉，
    // 导致「回上一章」落到第一页而不是尾页。必须等真实正文到位。
    if (!content) return;
    const el = columnsRef.current;
    if (!el) return;
    const windowEl = pageWindowRef.current;

    /*
     * 视口高度变了（工具栏呼出 / 收起）时，翻页位移是按「第几页」算的，
     * 页序不变但每页装的内容变了，读者会被甩到别处。
     * 先把当前章内比例记下来，重算页数后由 pendingRatio 落回原位置。
     */
    const currentH = windowEl?.clientHeight ?? 0;
    if (
      layoutHRef.current > 0 &&
      Math.abs(layoutHRef.current - currentH) > 2 &&
      pendingRatio.current == null &&
      pageCountRef.current > 1
    ) {
      pendingRatio.current = pageRef.current / (pageCountRef.current - 1);
    }
    layoutHRef.current = currentH;

    /*
     * 列高等同视口高时，末行往往只能露出一半，被页窗口 overflow:hidden 切掉，
     * 看起来就是「最后一行被遮挡」。把列高取整到行高的整数倍，
     * 保证每一列都是完整的行——代价是底部空出不到一行的余量。
     */
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    if (lineHeight > 0 && windowEl) {
      const usable = Math.max(
        lineHeight,
        Math.floor(windowEl.clientHeight / lineHeight) * lineHeight,
      );
      el.style.height = `${usable}px`;
    }

    // 用元素实际渲染宽度算页数：这个值来自布局引擎，不会比屏幕宽
    const actualWidth = el.getBoundingClientRect().width || pageWidth;
    if (actualWidth > 0 && Math.abs(actualWidth - pageWidth) > 0.5) {
      setPageWidth(Math.round(actualWidth));
    }

    const column = actualWidth + PAGE_GAP;
    // 列数 = (内容总宽 + 末列间距) / 每页宽，向上取整避免末列被漏计
    const count = Math.max(1, Math.ceil((el.scrollWidth + PAGE_GAP) / column));
    setPageCount(count);

    if (pendingRatio.current != null) {
      const ratio = pendingRatio.current;
      pendingRatio.current = null;
      const target = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));

      // 换章定位不做动画：先关掉 transition，落位后两帧再恢复，
      // 否则会看到从第 0 页「倒滑」到目标页
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
  }, [content, mode, pageWidth, prefs.readerFontSize, prefs.readerLineHeight, viewportH]);

  /*
   * 滚动模式：工具栏呼出 / 收起会改变正文区的上下让位，滚动容器的位置与高度
   * 随之变化。scrollTop 是个绝对像素值，容器整体上移 32px 而 scrollTop 不变，
   * 读者眼前的内容就会往上跳 32px。
   *
   * 这里按容器的位移量反向补偿，让屏幕上的文字保持原地不动。
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

  // 滚动模式下换章/跳转后，按 pendingRatio 把滚动位置落到目标处
  useLayoutEffect(() => {
    if (mode !== "scroll" || pendingRatio.current == null) return;
    if (!content) return;
    const el = scrollRef.current;
    if (!el) return;
    const ratio = pendingRatio.current;
    pendingRatio.current = null;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTo({ top: max * ratio });
    setScrollRatio(ratio);
  }, [content, mode]);

  const scrollByViewport = useCallback((ratio: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      top: el.clientHeight * ratio,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, []);

  const goNext = useCallback(() => {
    if (mode === "scroll") {
      scrollByViewport(0.8);
      return;
    }
    if (page + 1 < pageCount) {
      setPage(page + 1);
      return;
    }
    if (chapterIndex + 1 < chapters.length) {
      pendingRatio.current = 0;
      setEnterDir("next");
      // 立刻清空旧章正文：同批渲染，避免新章节点先显示上一章内容
      setContent("");
      setChapterIndex(chapterIndex + 1);
    }
  }, [mode, page, pageCount, chapterIndex, chapters.length, scrollByViewport]);

  const goPrev = useCallback(() => {
    if (mode === "scroll") {
      scrollByViewport(-0.8);
      return;
    }
    if (page > 0) {
      setPage(page - 1);
      return;
    }
    if (chapterIndex > 0) {
      pendingRatio.current = 1;
      setEnterDir("prev");
      setContent("");
      setChapterIndex(chapterIndex - 1);
    }
  }, [mode, page, chapterIndex, scrollByViewport]);

  const goChapter = useCallback(
    (index: number) => {
      pendingRatio.current = 0;
      setEnterDir(index >= chapterIndex ? "next" : "prev");
      setContent("");
      setChapterIndex(index);
      setPage(0);
      setScrollRatio(0);
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [chapterIndex],
  );

  /** 章内比例（0–1），分页与滚动统一 */
  const chapterRatio = useMemo(() => {
    if (mode === "scroll") return scrollRatio;
    if (pageCount <= 1) return 0;
    return page / (pageCount - 1);
  }, [mode, scrollRatio, page, pageCount]);

  const percent = useMemo(() => {
    if (!meta || meta.total_bytes === 0) return 0;
    const chapter = meta.chapters[chapterIndex];
    if (!chapter) return 0;
    const offset = chapter.start + chapterRatio * (chapter.end - chapter.start);
    return Math.min(100, Math.max(0, (offset / meta.total_bytes) * 100));
  }, [meta, chapterIndex, chapterRatio]);

  const jumpToPercent = useCallback(
    (target: number) => {
      if (!meta || meta.total_bytes === 0) return;
      const offset = (Math.min(100, Math.max(0, target)) / 100) * meta.total_bytes;

      const index = meta.chapters.findIndex((c) => offset >= c.start && offset < c.end);
      const resolved = index === -1 ? meta.chapters.length - 1 : index;
      const chapter = meta.chapters[resolved];
      const span = Math.max(1, chapter.end - chapter.start);
      const ratio = Math.min(1, Math.max(0, (offset - chapter.start) / span));

      // 章内跳转：不重新取正文，直接定位，避免拖动进度条时反复加载
      if (resolved === chapterIndex) {
        if (mode === "paging") {
          setPage(Math.min(pageCount - 1, Math.max(0, Math.round(ratio * (pageCount - 1)))));
        } else {
          const el = scrollRef.current;
          if (el) {
            const max = el.scrollHeight - el.clientHeight;
            el.scrollTo({ top: max * ratio });
          }
          setScrollRatio(ratio);
        }
        return;
      }

      setContent("");
      setEnterDir(resolved > chapterIndex ? "next" : "prev");
      setChapterIndex(resolved);
      setScrollRatio(ratio);
      pendingRatio.current = ratio;
    },
    [meta, mode, chapterIndex, pageCount],
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollRatio(max > 0 ? el.scrollTop / max : 0);
  }, []);

  // 进度落库：防抖 500ms（UX §5.4 唯一表述：停止变化 500ms 后写入）
  useEffect(() => {
    if (!meta || loading) return;
    const chapter = meta.chapters[chapterIndex];
    if (!chapter) return;

    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const offset = Math.round(
        chapter.start + chapterRatio * (chapter.end - chapter.start),
      );
      onProgress({
        kind: "text",
        offset,
        chapter: chapterIndex,
        total: meta.total_bytes,
      });
    }, 500);

    return () => window.clearTimeout(saveTimer.current);
  }, [meta, chapterIndex, chapterRatio, loading, onProgress]);

  return {
    meta,
    error,
    loading,
    content,
    mode,
    setMode,
    chapters,
    chapterIndex,
    enterDir,
    page,
    pageCount,
    pageWidth,
    percent,
    /** 精确落到某一页（跳到划线位置时用，比按比例取整准） */
    setPage,
    viewportRef,
    pageWindowRef,
    columnsRef,
    scrollRef,
    goNext,
    goPrev,
    goChapter,
    jumpToPercent,
    onScroll,
  };
}

export { PAGE_GAP };
