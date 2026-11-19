import { SearchX } from "lucide-react";
import { IS_MOBILE } from "../../lib/platform";

interface Props {
  variant: "empty-library" | "no-match";
  hasQuery: boolean;
  onImport: () => void;
  /** 仅在桌面端提供：移动端没有文件夹选择器 */
  onImportFolder?: () => void;
  /** 搜索无结果：清空搜索框（UX §11.3 主按钮） */
  onClearQuery?: () => void;
  /** 筛选无结果：切回「全部」分类（UX §11.3 主按钮） */
  onShowAll?: () => void;
  /**
   * 当前是否叠了标签筛选。有值时标题改成「没有带「x」标签的书」——
   * 「这个分类还没有书」在按标签筛的场景下是句错话。
   */
  tagLabel?: string | null;
}

/**
 * 空书库插画：三本立着的书 + 一本斜靠的书 + 一块架板。
 *
 * 为什么不用图标：48px 的线性图标传达的信息是「这里什么都没有」，
 * 而插画能传达「这里该放书」，后者才引导用户去点导入。
 * 全部用 CSS 变量上色，两套主题下自动跟随强调色。
 */
function ShelfArt() {
  return (
    <svg className="empty-art" viewBox="0 0 168 128" aria-hidden="true">
      <ellipse cx="84" cy="114" rx="58" ry="6" fill="var(--c-text-primary)" opacity="0.05" />

      {/* 架板 */}
      <rect x="26" y="104" width="116" height="5" rx="2.5" fill="var(--c-border-strong)" opacity="0.45" />

      {/* 第一本：强调色，带书名线与书签 */}
      <rect x="40" y="50" width="21" height="54" rx="3" fill="var(--c-accent)" />
      <rect x="44" y="60" width="13" height="2.5" rx="1.25" fill="#fff" opacity="0.5" />
      <rect x="44" y="67" width="9" height="2.5" rx="1.25" fill="#fff" opacity="0.35" />
      <path d="M45 50h6v13l-3-3.6-3 3.6z" fill="#fff" opacity="0.8" />

      {/* 第二本：淡一档，强调纵深 */}
      <rect x="64" y="42" width="18" height="62" rx="3" fill="var(--c-accent)" opacity="0.45" />
      <rect x="67" y="52" width="12" height="2.5" rx="1.25" fill="#fff" opacity="0.45" />

      {/* 第三本：浅灰，补齐节奏 */}
      <rect x="85" y="60" width="16" height="44" rx="3" fill="var(--c-text-primary)" opacity="0.18" />

      {/* 斜靠的一本，让整组不是一条直线 */}
      <g transform="rotate(11 110 104)">
        <rect x="103" y="56" width="15" height="48" rx="3" fill="var(--c-text-primary)" opacity="0.3" />
        <rect x="106" y="66" width="9" height="2.5" rx="1.25" fill="#fff" opacity="0.45" />
      </g>
    </svg>
  );
}

/**
 * 5.7 / UX §11.3：插画 → 标题 --fs-20 → 主按钮。
 *
 * 没有说明句：标题回答「现在是什么」，按钮回答「下一步做什么」，
 * 中间那句「试试其他关键词。」「切换到"全部"查看。」只是把按钮的话复述一遍。
 * 早期版本靠这几句撑场面，那是布局没排好时的补丁，不是必要信息。
 */
export default function EmptyState({
  variant,
  hasQuery,
  onImport,
  onImportFolder,
  onClearQuery,
  onShowAll,
  tagLabel,
}: Props) {
  const isLibrary = variant === "empty-library";
  // 搜索无结果与筛选无结果共用一个变体，按是否有搜索词分流（UX §11.3 两行）
  const isSearch = !isLibrary && hasQuery;

  const title = isLibrary
    ? "书架还是空的"
    : isSearch
      ? "没有找到匹配的书"
      : tagLabel
        ? `没有带「${tagLabel}」标签的书`
        : "这个分类还没有书";

  return (
    <div className="empty-state">
      {isLibrary ? (
        <ShelfArt />
      ) : (
        <span className="empty-icon">
          <SearchX size={30} strokeWidth={1.6} aria-hidden="true" />
        </span>
      )}

      <div className="empty-title">{title}</div>

      {isLibrary ? (
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={onImport}>
            {IS_MOBILE ? "选择文件导入" : "导入文件"}
          </button>
          {!IS_MOBILE && onImportFolder && (
            <button className="btn btn-secondary" onClick={onImportFolder}>
              导入文件夹
            </button>
          )}
        </div>
      ) : isSearch ? (
        onClearQuery && (
          <div className="empty-actions">
            <button className="btn btn-secondary" onClick={onClearQuery}>
              清空搜索
            </button>
          </div>
        )
      ) : (
        onShowAll && (
          <div className="empty-actions">
            <button className="btn btn-secondary" onClick={onShowAll}>
              查看全部
            </button>
          </div>
        )
      )}
    </div>
  );
}
