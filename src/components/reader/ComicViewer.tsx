import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  Columns2,
  FlipHorizontal2,
  HelpCircle,
  Rows3,
  Square,
  X,
} from "lucide-react";
import { comicApi, errorText, fileUrl } from "../../api";
import type { Book, Progress, SpreadMode } from "../../types";
import type { SpreadModePref } from "../../lib/prefs";
import { focusChromeBand } from "../../lib/a11y";
import { useAnnounce } from "../../lib/useAnnounce";
import ShortcutHelp, { type HelpSection } from "./ShortcutHelp";
import ReaderExtras, { type ExtrasTab } from "./ReaderExtras";

/**
 * 双页配对：
 * - 首页（封面）单独一屏并居中
 * - 之后两两成组，总数为奇数时末页单独（按方向靠边）
 * 返回组内页码（升序）。
 */
function spreadOf(page: number, total: number): number[] {
  if (page <= 0) return [0];
  const group = Math.ceil(page / 2);
  const first = group * 2 - 1;
  const second = group * 2;
  return second < total ? [first, second] : [first];
}

const COMIC_HELP: HelpSection[] = [
  {
    title: "工具栏",
    kind: "buttons",
    rows: [
      { label: "返回书架", hint: "顶栏 ←" },
      { label: "切换阅读方向", hint: "顶栏 ⇄" },
      { label: "操作提示", hint: "顶栏 ?" },
      { label: "关闭", hint: "顶栏 ×" },
      { label: "单页 / 双页 / 条漫", hint: "底栏右下三格，单双页也可按 D" },
      { label: "跳转页码", hint: "拖动底栏进度条" },
    ],
  },
  {
    title: "键盘",
    kind: "keys",
    rows: [
      { label: "翻页（日漫模式反转）", hint: "← / →" },
      { label: "下一页 / 上一页", hint: "Space / Shift+Space" },
      { label: "下一页 / 上一页", hint: "J / K" },
      { label: "单页 / 双页切换", hint: "D" },
      { label: "顶栏 / 底栏切换聚焦", hint: "F6" },
      { label: "显示 / 隐藏工具栏", hint: "双击画面" },
      { label: "返回书架", hint: "Esc" },
    ],
  },
];

interface Props {
  book: Book;
  onExit: () => void;
  onProgress: (progress: Progress) => void;
  /** 双页下封面的位置：居中（用户偏好）或靠边（规范 §6.3） */
  coverAlign: "center" | "edge";
  /** 单双页偏好（auto 按窗口宽自动判断） */
  spreadPref: SpreadModePref;
  onSpreadPref: (value: SpreadModePref) => void;
  /** 首次进入漫画时显示一次性方向提示（UX §4.2，设置可关） */
  dirHint: boolean;
}


