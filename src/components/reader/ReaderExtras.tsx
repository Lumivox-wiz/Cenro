import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkPlus,
  Download,
  Highlighter,
  NotebookPen,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { IS_MOBILE } from "../../lib/platform";
import {
  annotationApi,
  errorText,
  type Annotation,
  type AnnotationKind,
  type SearchHit,
} from "../../api";
import { formatRecent } from "../../lib/format";
import type { Progress } from "../../types";
import { useFocusTrap } from "../../lib/useFocusTrap";

export type ExtrasTab = "annotation" | "search";

type SortMode = "position" | "recent";
type Filter = "all" | AnnotationKind;

const KIND_LABEL: Record<AnnotationKind, string> = {
  bookmark: "书签",
  highlight: "高亮",
  note: "笔记",
};

interface Props {
  bookId: string;
  /** 导出文件名要用书名，面板自己拿不到 */
  bookTitle: string;
  tab: ExtrasTab;
  onTab: (tab: ExtrasTab) => void;
  onClose: () => void;
  /** 当前阅读位置（加书签时用）。拿不到就禁用「加书签」。 */
  currentLocator: () => Progress | null;
  /** 当前位置的人话描述，作为书签默认备注 */
  currentLabel: () => string;
  /** 跳到某条标注；带 `markId` 时阅读器会精确落到划线处而不是只按比例翻章 */
  onJump: (locator: Progress, markId?: string) => void;
  /** 搜索是否可用（漫画等没有文字层的格式关闭输入框） */
  searchable: boolean;
  /**
   * 自定义搜索入口。文字类格式走后端；PDF 的正文在 pdf.js 里，
   * 只能由阅读器自己扫，所以由调用方决定怎么查。
   * `report` 用来汇报「已扫到第几页」——大 PDF 全本扫一遍要十几秒，
   * 不给进度会让人以为卡死了。
   */
  onSearch?: (query: string, report: (done: number, total: number) => void) => Promise<SearchHit[]>;
  /** 搜不到时的说明。PDF 与文字书原因不同，别用同一句 */
  searchEmptyHint?: string;
  /**
   * 空态下面的附加内容。扫描件 PDF 用它放「建立文字索引」的按钮与进度；
   * 面板不该知道 OCR 这件事，交给阅读器塞一个节点进来。
   */
  emptyExtra?: React.ReactNode;
  /** 标注增删改之后通知阅读器重画划线——面板只管列表，正文不归它管 */
  onChanged?: () => void;
  /**
   * 把定位换算成一个可比较的「书内序号」，用于「按位置」排序。
   * 各阅读器自己知道坐标含义（字节偏移 / 页码 / 章节+章内比例），面板不去猜。
   * 返回 null 表示这条标注没法排序，会被排到末尾。
   */
  orderOf?: (locator: Progress) => number | null;
}

/** 两个定位是否算「同一个位置」——避免在同一页反复点出七八条书签 */
function isSameSpot(a: Progress, b: Progress): boolean {
  if (a.kind === "text" && b.kind === "text") {
    // 千分之二以内算同一处：一段文字的长度量级
    const tolerance = Math.max(200, ((a.total || b.total) * 2) / 1000);
    return Math.abs(a.offset - b.offset) < tolerance;
  }
  if (a.kind === "paged" && b.kind === "paged") {
    return a.page === b.page;
  }
  if (a.kind === "epub" && b.kind === "epub") {
    return a.href === b.href && Math.abs(a.progression - b.progression) < 0.01;
  }
  return false;
}

/** 定位的人话描述：位置本身就够了，不需要再解释 */
function locatorText(locator: Progress): string {
  switch (locator.kind) {
    case "text": {
      if (!locator.total) return "位置未知";
      return `约 ${Math.round((locator.offset / locator.total) * 100)}%`;
    }
    case "paged":
      return `第 ${locator.page + 1} 页`;
    case "epub":
      return `章内 ${Math.round(locator.progression * 100)}%`;
  }
}

/**
 * 列表里的一行，三类标注共用一套壳，只有主文与副文不同。
 *
 * 原文里的换行与全角缩进在列表里没有意义（列表宽度比正文窄得多），
 * 折成单个空格才不会出现「一句话被缩进撑成两行、中间一大段空白」。
 */
