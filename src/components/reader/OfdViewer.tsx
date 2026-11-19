import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bookmark, ChevronLeft, ChevronRight, HelpCircle } from "lucide-react";
import { errorText, ofdApi, type OfdMeta } from "../../api";
import type { Book, Progress } from "../../types";
import ReaderExtras, { type ExtrasTab } from "./ReaderExtras";
import ShortcutHelp, { type HelpSection } from "./ShortcutHelp";

const OFD_HELP: HelpSection[] = [
  {
    title: "操作",
    kind: "buttons",
    rows: [
      { label: "返回书架", hint: "顶栏 ←" },
      { label: "加书签", hint: "顶栏书签图标" },
      { label: "上一页 / 下一页", hint: "点左右两侧，或滚轮" },
    ],
  },
  {
    title: "键盘",
    kind: "keys",
    rows: [
      { label: "下一页 / 上一页", hint: "→ / ←" },
      { label: "下一页 / 上一页", hint: "Space / PageUp" },
      { label: "首页 / 末页", hint: "Home / End" },
      { label: "关闭面板 / 返回书架", hint: "Esc" },
    ],
  },
];

interface Props {
  book: Book;
  onExit: () => void;
  onProgress: (progress: Progress) => void;
}

/**
 * OFD 阅读器。
 *
 * 后端把每页转成 SVG（文字逐字定位），这里只负责翻页与进度。
 * 不复制 PdfViewer 的缩放 / 双页 / 连续滚动：OFD 的版式已经由文件定死，
 * 双页会把一份公文切成两半，缩放交给浏览器（页面按容器宽度等比缩放）。
 */
export default function OfdViewer({ book, onExit, onProgress }: Props) {
  const [meta, setMeta] = useState<OfdMeta | null>(null);
  const [page, setPage] = useState(0);
  /** 书签面板；OFD 的正文是 SVG，没有可搜的文字层 */
  const [extras, setExtras] = useState<ExtrasTab | null>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const saved = useRef(book.progress);
  const stageRef = useRef<HTMLDivElement>(null);
  // 触控板一次滑动会连发几十个 wheel，不去抖会一下翻十几页
  const wheelLock = useRef(0);

  // 打开：拿页数与首页尺寸，按保存的页码恢复
  useEffect(() => {
    let cancelled = false;
    ofdApi
      .open(book.id)
      .then((next) => {
        if (cancelled) return;
        setMeta(next);
        const p = saved.current;
        if (p && p.kind === "paged") {
          setPage(Math.min(next.pages - 1, Math.max(0, p.page)));
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

  // 取当前页的 SVG
  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    setLoading(true);
    ofdApi
      .page(book.id, page)
      .then((next) => {
        if (!cancelled) setSvg(next);
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
  }, [book.id, meta, page]);

  // 翻页后回到页面顶部，否则长页面会停在上一页的位置
  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    if (!meta) return;
    onProgress({ kind: "paged", page, total: meta.pages, zoom: 1, spread: "single" });
  }, [meta, page, onProgress]);

  const go = useCallback(
    (delta: number) => {
      setPage((current) => {
        if (!meta) return current;
        return Math.min(meta.pages - 1, Math.max(0, current + delta));
      });
    },
    [meta],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        onExit();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setPage(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setPage(Math.max(0, (meta?.pages ?? 1) - 1));
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (extras) setExtras(null);
        else if (helpOpen) setHelpOpen(false);
        else onExit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [extras, go, helpOpen, meta, onExit]);

  const currentLocator = useCallback(
    () => ({
      kind: "paged" as const,
      page,
      total: meta?.pages ?? 0,
      zoom: 1,
      spread: "single" as const,
    }),
    [meta?.pages, page],
  );

  const currentLabel = useCallback(() => {
    const total = meta?.pages ?? 0;
    const pct = total > 0 ? Math.round(((page + 1) / total) * 100) : 0;
    return `第 ${page + 1} 页 / 共 ${total} 页 · ${pct}%`;
  }, [meta?.pages, page]);

  const jumpToLocator = useCallback(
    (locator: Progress) => {
      if (locator.kind !== "paged") return;
      const total = meta?.pages ?? 0;
      setPage(Math.min(Math.max(0, locator.page), Math.max(0, total - 1)));
    },
    [meta?.pages],
  );

  /**
   * 翻页入口不止底部工具栏：版式文档的阅读习惯是「点左右两侧翻页」。
   * 左 30% 上一页、右 30% 下一页，中间留给选择文字（不需要就别点）。
   */
  const handleStageClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input")) return;

      // 选完字松手也会触发 click，此时不该翻页
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;

      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      if (ratio < 0.3) go(-1);
      else if (ratio > 0.7) go(1);
    },
    [go],
  );

  /**
   * 滚轮翻页：页面比视口高时先滚到底，滚到底之后再翻页，
   * 否则长页面的下半截永远看不到。
   */
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const stage = stageRef.current;
      if (stage) {
        const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
        const atTop = stage.scrollTop <= 2;
        if (e.deltaY > 0 && !atBottom) return;
        if (e.deltaY < 0 && !atTop) return;
      }
      if (Math.abs(e.deltaY) < 4) return;

      const now = Date.now();
      if (now - wheelLock.current < 260) return;
      wheelLock.current = now;
      go(e.deltaY > 0 ? 1 : -1);
    },
    [go],
  );

  return (
    <div className="reader-shell ofd-viewer">
      <div className="reader-topbar">
        <button className="reader-toolbar-btn" onClick={onExit} aria-label="返回书架">
          <ArrowLeft size={20} strokeWidth={2} />
        </button>
        <span className="reader-book-title">{book.title}</span>
        <div className="reader-spacer" />
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
          aria-label="操作提示"
          title="操作提示"
        >
          <HelpCircle size={20} strokeWidth={2} />
        </button>
        <span className="reader-page-indicator">
          {meta ? `${page + 1} / ${meta.pages}` : "—"}
        </span>
      </div>

      <div
        className="ofd-stage"
        ref={stageRef}
        onClick={handleStageClick}
        onWheel={handleWheel}
      >
        {error ? (
          <div className="reader-notice">
            <div className="reader-notice-title">OFD 打开失败</div>
            <div>{error}</div>
            <button className="btn btn-secondary" onClick={onExit}>
              返回书架
            </button>
          </div>
        ) : (
          <div
            className="ofd-page"
            data-loading={loading ? "true" : undefined}
            // SVG 由本地文件生成，文本已转义、不含脚本，可直接内联
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>

      <div className="reader-bottombar ofd-nav">
        <button
          className="reader-toolbar-btn"
          onClick={() => go(-1)}
          disabled={page <= 0}
          aria-label="上一页"
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>

        <input
          className="ofd-slider"
          type="range"
          min={0}
          max={Math.max(0, (meta?.pages ?? 1) - 1)}
          value={page}
          onChange={(e) => setPage(Number(e.target.value))}
          aria-label="跳转页码"
        />

        <button
          className="reader-toolbar-btn"
          onClick={() => go(1)}
          disabled={!meta || page >= meta.pages - 1}
          aria-label="下一页"
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      </div>

      <ShortcutHelp open={helpOpen} sections={OFD_HELP} onClose={() => setHelpOpen(false)} />

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
