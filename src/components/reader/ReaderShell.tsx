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
import type { Book, Progress } from "../../types";
import { annotationApi, errorText, type Annotation } from "../../api";
import type { Prefs } from "../../lib/prefs";
import { PAGE_GAP, useTextReader, type ReaderMode } from "../../lib/useTextReader";
import { focusChromeBand } from "../../lib/a11y";
import { useAnnounce } from "../../lib/useAnnounce";
import { useFocusTrap } from "../../lib/useFocusTrap";
import ShortcutHelp, { type HelpSection } from "./ShortcutHelp";
import ReaderExtras, { type ExtrasTab } from "./ReaderExtras";
import ReaderText from "./ReaderText";
import SelectionActions from "./SelectionActions";
import {
  columnOf,
  findMark,
  textLength,
  type MarkSpec,
  type SelectionTarget,
} from "../../lib/highlight";

const TXT_HELP: HelpSection[] = [
  {
    title: "工具栏",
    kind: "buttons",
    rows: [
      { label: "返回书架", hint: "顶栏 ←" },
      { label: "目录", hint: "点书名或列表图标" },
      { label: "操作提示", hint: "顶栏 ?" },
      { label: "设置", hint: "顶栏齿轮" },
      { label: "翻页 / 滚动", hint: "底栏右下两格" },
      { label: "跳转进度", hint: "拖动底栏进度条" },
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
      { label: "打开设置", hint: "Ctrl + ," },
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

export default function ReaderShell({ book, prefs, onExit, onProgress, onOpenSettings }: Props) {
  const reader = useTextReader({ book, prefs, onProgress });
  const {
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
    setPage,
    percent,
    viewportRef,
    pageWindowRef,
    columnsRef,
    scrollRef,
    goNext,
    goPrev,
    goChapter,
    jumpToPercent,
    onScroll,
  } = reader;

  /** 当前阅读位置，坐标与「保存进度」完全一致（percent 就是 offset / total_bytes） */
  const currentLocator = useCallback(() => {
    if (!meta) return null;
    return {
      kind: "text" as const,
      offset: Math.round((percent / 100) * meta.total_bytes),
      chapter: chapterIndex,
      total: meta.total_bytes,
    };
  }, [chapterIndex, meta, percent]);

  const currentLabel = useCallback(() => {
    const title = chapters[chapterIndex]?.title?.trim();
    const where = `第 ${chapterIndex + 1} 章 · ${Math.round(percent)}%`;
    return title ? `${title} · ${Math.round(percent)}%` : where;
  }, [chapterIndex, chapters, percent]);

  // ---------------- 划词标注 ----------------
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [markBusy, setMarkBusy] = useState(false);
  const [markNotice, setMarkNotice] = useState<string | null>(null);
  // 正文节点由 ReaderText 直接用 DOM 写，这里拿它的引用做划词与定位
  const textRef = useRef<HTMLDivElement>(null);
  // 待精确定位的标注：翻章是按比例算的，落到哪一页要等正文排好版才知道
  const pendingMark = useRef<string | null>(null);

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

  // 提示条自己收走：错误信息留着也没用，读者要的是继续读
  useEffect(() => {
    if (!markNotice) return;
    const t = window.setTimeout(() => setMarkNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [markNotice]);

  /** 本章要画的区间。别的章的锚点没有意义——锚点是章内偏移 */
  const chapterMarks = useMemo<MarkSpec[]>(() => {
    const out: MarkSpec[] = [];
    for (const item of annotations) {
      if (!item.anchor) continue;
      if (item.locator.kind !== "text" || item.locator.chapter !== chapterIndex) continue;
      out.push({
        id: item.id,
        anchor: item.anchor,
        kind: item.kind === "note" ? "note" : "highlight",
        excerpt: item.excerpt,
      });
    }
    return out;
  }, [annotations, chapterIndex]);

  /**
   * 落库一条划线。
   *
   * 锚点存「章内字符下标」，落库的 `locator` 却是全书偏移——
   * 后者只用来给「跳到标注」一个大致落点，所以按章内进度折算成字节偏移即可；
   * 精确到哪一页由 pendingMark 那套补。
   */
  const createMark = useCallback(
    async (kind: "highlight" | "note", target: SelectionTarget, note: string | null) => {
      const chapter = chapters[chapterIndex];
      const root = textRef.current;
      if (!chapter || !root) return;
      const chars = Math.max(1, textLength(root));
      const span = Math.max(1, chapter.end - chapter.start);
      const offset = Math.round(chapter.start + (target.anchor.start / chars) * span);
      setMarkBusy(true);
      try {
        await annotationApi.add(
          book.id,
          kind,
          { kind: "text", offset, chapter: chapterIndex, total: meta?.total_bytes ?? 0 },
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
    [book.id, chapterIndex, chapters, loadAnnotations, meta],
  );

  const jumpToLocator = useCallback(
    (locator: Progress, markId?: string) => {
      if (locator.kind !== "text" || !meta || meta.total_bytes === 0) return;
      pendingMark.current = markId ?? null;
      jumpToPercent((locator.offset / meta.total_bytes) * 100);
    },
    [jumpToPercent, meta],
  );

  /*
   * 精确定位：翻到章里之后，按划线节点的实际列号改页码。
   * 按比例翻页对书签够用，对划线不行——差半页就看不到划的那句话。
   */
  useLayoutEffect(() => {
    const id = pendingMark.current;
    if (!id || !content) return;
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
    const column = columnOf(mark, columns, pageWidth, PAGE_GAP);
    setPage(Math.min(pageCount - 1, Math.max(0, column)));
  }, [chapterMarks, content, mode, pageCount, pageWidth, scrollRef, columnsRef, setPage]);

  /*
   * 工具栏初始可见（v1.14）。
   *
   * 原来是 false：从书架点进一本书，屏幕上没有任何控件——没有返回、没有书名、
   * 没有读到哪。中间点一下能唤出工具栏，但没有任何东西提示可以点。
   * 首帧显示 3 秒再淡出（下面的 scheduleHide 已经在跑），只多说一次
   * 「这个界面有控件」，之后恢复正常克制。
   */
  const [chrome, setChrome] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  /** 书签 / 搜索面板；null 表示关闭 */
  const [extras, setExtras] = useState<ExtrasTab | null>(null);
  const [tocQuery, setTocQuery] = useState("");
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // 目录抽屉焦点陷阱（UX §8.1）：抽屉条件渲染，关闭卸载时自动还焦点
  const tocTrap = useFocusTrap(true);

  const hideTimer = useRef<number | undefined>(undefined);
  const downPoint = useRef<{ x: number; y: number; t: number } | null>(null);
  const stageFocusRef = useRef<HTMLDivElement>(null);

  // ---- 变速翻页 ----
  // 按住方向键：首次 380ms 停顿后开始连翻，间隔从 220ms 逐次 ×0.85 递减，下限 55ms。
  // 速度上来后翻页动画同步缩短，避免快翻时动画拖尾。
  const [flipFast, setFlipFast] = useState(false);
  const repeatTimer = useRef<number | undefined>(undefined);
  const repeatInterval = useRef(220);
  const nextRef = useRef<() => void>(() => {});
  const prevRef = useRef<() => void>(() => {});

  useEffect(() => {
    nextRef.current = goNext;
    prevRef.current = goPrev;
  }, [goNext, goPrev]);

  const stopRepeat = useCallback(() => {
    window.clearTimeout(repeatTimer.current);
    repeatTimer.current = undefined;
    repeatInterval.current = 220;
    setFlipFast(false);
  }, []);

  const startRepeat = useCallback((action: () => void) => {
    window.clearTimeout(repeatTimer.current);
    repeatInterval.current = 220;
    action();

    const tick = () => {
      action();
      repeatInterval.current = Math.max(55, repeatInterval.current * 0.85);
      setFlipFast(repeatInterval.current < 150);
      repeatTimer.current = window.setTimeout(tick, repeatInterval.current);
    };
    repeatTimer.current = window.setTimeout(tick, 380);
  }, []);

  useEffect(() => () => window.clearTimeout(repeatTimer.current), []);

  /*
   * 入场钉住：工具栏显隐会改正文让位，收起时整页重排。
   * 这个重排若发生在用户刚开始读的第 3 秒，等于把他正在看的那一行抽走。
   * 所以入场不设倒计时，用户第一次动作之后才恢复 3 秒自动隐藏。
   */
  const chromePinned = useRef(true);

  const scheduleHide = useCallback(() => {
    if (chromePinned.current) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 3000);
  }, []);

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

  // 浮层打开期间暂停自动隐藏（规范 4.3：对话框/抽屉打开时暂停计时）
  useEffect(() => {
    if (helpOpen) {
      window.clearTimeout(hideTimer.current);
      setChrome(true);
      return;
    }
    scheduleHide();
  }, [helpOpen, scheduleHide]);

  const handleEsc = useCallback(() => {
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
      // 隐藏工具栏前先把焦点交给正文，键盘用户焦点不丢失（规范 7.2）
      stageFocusRef.current?.focus();
      setChrome(false);
      return;
    }
    onExit();
  }, [extras, helpOpen, tocOpen, chrome, onExit]);

  // 7.1 / 7.2 键盘
  useEffect(() => {
    const REPEATABLE = new Set(["ArrowLeft", "ArrowRight", "j", "J", "k", "K", " "]);

    const onKeyDown = (e: KeyboardEvent) => {
      // F6 必须先于输入框判断：焦点落到进度条（input[type=range]）上时
      // 也要能用它切回顶栏，否则焦点就锁死在底栏了。
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

      if (e.key === "Escape") {
        e.preventDefault();
        stopRepeat();
        handleEsc();
        return;
      }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        setTocOpen((v) => !v);
        return;
      }

      if (!REPEATABLE.has(e.key)) return;
      e.preventDefault();
      // 浏览器的系统级 key repeat 速率固定，这里自己接管循环才能做加速
      if (e.repeat) return;

      if (e.key === "ArrowLeft" || e.key === "k" || e.key === "K") {
        startRepeat(() => prevRef.current());
      } else if (e.key === " " && e.shiftKey) {
        startRepeat(() => prevRef.current());
      } else {
        startRepeat(() => nextRef.current());
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (REPEATABLE.has(e.key)) stopRepeat();
    };

    const onBlur = () => stopRepeat();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [handleEsc, onExit, startRepeat, stopRepeat]);

  /**
   * 点击热区判定。
   *
   * - 位移超过 8px：视为拖选文字，不翻页（UX §5.4）；
   * - 按住超过 250ms：视为多击选词判定期内，不触发（UX §5.4）；
   * - 判为轻点：先清掉可能残留的选区再执行动作。
   *   WebView 里轻点/双击文字会留下蓝色高亮，不清掉就会一直挂在那里。
   */
  const clickIfNotDrag = useCallback((e: React.MouseEvent, action: () => void) => {
    const down = downPoint.current;
    if (down) {
      if (Math.abs(e.clientX - down.x) > 8 || Math.abs(e.clientY - down.y) > 8) return;
      if (Date.now() - down.t > 250) return;
    }

    /*
     * 有选区时这一下只用来「取消选择」。
     * 既避免划完词一点画面就翻走，也顺手清掉 WebView 常留着的蓝底选中。
     */
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
      return;
    }

    action();
  }, []);

  /**
   * 滚动模式下不再铺热区层——那层 div 盖在滚动容器上方，
   * 触摸落在它身上时，浏览器找不到可滚动祖先，拖动就失效了。
   * 改为在 stage 上取点击位置自己分区：左 25% / 中 50% / 右 25%。
   */
  const handleStageClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      // 工具栏、抽屉等自身的点击不参与分区
      if (target.closest(".reader-topbar, .reader-bottombar, .toc")) return;

      /*
       * 点在划线上：不翻页，把这条标注的内容念出来。
       * 划线本身是「我留过东西的地方」，点它多半是想看看当时写了什么。
       */
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
    [annotations, clickIfNotDrag, goPrev, goNext, chrome, reveal],
  );

  const filteredChapters = useMemo(() => {
    const q = tocQuery.trim().toLowerCase();
    if (!q) return chapters.map((c, i) => ({ ...c, index: i }));
    return chapters
      .map((c, i) => ({ ...c, index: i }))
      .filter((c) => c.title.toLowerCase().includes(q));
  }, [chapters, tocQuery]);

  const currentChapterTitle = chapters[chapterIndex]?.title ?? book.title;

  /*
   * UX §4.1：小说底栏显示「第 X 章 · Y%」，不显示章内页码。
   * TXT 章节切分失败的兜底是单章「全文」（后端 split_fixed），
   * 此时没有章节可言，降级为「位置 Y%」（UX §4.1 降级条款）。
   */
  const noChapters = chapters.length === 1 && chapters[0].title === "全文";
  const positionText = noChapters
    ? `位置 ${Math.round(percent)}%`
    : `第 ${chapterIndex + 1} 章 · ${Math.round(percent)}%`;

  // ---- 屏幕阅读器播报（UX §7.3）----
  // 小说播报「第 X 章，42%」，降级时播「位置 42%」；播报用逗号、视觉用间隔点（§4.1）
  const announce = useAnnounce(
    !meta ? "" : noChapters ? `位置 ${Math.round(percent)}%` : `第 ${chapterIndex + 1} 章，${Math.round(percent)}%`,
    !!meta,
  );

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
  ) : mode === "paging" ? (
    <div className="reader-viewport" ref={viewportRef} tabIndex={-1}>
      <div
        // key 换章节会重建节点：transform 直接落在目标页位，
        // 同时触发一次淡入推进，避免跨章硬切
        key={chapterIndex}
        ref={pageWindowRef}
        className="reader-page-window"
        data-enter={enterDir}
        style={
          {
            // 宽度不再内联：由 CSS 的 min(--reader-page-width, 100%) 决定，
            // JS 只读回实际值。内联宽度会盖掉 CSS，反而让推算值生效。
            "--enter-x": enterDir === "prev" ? "-100%" : "100%",
          } as React.CSSProperties
        }
      >
        <div
          ref={columnsRef}
          className="reader-columns"
          style={{
            /*
             * 宽度不写死 px：由 CSS 的 width:100% 决定，永远等于页窗口宽。
             * column-width 只是「首选列宽」，即使它偏大，浏览器也只会排出
             * 一列并拉伸到容器宽度，不会让内容溢出被裁。
             */
            columnWidth: `${pageWidth}px`,
            columnGap: `${PAGE_GAP}px`,
            // 位移用百分比：translateX 的百分比基准就是元素自身宽度，
            // 也就是真实列宽，翻页步长因此天然精确，不依赖 JS 数值。
            transform: `translateX(calc(${-page} * (100% + ${PAGE_GAP}px)))`,
          }}
        >
          <ReaderText className="reader-text" text={content} marks={chapterMarks} innerRef={textRef} />
        </div>
      </div>
    </div>
  ) : (
    <div
      key={chapterIndex}
      className="reader-scroll"
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={-1}
    >
      <div className="reader-scroll-inner">
        <div className="reader-text">{content}</div>
      </div>
    </div>
  );

  return (
    <div
      className="reader-shell"
      data-chrome={chrome ? "on" : "off"}
      data-reader-theme={prefs.readerTheme === "follow" ? undefined : prefs.readerTheme}
      /* 滚轮也算动手：只用滚轮读的人不该被工具栏一直占着版面 */
      onWheel={() => {
        chromePinned.current = false;
        scheduleHide();
      }}
      style={{ "--reader-flip-dur": flipFast ? "70ms" : "160ms" } as React.CSSProperties}
    >
      <div
        className="reader-stage"
        ref={stageFocusRef}
        tabIndex={-1}
        data-mode={mode}
        onPointerDown={(e) => {
          downPoint.current = { x: e.clientX, y: e.clientY, t: Date.now() };
        }}
        // 两种模式都由 stage 按位置分区（见 handleStageClick）
        onClick={handleStageClick}
      >
        {body}

        {/*
          翻页分区在 stage 上判定，不再铺一层热区 div：
          那层盖在正文上方，浏览器找不到下面的文字，划词高亮就没法用。
        */}
      </div>

      <div
        className="reader-chrome-hotzone reader-chrome-hotzone-top"
        onMouseEnter={reveal}
      />
      <div
        className="reader-topbar"
        data-hidden={!chrome}
        onMouseEnter={pauseHide}
        onMouseLeave={scheduleHide}
        // 键盘焦点落在工具栏内时暂停自动隐藏（UI §4.3）
        onFocus={pauseHide}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleHide();
        }}
      >
        <button className="reader-toolbar-btn" onClick={onExit} aria-label="返回书架">
          <ArrowLeft size={20} strokeWidth={2} />
        </button>

        <button
          className="reader-title-btn"
          onClick={() => setTocOpen(true)}
          title={currentChapterTitle}
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
          aria-label="快捷键提示"
          title="快捷键"
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

      {/* 常驻进度线：底栏收起时唯一能读出「读到哪」的东西，2px 贴下沿不占布局 */}
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
        onFocus={pauseHide}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleHide();
        }}
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

        <div className="reader-mode-toggle" role="group" aria-label="翻页模式">
          <button
            aria-pressed={mode === "paging"}
            onClick={() => setMode("paging")}
            title="分页"
          >
            <Columns2 size={14} strokeWidth={2} />
          </button>
          <button
            aria-pressed={mode === "scroll"}
            onClick={() => setMode("scroll")}
            title="滚动"
          >
            <Rows3 size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <ShortcutHelp
        open={helpOpen}
        sections={TXT_HELP}
        onClose={() => setHelpOpen(false)}
      />

      {/* 划词操作条：跟着选区浮，不占布局 */}
      <SelectionActions
        getRoot={() => textRef.current}
        enabled={!loading && !error && content.length > 0}
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
                    goChapter(chapter.index);
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
          orderOf={(loc) => (loc.kind === "text" ? loc.offset : null)}
          onChanged={() => void loadAnnotations()}
        />
      )}
    </div>
  );
}

export type { ReaderMode };
