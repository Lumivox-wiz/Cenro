import { Check, MoreHorizontal } from "lucide-react";
import { fileUrl } from "../../api";
import { formatRecent, progressPercent } from "../../lib/format";
import { FORMAT_LABEL, type Book } from "../../types";
import { useLongPress } from "./useLongPress";
import TitleCover from "./TitleCover";

interface Props {
  book: Book;
  onOpen: (book: Book) => void;
  /**
   * 右键 / 长按 / 右上角「更多」：打开书籍操作菜单。
   * anchor 是触发元素，键盘唤出时菜单关闭后要把焦点还给它。
   */
  onMenu?: (book: Book, x: number, y: number, anchor?: HTMLElement) => void;
  /**
   * 封面版本号。封面文件名不变（{id}.jpg），重建后 URL 相同，
   * 浏览器不会重新请求，所以靠 key 变化强制重建 img 节点。
   */
  coverRev?: number;
  /** 选择模式：点卡面变成「勾选」而不是「打开」 */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (book: Book) => void;
}

/**
 * 5.4 书架卡片。
 *
 * 结构上刻意分成两个并排的按钮，而不是「整卡一个 button + 里面再塞一个」：
 * 按钮里放按钮是非法嵌套，浏览器会把内层拆出去，悬停区的点击行为会随机失效。
 * 所以卡面（打开）与右上角「更多」是兄弟节点，后者绝对定位盖在前者之上。
 */
export default function BookCard({
  book,
  onOpen,
  onMenu,
  coverRev = 0,
  selecting = false,
  selected = false,
  onToggleSelect,
}: Props) {
  const longPress = useLongPress((b, x, y) => onMenu?.(b, x, y));
  const cover = fileUrl(book.cover_path);
  const pct = progressPercent(book.progress);
  const lastRead = book.last_read_at ? formatRecent(book.last_read_at) : null;

  /*
   * 元信息行只留「格式 + 作者」。
   *
   * 原来还有第三段「分类」（电子书 / 文本 / 漫画…），但 categoryOf() 本身就是
   * 从 format 推导出来的——分类是格式的粗粒度投影，同一张卡片上写
   * 「EPUB · 沈砚 · 电子书」是把同一个输入说了两遍，还占掉一行宽度。
   * 分类维度在侧栏的筛选与计数里仍然完整保留。
   */
  const formatLabel = FORMAT_LABEL[book.format];

  /*
   * 卡片异常态（UI §5.4）。「待恢复」优先于「文件已丢失」：删除事务中断时
   * 文件确实也不在原处，但记录状态是明确的，说明「上次删除没收拾干净」
   * 比只说「找不到文件」更能解释用户看到的现象。
   */
  const state = book.status === "pending" ? "pending" : book.missing ? "missing" : null;
  const badge = state === "missing" ? "文件已丢失" : state === "pending" ? "待恢复" : null;

  /** 「更多」按钮与右键菜单是同一套功能入口，只是触发方式不同 */
  const openMenuAt = (el: HTMLElement) => {
    if (!onMenu) return;
    const rect = el.getBoundingClientRect();
    onMenu(book, rect.right - 8, rect.bottom + 4, el);
  };

  return (
    <div
      className="book-card"
      data-state={state ?? undefined}
      data-selected={selecting ? (selected ? "true" : "false") : undefined}
    >
      <button
        className="card-target"
        aria-pressed={selecting ? selected : undefined}
        onClick={() => {
          if (longPress.consumeClick()) return;
          // 选择模式下「点一下」的语义是勾选，打开交给动作条之外的操作
          if (selecting) {
            onToggleSelect?.(book);
            return;
          }
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
          // UX 规范 §8.2：Shift+F10 与键盘菜单键都要能唤出右键菜单
          if (!onMenu) return;
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu(book, rect.left + 16, rect.top + 16, e.currentTarget);
          }
        }}
        title={book.title}
      >
        <div className="card-cover">
          {selecting && (
            <span className="card-check" aria-hidden="true">
              {selected && <Check size={13} strokeWidth={3} />}
            </span>
          )}
          {cover ? (
            <img key={coverRev} src={cover} alt="" loading="lazy" draggable={false} />
          ) : (
            // 没有可提取的封图：按格式族生成文字封面，而不是留一块灰底图标
            <TitleCover
              title={book.title}
              author={book.author}
              format={book.format}
              kind={book.type}
            />
          )}

          {badge && (
            <span className="card-badge" data-state={state ?? undefined}>
              {badge}
            </span>
          )}

          {/* 悬停层：上次阅读 + 主操作，两段信息都在遮罩上，不压住书名 */}
          <div className="card-hover">
            {lastRead && <span className="card-hover-meta">上次阅读 · {lastRead}</span>}
            <span className="card-hover-cta">
              {pct != null && pct > 0 ? `继续阅读 · ${Math.round(pct)}%` : "开始阅读"}
            </span>
          </div>
        </div>

        <div className="card-title">{book.title}</div>
        {/*
          格式标签从封面左下角移到这一行。
          压在封面上时它盖住的是真实封面图（那才是用户认书的依据），
          还要为了在任何底色上可读而加半透明底 + backdrop-filter；
          移到文字行后它变成一条普通元信息，与作者、分类同排，也不再遮住任何东西。
        */}
        <div className="card-sub card-meta">
          <span className="card-format">{formatLabel}</span>
          <span className="card-meta-text">{book.author?.trim() ?? ""}</span>
        </div>

        {/* 进度只在这里出现：进度条 + 百分比，封面不再叠第二条 */}
        {pct != null && pct > 0 && (
          <div className="card-progress-row">
            {/* data-done：读完的进度条降到中性色，避免满屏强调色横线（见 components.css） */}
            <span
              className="card-progress-track"
              aria-hidden="true"
              data-done={pct >= 99 ? "" : undefined}
            >
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="card-progress-pct">{Math.round(pct)}%</span>
          </div>
        )}
      </button>

      {onMenu && (
        <button
          className="card-more"
          aria-label={`${book.title} 的更多操作`}
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            openMenuAt(e.currentTarget);
          }}
        >
          <MoreHorizontal size={16} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
