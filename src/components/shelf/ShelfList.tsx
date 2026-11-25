import { fileUrl } from "../../api";
import { formatRecent, progressPercent } from "../../lib/format";
import { FORMAT_LABEL, type Book } from "../../types";
import { useLongPress } from "./useLongPress";
import TitleCover from "./TitleCover";
import ImportCard, { type PendingImport } from "./ImportCard";

interface Props {
  books: Book[];
  onOpen: (book: Book) => void;
  /** 右键 / 长按：打开书籍操作菜单（anchor 用于关闭后归还焦点） */
  onMenu?: (book: Book, x: number, y: number, anchor?: HTMLElement) => void;
  /** 封面版本号：重建封面后强制 img 重新请求（URL 不变，只能靠 key） */
  coverRev?: number;
  /** 导入中的占位行，排在最前 */
  pending?: PendingImport[];
  /** 「正在读的那一本」的 id：只有它的进度条走强调色，与网格视图同一口径 */
  emphasisId?: string | null;
}

/** 4.2 列表视图：行高 64px，列＝封面 / 标题 / 格式 / 进度 / 最近阅读。 */
export default function ShelfList({
  books,
  onOpen,
  onMenu,
  coverRev = 0,
  pending,
  emphasisId = null,
}: Props) {
  const longPress = useLongPress((b, x, y) => onMenu?.(b, x, y));
  return (
    <div className="shelf-list" role="list">
      <div className="list-head" aria-hidden="true">
        <span />
        <span>标题</span>
        {/* 列里装的是 EPUB / TXT 这类**格式**，不是「类型」（文本 / 电子书 / 漫画） */}
        <span>格式</span>
        <span>进度</span>
        <span>最近阅读</span>
      </div>

      {pending?.map((item) => (
        <ImportCard key={item.key} item={item} variant="row" />
      ))}

      {books.map((book) => {
        const cover = fileUrl(book.cover_path);
        const pct = progressPercent(book.progress);
        // 异常态与卡片同口径（UI §5.4）：「待恢复」优先于「文件已丢失」
        const state =
          book.status === "pending" ? "pending" : book.missing ? "missing" : null;
        const badge = state === "missing" ? "文件已丢失" : state === "pending" ? "待恢复" : null;

        return (
          <button
            key={book.id}
            className="shelf-row"
            data-state={state ?? undefined}
            role="listitem"
            onClick={() => {
              if (longPress.consumeClick()) return;
              onOpen(book);
            }}
            onPointerDown={(e) => longPress.onPointerDown(e, book)}
            onPointerUp={longPress.onPointerUp}
            onPointerLeave={longPress.onPointerLeave}
            onPointerCancel={longPress.onPointerCancel}
            onContextMenu={(e) => {
              if (!onMenu) return;
              e.preventDefault();
              onMenu(book, e.clientX, e.clientY, e.currentTarget);
            }}
            onKeyDown={(e) => {
              // UX 规范 §8.2：Shift+F10 与键盘菜单键唤出右键菜单
              if (!onMenu) return;
              if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                onMenu(book, rect.left + 16, rect.top + 16, e.currentTarget);
              }
            }}
            title={book.title}
          >
            <div className="shelf-row-cover">
              {cover ? (
                <img key={coverRev} src={cover} alt="" loading="lazy" draggable={false} />
              ) : (
                <TitleCover title={book.title} format={book.format} kind={book.type} variant="thumb" />
              )}
            </div>

            <span className="row-title">
              <span className="row-title-text">{book.title}</span>
              {badge && (
                <span className="row-badge" data-state={state ?? undefined}>
                  {badge}
                </span>
              )}
              {/*
               * 窄屏专用：进度列整列被隐藏（<768px 只剩两列），
               * 进度改挂在书名后面，否则手机切到列表视图后完全看不到读到哪。
               * 排在 badge 之后，让状态标签贴着书名、百分比留在行尾（右对齐读作数值列）。
               * 桌面端 display:none，由下方 .row-progress 列承担。
               */}
              {pct == null ? null : (
                <span className="row-pct-inline">
                  {pct > 0 ? `${Math.round(pct)}%` : "未读"}
                </span>
              )}
            </span>
            {/* 类别列已删：categoryOf() 是从 format 推导的，分类是格式的粗粒度投影，
                两列并排等于把同一个输入说两遍。分类维度仍在侧栏的筛选与计数里。 */}
            <span className="row-cell">{FORMAT_LABEL[book.format]}</span>

            {/* 未读不画空轨道：0 宽度的灰条不携带任何信息，只占一行视觉噪音 */}
            <span className="row-progress">
              {pct != null && pct > 0 ? (
                <>
                  <span
                    className="row-progress-track"
                    data-emphasis={book.id === emphasisId ? "" : undefined}
                  >
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className="row-cell" style={{ minWidth: 40, textAlign: "right" }}>
                    {Math.round(pct)}%
                  </span>
                </>
              ) : (
                <span className="row-cell row-unread">
                  {pct === 0 ? "0%" : "未读"}
                </span>
              )}
            </span>

            <span className="row-cell row-recent">{formatRecent(book.last_read_at)}</span>
          </button>
        );
      })}
    </div>
  );
}