function summarise(item: Annotation): { main: string; sub: string | null } {
  const flatten = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
  const excerpt = flatten(item.excerpt);
  const label = flatten(item.label);
  switch (item.kind) {
    case "bookmark":
      return { main: label || "未命名位置", sub: null };
    case "highlight":
      return { main: excerpt || label || "（原文已丢失）", sub: label || null };
    case "note":
      return { main: label || "（空笔记）", sub: excerpt || null };
  }
}

/**
 * 阅读页右侧的「标注 / 搜索」面板。
 *
 * 与目录抽屉同一套外壳（`.toc`）：同样的宽度、头高、滚动手感，
 * 只是内容换成两个页签。阅读器那边只负责提供「当前位置」与「跳到某个位置」，
 * 不关心列表怎么渲染——这样六种阅读器可以共用同一个面板。
 *
 * 书签、高亮、笔记共用一张表和这一个列表：读者脑子里它们是「我在书里留下的东西」，
 * 分成三个页签反而要记住去哪个页签找。
 */
export default function ReaderExtras({
  bookId,
  bookTitle,
  tab,
  onTab,
  onClose,
  currentLocator,
  currentLabel,
  onJump,
  searchable,
  orderOf,
  onChanged,
  onSearch,
  searchEmptyHint,
  emptyExtra,
}: Props) {
  const trap = useFocusTrap(true);
  const [items, setItems] = useState<Annotation[]>([]);
  const [sort, setSort] = useState<SortMode>("position");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [undo, setUndo] = useState<Annotation | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const undoTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      // 三类一起取：列表里本来就要混着显示
      setItems(await annotationApi.list(bookId));
    } catch (e) {
      setNotice(errorText(e));
    }
  }, [bookId]);

  // 增删改之后让阅读器重画划线。放在这里而不是每个调用点，
  // 免得以后新增一种标注时忘了通知正文。
  const changed = useCallback(() => {
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  // 切到搜索页签时把焦点放进输入框：进来就是要搜东西
  useEffect(() => {
    if (tab === "search" && searchable) inputRef.current?.focus();
  }, [searchable, tab]);

  useEffect(() => {
    if (editing) {
      editRef.current?.select();
      noteRef.current?.focus();
    }
  }, [editing]);

  const counts = useMemo(() => {
    const out: Record<AnnotationKind, number> = { bookmark: 0, highlight: 0, note: 0 };
    for (const item of items) out[item.kind] += 1;
    return out;
  }, [items]);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.kind === filter)),
    [filter, items],
  );

  const sorted = useMemo(() => {
    if (sort === "recent" || !orderOf) return visible;
    const decorated = visible.map((item) => ({ item, order: orderOf(item.locator) }));
    // 一条都算不出位置就退回时间序，别把列表搞成全在末尾
    if (decorated.every((d) => d.order === null)) return visible;
    return decorated
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
      .map((d) => d.item);
  }, [visible, orderOf, sort]);

  const addBookmark = useCallback(async () => {
    const locator = currentLocator();
    if (!locator) return;
    // 同一页重复加会得到一串一模一样的条目，先拦一道
    if (items.some((item) => item.kind === "bookmark" && isSameSpot(item.locator, locator))) {
      setNotice("这个位置已有书签");
      return;
    }
    try {
      await annotationApi.add(bookId, "bookmark", locator, { label: currentLabel() });
      setNotice(null);
      setUndo(null);
      await refresh();
      changed();
    } catch (e) {
      setNotice(errorText(e));
    }
  }, [bookId, changed, currentLabel, currentLocator, items, refresh]);

  const remove = useCallback(
    async (item: Annotation) => {
      try {
        await annotationApi.remove(item.id);
        await refresh();
        changed();
        // 删除给一次反悔：标注是手滑最贵的一种记录
        setUndo(item);
        window.clearTimeout(undoTimer.current);
        undoTimer.current = window.setTimeout(() => setUndo(null), 6000);
      } catch (e) {
        setNotice(errorText(e));
      }
    },
    [changed, refresh],
  );

  const restore = useCallback(async () => {
    if (!undo) return;
    try {
      // 重新插入会得到新的 id 与时间；类型、位置、锚点、原文、备注全部原样带回去，
      // 否则撤销后高亮会变成书签、划线也不再出现
      await annotationApi.add(undo.book_id, undo.kind, undo.locator, {
        label: undo.label,
        excerpt: undo.excerpt,
        anchor: undo.anchor,
      });
      setUndo(null);
      await refresh();
      changed();
    } catch (e) {
      setNotice(errorText(e));
    }
  }, [changed, refresh, undo]);

  const commitEdit = useCallback(
    async (item: Annotation) => {
      const next = draft.trim();
      const current = (item.label ?? "").trim();
      setEditing(null);
      if (next === current) return;
      try {
        await annotationApi.setLabel(item.id, next || null);
        await refresh();
        changed();
      } catch (e) {
        setNotice(errorText(e));
      }
    },
    [changed, draft, refresh],
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setSearching(true);
    setNotice(null);
    setScan(null);
    try {
      const run = onSearch ?? ((text: string) => annotationApi.search(bookId, text));
      setHits(await run(q, (done, total) => setScan({ done, total })));
    } catch (e) {
      setHits([]);
      setNotice(errorText(e));
    } finally {
      setSearching(false);
      setScan(null);
    }
  }, [bookId, onSearch, query]);

  /**
   * 导出当前这本书的标注。
   *
   * 扩展名决定格式：`.csv` 出 CSV，其余出 Markdown——少一个「选择格式」的弹窗，
   * 用户想换格式改个后缀就行。写文件由后端做（plugin-fs 受 scope 限制，
   * 对话框选出来的任意路径未必在白名单里）。
   */
  const exportItems = useCallback(async () => {
    if (items.length === 0) {
      setNotice("还没有标注可导出");
      return;
    }
    if (IS_MOBILE) {
      setNotice("移动端暂不支持导出文件，可在电脑上导出");
      return;
    }
    try {
      const name = bookTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "标注";
      const path = await save({
        defaultPath: `${name}-标注.md`,
        filters: [
          { name: "Markdown（给人看）", extensions: ["md"] },
          { name: "CSV（表格）", extensions: ["csv"] },
          { name: "JSON（可回导）", extensions: ["json"] },
        ],
      });
      if (!path) return;
      const lower = path.toLowerCase();
      const format = lower.endsWith(".json")
        ? "json"
        : lower.endsWith(".csv")
          ? "csv"
          : "markdown";
      const count = await annotationApi.exportTo(bookId, path, format);
      setNotice(`已导出 ${count} 条`);
    } catch (e) {
      setNotice(errorText(e));
    }
  }, [bookId, bookTitle, items.length]);

  /**
   * 回导标注（JSON）。
   *
   * 只认自己导出的文件：位置、锚点、原文都在，写回去和原机一致的标注。
   * Markdown / CSV 不做导入——那两份是给人看的，位置被四舍五入过，
   * 硬读回来只会得到一堆错位的书签（见 `annotations_export.rs` 的说明）。
   */
  const importItems = useCallback(async () => {
    if (IS_MOBILE) {
      setNotice("移动端暂不支持导入文件，可在电脑上导入");
      return;
    }
    try {
      const path = await openDialog({
        multiple: false,
        title: "选择标注文件",
        filters: [{ name: "岑序标注", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const report = await annotationApi.importFrom(bookId, path);
      await refresh();
      changed();
      const from =
        report.source_title && report.source_title !== bookTitle
          ? `（文件来自《${report.source_title}》）`
          : "";
      setNotice(
        `导入 ${report.imported} 条，跳过 ${report.skipped} 条${from}`,
      );
    } catch (e) {
      setNotice(errorText(e));
    }
  }, [bookId, bookTitle, changed, refresh]);

  /** 命中词加粗：用字符区间切，不碰 HTML，避免注入 */
  const excerpt = useCallback((hit: SearchHit) => {
    const chars = Array.from(hit.excerpt);
    const before = chars.slice(0, hit.match_start).join("");
    const mid = chars.slice(hit.match_start, hit.match_end).join("");
    const after = chars.slice(hit.match_end).join("");
    return (
      <>
        {before}
        <mark>{mid}</mark>
        {after}
      </>
    );
  }, []);

  return (
    <>
      <div className="overlay" style={{ background: "transparent" }} onClick={onClose} />
      {/*
        与目录抽屉同一套外壳，包括 .glass：
        少了它这一层就只有几何没有底色，正文会从后面透上来和列表叠在一起。
      */}
      <aside
        className="toc glass"
        role="dialog"
        aria-modal="true"
        aria-label="标注与搜索"
        ref={trap}
      >
        <div className="drawer-head">
          <span className="drawer-title">{tab === "annotation" ? "标注" : "书内搜索"}</span>
          {tab === "annotation" && (
            <>
              {/* 移动端没有系统文件选择器，导入导出都留在桌面端 */}
              {!IS_MOBILE && (
                <button
                  className="icon-btn"
                  onClick={() => void importItems()}
                  aria-label="导入标注"
                  title="从 JSON 导入（与导出的 JSON 配对）"
                >
                  <Upload size={17} strokeWidth={2} />
                </button>
              )}
              <button
                className="icon-btn"
                onClick={() => void exportItems()}
                aria-label="导出标注"
                title="导出为 Markdown / CSV / JSON（JSON 可回导）"
              >
                <Download size={17} strokeWidth={2} />
              </button>
            </>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={20} strokeWidth={2} />
          </button>
        </div>

        <div className="extras-tabs" role="tablist" aria-label="标注与搜索">
          <button
            role="tab"
            aria-selected={tab === "annotation"}
            className="extras-tab"
            onClick={() => onTab("annotation")}
          >
            <Bookmark size={14} strokeWidth={2} />
            标注 {items.length > 0 && <span className="extras-count">{items.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={tab === "search"}
            className="extras-tab"
            onClick={() => onTab("search")}
          >
            <Search size={14} strokeWidth={2} />
            搜索
          </button>
        </div>

        {tab === "annotation" ? (
          <>
            <div className="toc-search">
              <button className="btn btn-secondary extras-add" onClick={() => void addBookmark()}>
                <BookmarkPlus size={15} strokeWidth={2} />
                在当前位置加书签
              </button>
            </div>

            {items.length > 1 && (
              <div className="extras-filters" role="group" aria-label="按类型筛选">
                <button
                  className="extras-sort-btn"
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  全部 {items.length}
                </button>
                {(["bookmark", "highlight", "note"] as const).map((kind) =>
                  counts[kind] > 0 ? (
                    <button
                      key={kind}
                      className="extras-sort-btn"
                      aria-pressed={filter === kind}
                      onClick={() => setFilter(kind)}
                    >
                      {KIND_LABEL[kind]} {counts[kind]}
                    </button>
                  ) : null,
                )}
              </div>
            )}

            {visible.length > 1 && (
              <div className="extras-sort" role="group" aria-label="标注排序">
                <button
                  className="extras-sort-btn"
                  aria-pressed={sort === "position"}
                  onClick={() => setSort("position")}
                >
                  按位置
                </button>
                <button
                  className="extras-sort-btn"
                  aria-pressed={sort === "recent"}
                  onClick={() => setSort("recent")}
                >
                  按时间
                </button>
              </div>
            )}

            <div className="toc-list">
              {items.length === 0 && (
                <p className="extras-empty">
                  还没有标注。读到想记住的地方，加个书签，或者选中一句话划线。
                </p>
              )}
              {items.length > 0 && visible.length === 0 && (
                <p className="extras-empty">这一类还没有记录。</p>
              )}
              {sorted.map((item) => {
                const { main, sub } = summarise(item);
                const isNote = item.kind === "note";
                return (
                  <div key={item.id} className="bookmark-row annotation-row" data-kind={item.kind}>
                    {editing === item.id ? (
                      isNote ? (
                        <textarea
                          ref={noteRef}
                          className="bookmark-input note-input"
                          value={draft}
                          rows={3}
                          maxLength={2000}
                          placeholder="写点什么…"
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => void commitEdit(item)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              void commitEdit(item);
                            }
                          }}
                          aria-label="笔记内容"
                        />
                      ) : (
                        <input
                          ref={editRef}
                          className="bookmark-input"
                          value={draft}
                          maxLength={60}
                          placeholder={item.kind === "highlight" ? "给这段划线加句话" : "给这个位置起个名字"}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => void commitEdit(item)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitEdit(item);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              setEditing(null);
                            }
                          }}
                          aria-label={item.kind === "highlight" ? "划线备注" : "书签备注"}
                        />
                      )
                    ) : (
                      <button
                        className="bookmark-main"
                        onClick={() => {
                          // 高亮 / 笔记把 id 也带上：阅读器能精确翻到划线那一页
                          onJump(item.locator, item.anchor ? item.id : undefined);
                          onClose();
                        }}
                        title={main}
                      >
                        <span className="annotation-summary">
                          <span className={`annotation-kind annotation-kind-${item.kind}`}>
                            {item.kind === "highlight" ? (
                              <Highlighter size={11} strokeWidth={2.4} />
                            ) : item.kind === "note" ? (
                              <NotebookPen size={11} strokeWidth={2.4} />
                            ) : (
                              <Bookmark size={11} strokeWidth={2.4} />
                            )}
                            {KIND_LABEL[item.kind]}
                          </span>
                          <span className={isNote ? "annotation-main" : "annotation-quote"}>
                            {main}
                          </span>
                        </span>
                        {sub && <span className="annotation-sub">{sub}</span>}
                        <span className="bookmark-loc">
                          {locatorText(item.locator)} · {formatRecent(item.created_at)}
                        </span>
                      </button>
                    )}

                    <button
                      className="icon-btn bookmark-act"
                      onClick={() => {
                        setEditing(item.id);
                        setDraft(item.label ?? "");
                      }}
                      aria-label={isNote ? "编辑笔记" : "编辑备注"}
                      title={isNote ? "编辑笔记" : "编辑备注"}
                      disabled={editing === item.id}
                    >
                      <Pencil size={13} strokeWidth={2} />
                    </button>
                    <button
                      className="icon-btn bookmark-act bookmark-del"
                      onClick={() => void remove(item)}
                      aria-label="删除标注"
                      title="删除"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="toc-search">
              <div className="search-box" style={{ maxWidth: "100%" }}>
                <Search size={16} strokeWidth={2} aria-hidden="true" />
                <input
                  ref={inputRef}
                  className="search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                  placeholder={searchable ? "在本书内搜索" : "此格式暂不支持搜索"}
                  spellCheck={false}
                  disabled={!searchable}
                  aria-label="在本书内搜索"
                />
              </div>
              {searchable && (
                <button className="btn btn-secondary extras-add" onClick={() => void runSearch()}>
                  搜索
                </button>
              )}
            </div>

            <div className="toc-list">
              {searching && (
                <p className="extras-empty">
                  搜索中…{scan ? `（第 ${scan.done} / ${scan.total} 页）` : ""}
                </p>
              )}
              {!searching && hits?.length === 0 && (
                <>
                  <p className="extras-empty">
                    没有找到「{query.trim()}」。{searchEmptyHint ?? ""}
                  </p>
                  {emptyExtra}
                </>
              )}
              {!searching &&
                hits?.map((hit, i) => (
                  <button
                    key={`${hit.chapter}-${i}`}
                    className="search-hit"
                    onClick={() => {
                      onJump(hit.locator);
                      onClose();
                    }}
                  >
                    {hit.chapter_title && (
                      <span className="search-hit-chapter">{hit.chapter_title}</span>
                    )}
                    <span className="search-hit-text">{excerpt(hit)}</span>
                  </button>
                ))}
              {!searching && hits === null && (
                <p className="extras-empty">
                  {searchable ? "输入关键词后回车。" : "漫画没有文字层，暂不支持搜索。"}
                </p>
              )}
            </div>
          </>
        )}

        {undo && (
          <div className="extras-undo" role="status">
            <span>已删除「{summarise(undo).main.slice(0, 12)}」</span>
            <button onClick={() => void restore()}>撤销</button>
          </div>
        )}
        {notice && <p className="extras-notice">{notice}</p>}
      </aside>
    </>
  );
}