export default function ComicViewer({
  book,
  onExit,
  onProgress,
  coverAlign,
  spreadPref,
  onSpreadPref,
  dirHint,
}: Props) {
  const [pages, setPages] = useState<string[]>([]);
  /** 书签面板；漫画没有文字层，搜索不可用 */
  const [extras, setExtras] = useState<ExtrasTab | null>(null);
  const [page, setPage] = useState(0);
  // 条漫是独立布局，与单双页无关；单双页由 prefs + 窗口宽共同决定
  const [webtoon, setWebtoon] = useState(false);
  // 规范说的是「窗口宽度」，不能用舞台宽（舞台已减去左右内边距，永远差 48px）
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [rtl, setRtl] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spreadUrls, setSpreadUrls] = useState<(string | null)[]>([]);
  const [chrome, setChrome] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * UX §4.2：首次进入漫画阅读时的一次性方向提示，3 秒消失（与 Toast 时长一致）。
   * 文案在挂载瞬间按当时方向定死，避免提示期间切方向导致文字漂移。
   */
  const [dirHintText, setDirHintText] = useState<string | null>(null);

  useEffect(() => {
    if (!dirHint) return;
    try {
      if (localStorage.getItem("reader.hint.comic-dir")) return;
      localStorage.setItem("reader.hint.comic-dir", "1");
    } catch {
      /* localStorage 不可用时退化为每次启动提示一次 */
    }
    setDirHintText(rtl ? "日漫模式：← 下一页" : "西漫模式：→ 下一页");
    const timer = window.setTimeout(() => setDirHintText(null), 3000);
    return () => window.clearTimeout(timer);
    // 只在挂载时执行一次；rtl 用闭包里的当前值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * UI §6.3：窗口 ≥1440 默认双页，<1440 单页；用户手动选过单页 / 双页后锁定，
   * 不再随窗口变化。auto 只在从未手动选择时生效。
   */
  const spread: "single" | "double" =
    spreadPref === "auto" ? (viewportWidth >= 1440 ? "double" : "single") : spreadPref;

  // index → asset URL，避免重复 invoke
  const urlCache = useRef(new Map<number, string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const preloadRef = useRef<HTMLImageElement[]>([]);
  const hideTimer = useRef<number | undefined>(undefined);

  // 打开：拿页面名列表并恢复进度
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    comicApi
      .listPages(book.id)
      .then((names) => {
        if (cancelled) return;
        setPages(names);

        const saved = book.progress;
        if (saved && saved.kind === "paged") {
          setPage(Math.min(names.length - 1, Math.max(0, saved.page)));
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
    // 只在换书时重新打开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const resolveUrl = useCallback(
    async (index: number): Promise<string | null> => {
      const cached = urlCache.current.get(index);
      if (cached) return cached;

      const name = pages[index];
      if (!name) return null;

      const path = await comicApi.pagePath(book.id, index, name);
      const url = fileUrl(path);
      if (url) urlCache.current.set(index, url);
      return url;
    },
    [book.id, pages],
  );

  // 分页模式：加载当前 spread，并预加载前后各几页
  useEffect(() => {
    if (webtoon || pages.length === 0) return;

    let cancelled = false;
    const group = spread === "double" ? spreadOf(page, pages.length) : [page];

    Promise.all(group.map((i) => resolveUrl(i)))
      .then((urls) => {
        if (cancelled) return;
        // 日漫双页：页码小的在右边，因此渲染顺序反转为 [大, 小]
        setSpreadUrls(spread === "double" && rtl ? [...urls].reverse() : urls);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });

    preloadRef.current = [];
    for (let i = page - 4; i <= page + 4; i += 1) {
      if (i < 0 || i >= pages.length || group.includes(i)) continue;
      void resolveUrl(i).then((url) => {
        if (!url || cancelled) return;
        const img = new Image();
        img.src = url;
        preloadRef.current.push(img);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [page, spread, webtoon, rtl, pages.length, resolveUrl]);

  const reveal = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 3000);
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // 浮层打开期间暂停自动隐藏；关闭后重新开始计时
  useEffect(() => {
    window.clearTimeout(hideTimer.current);
    if (helpOpen) {
      setChrome(true);
      return;
    }
    hideTimer.current = window.setTimeout(() => setChrome(false), 3000);
  }, [helpOpen]);

  // 窗口宽度决定 auto 模式是否进入双页
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** 当前位置：页号 0 基，与保存进度同构 */
  const currentLocator = useCallback(
    () => ({
      kind: "paged" as const,
      page,
      total: pages.length,
      zoom: 1,
      spread,
    }),
    [page, pages.length, spread],
  );

  const currentLabel = useCallback(() => {
    const pct = Math.round(((page + 1) / Math.max(1, pages.length)) * 100);
    return `第 ${page + 1} 页 · ${pct}%`;
  }, [page, pages.length]);

  const jumpToLocator = useCallback(
    (locator: Progress) => {
      if (locator.kind !== "paged") return;
      setPage(Math.min(Math.max(0, locator.page), Math.max(0, pages.length - 1)));
    },
    [pages.length],
  );

  const go = useCallback(
    (delta: number) => {
      if (webtoon) {
        const el = scrollRef.current;
        if (el) {
          el.scrollBy({
            top: el.clientHeight * 0.8 * delta,
            behavior: "smooth",
          });
        }
        return;
      }
      const group = spread === "double" ? spreadOf(page, pages.length) : [page];
      if (delta > 0) {
        const last = Math.max(...group);
        if (last + 1 < pages.length) setPage(last + 1);
      } else {
        const first = Math.min(...group);
        if (first > 0) {
          const previous = spreadOf(first - 1, pages.length);
          setPage(Math.min(...previous));
        }
      }
    },
    [spread, webtoon, page, pages.length],
  );

  // 键盘：← → 在日漫模式下反转，Space/J/K 始终是逻辑翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F6 先于输入框判断：焦点在进度条上时也要能切回顶栏
      if (e.key === "F6") {
        e.preventDefault();
        setChrome(true);
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
          e.preventDefault();
          go(rtl ? 1 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(rtl ? -1 : 1);
          break;
        case " ":
          e.preventDefault();
          go(e.shiftKey ? -1 : 1);
          break;
        case "j":
        case "J":
          e.preventDefault();
          go(1);
          break;
        case "k":
        case "K":
          e.preventDefault();
          go(-1);
          break;
        case "d":
        case "D": {
          // UI §6.3：循环 单页 ⇄ 双页，并解除自动（写入具体值即锁定）
          e.preventDefault();
          setWebtoon(false);
          onSpreadPref(spread === "double" ? "single" : "double");
          break;
        }
        case "Escape":
          e.preventDefault();
          if (extras) setExtras(null);
          else if (helpOpen) setHelpOpen(false);
          else onExit();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onExit, rtl, helpOpen, spread, onSpreadPref]);

  // 进度落库
  useEffect(() => {
    if (pages.length === 0) return;
    const timer = window.setTimeout(() => {
      const spreadKind: SpreadMode =
        webtoon ? "webtoon" : spread === "double" ? "double" : "single";
      onProgress({
        kind: "paged",
        page,
        total: pages.length,
        zoom: 1,
        spread: spreadKind,
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [page, pages.length, webtoon, spread, onProgress]);

  const percent = pages.length > 1 ? ((page + 1) / pages.length) * 100 : 0;

  // 屏幕阅读器播报（UX §7.3）：条漫报百分比，翻页报页码
  const announce = useAnnounce(
    pages.length === 0
      ? ""
      : webtoon
        ? `已读 ${Math.round(percent)}%`
        : `第 ${page + 1} 页，共 ${pages.length} 页`,
    pages.length > 0,
  );

  return (
    <div className="reader-shell" data-reader-theme="light">
      <div
        className="reader-stage comic-stage"
        onMouseMove={reveal}
        onDoubleClick={() => setChrome((v) => !v)}
      >
        {/* 屏幕阅读器播报位：视觉隐藏，不占布局 */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
        {error ? (
          <div className="reader-notice">
            <div className="reader-notice-title">打不开这本漫画</div>
            <div>{error}</div>
            <button className="btn btn-secondary" onClick={onExit}>
              返回书架
            </button>
          </div>
        ) : loading ? (
          <div className="reader-notice">
            <div>正在载入…</div>
          </div>
        ) : !webtoon ? (
          <>
            <div
              className="comic-spread"
              data-mode={spread}
              data-rtl={rtl}
              /*
               * 双页模式下的单张：
               * - 封面：按用户设置在居中 / 靠边之间选择
               * - 末页：始终按阅读方向靠边，维持翻页方向感
               */
              data-align={
                spread === "double" && spreadUrls.length === 1
                  ? page === 0
                    ? coverAlign === "center"
                      ? "center"
                      : rtl
                        ? "right"
                        : "left"
                    : rtl
                      ? "right"
                      : "left"
                  : undefined
              }
            >
              {spreadUrls.length === 0 ? (
                <div className="reader-notice">
                  <div>正在载入…</div>
                </div>
              ) : (
                spreadUrls.map((url, i) =>
                  url ? (
                    <img
                      key={i}
                      className="comic-page"
                      src={url}
                      alt=""
                      draggable={false}
                    />
                  ) : (
                    <div key={i} className="comic-page-missing" />
                  ),
                )
              )}
            </div>
            <div
              className="reader-hotzone reader-hotzone-left"
              onClick={() => go(rtl ? 1 : -1)}
              aria-hidden="true"
            />
            <div
              className="reader-hotzone reader-hotzone-center"
              onClick={() => setChrome((v) => !v)}
              aria-hidden="true"
            />
            <div
              className="reader-hotzone reader-hotzone-right"
              onClick={() => go(rtl ? -1 : 1)}
              aria-hidden="true"
            />
          </>
        ) : (
          <div className="comic-webtoon" ref={scrollRef}>
            <div className="comic-webtoon-inner">
              {pages.map((name, i) => (
                <LazyPage
                  key={name}
                  index={i}
                  resolve={resolveUrl}
                  onVisible={() => setPage(i)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="reader-topbar" data-hidden={!chrome}>
        <button className="reader-toolbar-btn" onClick={onExit} aria-label="返回书架">
          <ArrowLeft size={20} strokeWidth={2} />
        </button>
        <span className="reader-book-title">{book.title}</span>
        <div className="reader-spacer" />
        <button
          className="reader-toolbar-btn"
          onClick={() => setRtl((v) => !v)}
          title={rtl ? "当前：日漫（右→左）" : "当前：西漫（左→右）"}
          aria-label="切换阅读方向"
        >
          <FlipHorizontal2 size={20} strokeWidth={2} />
        </button>
        <button
          className="reader-toolbar-btn"
          onClick={() => setExtras("annotation")}
          aria-label="书签"
          title="书签"
        >
          <Bookmark size={20} strokeWidth={2} />
        </button>
        <button
          className="reader-toolbar-btn"
          onClick={() => setHelpOpen(true)}
          aria-label="快捷键提示"
          title="快捷键"
        >
          <HelpCircle size={20} strokeWidth={2} />
        </button>
        <button className="reader-toolbar-btn" onClick={onExit} aria-label="关闭">
          <X size={20} strokeWidth={2} />
        </button>
      </div>

      <div className="reader-bottombar" data-hidden={!chrome}>
        <div className="reader-progress">
          <input
            className="slider"
            type="range"
            min={1}
            max={Math.max(1, pages.length)}
            step={1}
            value={page + 1}
            onChange={(e) => {
              const next = Number(e.target.value) - 1;
              setPage(next);
              if (webtoon) {
                const el = scrollRef.current;
                const target = el?.children[0]?.children[next] as HTMLElement | undefined;
                target?.scrollIntoView({ block: "start" });
              }
            }}
            aria-label="页码"
          />
        </div>

        <div className="reader-page-indicator">
          {pages.length === 0 ? "—" : `${page + 1} / ${pages.length}`}
        </div>

        <div className="reader-mode-toggle" role="group" aria-label="阅读模式">
          <button
            aria-pressed={!webtoon && spread === "single"}
            onClick={() => {
              setWebtoon(false);
              onSpreadPref("single");
            }}
            title="单页（D 切换）"
          >
            <Square size={14} strokeWidth={2} />
          </button>
          <button
            aria-pressed={!webtoon && spread === "double"}
            onClick={() => {
              setWebtoon(false);
              onSpreadPref("double");
            }}
            title="双页（D 切换）"
          >
            <Columns2 size={14} strokeWidth={2} />
          </button>
          <button
            aria-pressed={webtoon}
            onClick={() => setWebtoon(true)}
            title="条漫"
          >
            <Rows3 size={14} strokeWidth={2} />
          </button>
        </div>

        <span className="reader-page-indicator" style={{ minWidth: 44 }}>
          {Math.round(percent)}%
        </span>
      </div>

      {dirHintText && (
        <div className="reader-dir-hint" role="status" aria-live="polite">
          {dirHintText}
        </div>
      )}

      <ShortcutHelp
        open={helpOpen}
        sections={COMIC_HELP}
        onClose={() => setHelpOpen(false)}
      />

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
          searchable={false}
          orderOf={(loc) => (loc.kind === "paged" ? loc.page : null)}
        />
      )}
    </div>
  );
}

/** 条漫里的懒加载页：进入视口才解析 URL */
function LazyPage({
  index,
  resolve,
  onVisible,
}: {
  index: number;
  resolve: (index: number) => Promise<string | null>;
  onVisible: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            onVisible();
            if (!url) void resolve(index).then((u) => setUrl(u));
          }
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [index, resolve, onVisible, url]);

  return (
    <div className="comic-webtoon-item" ref={ref}>
      {visible && url ? (
        <img src={url} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="comic-webtoon-placeholder" />
      )}
    </div>
  );
}
