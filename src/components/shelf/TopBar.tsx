import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  Check,
  ChevronDown,
  LayoutGrid,
  List,
  ListChecks,
  Menu,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import type { SortMode, ViewMode } from "../../lib/prefs";
import { CATEGORY_LABEL, type CategoryKey } from "../../lib/filters";
import MenuShell from "./MenuShell";

interface Props {
  filter: string;
  onFilter: (value: string) => void;
  sort: SortMode;
  onSort: (value: SortMode) => void;
  query: string;
  onQuery: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onToggleSidebar: () => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  onImport: () => void;
  /** 进入多选（没书时禁用） */
  onSelectMode: () => void;
  /** 有书可选才显示这个入口 */
  canSelect: boolean;
  onOpenSettings: () => void;
  importing: boolean;
  /** 长按品牌名 0.8 秒：隐私书架入口（与书籍长按的 450ms 区分开） */
  onBrandLongPress: () => void;
  /** 设置抽屉打开中：按钮呈现激活态，视觉上「从按钮长出来」 */
  settingsOpen: boolean;
}

/**
 * 顶栏是否处于「移动布局」——按可用宽度判断，不看 UA（UI_REVIEW H1 / P2-4）。
 *
 * 原来用 IS_MOBILE（UA）：桌面把窗口拖到 700px 仍显示「搜索书名或作者」，
 * 而在 844px 的横屏手机上却用着只有两个字的「搜索」，两头都不对。
 * 767px 与布局断点同源——顶栏切成移动布局的那一刻才是真的没地方。
 */
function useNarrow() {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setNarrow(mq.matches);
    sync(); // 首帧与订阅之间窗口可能已经变过
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return narrow;
}

/** 4.2 顶栏：☰ | Logo | 搜索 | 视图切换 | 导入 | 设置，固定 56px。 */
export default function TopBar({
  filter,
  onFilter,
  sort,
  onSort,
  query,
  onQuery,
  searchRef,
  onToggleSidebar,
  view,
  onView,
  onImport,
  onSelectMode,
  canSelect,
  onOpenSettings,
  importing,
  onBrandLongPress,
  settingsOpen,
}: Props) {
  const narrow = useNarrow();

  /*
   * 长按 800ms。刻意比书籍长按（450ms）长：两个手势在同一屏里，
   * 时间一样会互相误触。松手 / 移开 / 滚动都取消。
   */
  const brandTimer = useRef<number | undefined>(undefined);
  const brandDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      brandTimer.current = window.setTimeout(onBrandLongPress, 800);
    },
    [onBrandLongPress],
  );
  const brandUp = useCallback(() => {
    if (brandTimer.current !== undefined) {
      window.clearTimeout(brandTimer.current);
      brandTimer.current = undefined;
    }
  }, []);

  /*
   * 分类下拉改成自绘菜单。
   *
   * 原生 <select> 在 Android 上弹出的是系统那套灰底单选列表（和这个应用没有半点关系），
   * 在 Windows 上也是系统控件。改用 MenuShell：定位、贴边内收、点外关闭、键盘导航都是现成的，
   * 样式也跟书籍右键菜单同一套。
   */
  const FILTER_ITEMS: { value: string; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "recent", label: "最近阅读" },
    ...(Object.keys(CATEGORY_LABEL) as CategoryKey[]).map((k) => ({
      value: k,
      label: CATEGORY_LABEL[k],
    })),
  ];

  const filterRef = useRef<HTMLButtonElement>(null);
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(null);

  const openFilterMenu = useCallback(() => {
    const rect = filterRef.current?.getBoundingClientRect();
    if (!rect) return;
    setFilterMenu({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  /*
   * 排序同样改成自绘菜单。原生的 <select> 在 Android 上是系统灰底列表，
   * 而且它只显示当前值、不显示「这是个菜单」——分类已经换成自绘了，
   * 两个并排的控件长得不一样，读起来像来自两个应用。
   * 宽度固定 112px：切换排序时右侧操作区不会整体左右跳。
   */
  const SORT_ITEMS: { value: SortMode; label: string }[] = [
    // 叫「最近打开」而不是「最近阅读」：侧栏的「最近阅读」是筛选项，同名不同义
    { value: "recent", label: "最近打开" },
    { value: "added", label: "添加时间" },
    { value: "title", label: "标题" },
  ];

  const sortRef = useRef<HTMLButtonElement>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);

  const openSortMenu = useCallback(() => {
    const rect = sortRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 右对齐锚点：菜单比按钮宽，从左对齐会向右顶出窗口
    setSortMenu({ x: rect.right - 168, y: rect.bottom + 4 });
  }, []);

  const scopeLabel =
    filter === "all"
      ? "全部"
      : filter === "recent"
        ? "最近阅读"
        : (CATEGORY_LABEL[filter as CategoryKey] ?? "全部");

  const sortLabel = SORT_ITEMS.find((item) => item.value === sort)?.label ?? "最近打开";

  return (
    <header className="topbar">
      {/* 移动端没有侧栏，这个按钮点了也不会有任何反应，直接隐藏 */}
      <button
        className="icon-btn topbar-menu"
        onClick={onToggleSidebar}
        aria-label="折叠或展开侧栏"
        data-tip="折叠侧栏 · Ctrl+\\"
      >
        <Menu size={20} strokeWidth={2} />
      </button>

      <span
        className="topbar-brand"
        onPointerDown={brandDown}
        onPointerUp={brandUp}
        onPointerLeave={brandUp}
        onPointerCancel={brandUp}
        // 长按不该顺手选中文字，也不该弹出原生菜单
        onContextMenu={(e) => e.preventDefault()}
        title="长按 0.8 秒打开隐私书架"
      >
        岑序
      </span>

      {/*
        当前分类不再单独印一行文字：桌面看侧栏激活项，窄屏和手机看右边那个下拉，
        同一件事说两遍只会在顶栏左端堆出一个孤立的词。
      */}

      <div className="search-box">
        <Search size={16} strokeWidth={2} aria-hidden="true" />
        {/* 手机上搜索框只剩一百多像素，长占位符会被截成「搜索书名或…」 */}
        <input
          ref={searchRef}
          className="search-input"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={narrow ? "搜索" : "搜索书名或作者"}
          spellCheck={false}
          aria-label="搜索书名或作者"
        />
        {query && (
          <button className="search-clear" onClick={() => onQuery("")} aria-label="清空搜索">
            <X size={14} strokeWidth={2} />
          </button>
        )}
      </div>

      <button
        ref={filterRef}
        className="topbar-menu-btn topbar-filter"
        onClick={openFilterMenu}
        aria-haspopup="menu"
        aria-expanded={filterMenu !== null}
        aria-label={`分类：${scopeLabel}`}
      >
        <span className="topbar-menu-btn-label">{scopeLabel}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>

      <div className="topbar-spacer" />

      {/* 右端统一成一个操作区：排序、视图切换、导入、设置间距一致，读起来是一组 */}
      <div className="topbar-actions">
        <button
          ref={sortRef}
          className="topbar-menu-btn topbar-sort"
          onClick={openSortMenu}
          aria-haspopup="menu"
          aria-expanded={sortMenu !== null}
          aria-label={`排序方式：${sortLabel}`}
        >
          <span className="topbar-menu-btn-label">{sortLabel}</span>
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
        </button>

        <div className="segmented" role="group" aria-label="视图切换">
          <button
            className="segmented-item"
            aria-pressed={view === "grid"}
            aria-label="网格视图"
            data-tip="网格视图"
            onClick={() => onView("grid")}
          >
            <LayoutGrid size={16} strokeWidth={2} />
          </button>
          <button
            className="segmented-item"
            aria-pressed={view === "list"}
            aria-label="列表视图"
            data-tip="列表视图"
            onClick={() => onView("list")}
          >
            <List size={16} strokeWidth={2} />
          </button>
        </div>

        {canSelect && (
          <button
            className="icon-btn topbar-select"
            onClick={onSelectMode}
            aria-label="多选"
            data-tip="多选"
          >
            <ListChecks size={18} strokeWidth={2} />
          </button>
        )}

        {/* 导入是整个界面上唯一的写操作，视觉权重应该压过一切次级控件 */}
        <button
          className="btn btn-primary topbar-import"
          onClick={onImport}
          disabled={importing}
          aria-label={importing ? "导入中" : "导入书籍"}
        >
          <Plus size={15} strokeWidth={2.4} aria-hidden="true" />
          {/*
           * 窄屏只留图标（UI_REVIEW H4 / P2-6）：393px 下「导入」两个字要吃掉约 30px，
           * 而搜索框已经被压到 140px。导入在移动端还有空状态入口和拖拽层兜着，
           * 把这段宽度还给搜索更划算。标签包一层 span 而不是靠 font-size:0——
           * 后者会让按钮宽度不跟着文字收，等于没省空间。
           */}
          <span className="topbar-import-label">{importing ? "导入中…" : "导入"}</span>
        </button>

        <button
          className="icon-btn topbar-settings"
          onClick={onOpenSettings}
          aria-label="打开设置"
          aria-expanded={settingsOpen}
          data-active={settingsOpen || undefined}
          data-tip="设置 · Ctrl+,"
        >
          <Settings size={20} strokeWidth={2} />
        </button>
      </div>

      {filterMenu && (
        <MenuShell
          x={filterMenu.x}
          y={filterMenu.y}
          width={168}
          height={FILTER_ITEMS.length * 32 + 14}
          label="选择分类"
          onClose={() => setFilterMenu(null)}
        >
          {FILTER_ITEMS.map((item) => (
            <button
              key={item.value}
              role="menuitemradio"
              aria-checked={filter === item.value}
              className="filter-item"
              onClick={() => {
                onFilter(item.value);
                setFilterMenu(null);
              }}
            >
              <span className="filter-item-label">{item.label}</span>
              {filter === item.value && (
                <Check size={14} strokeWidth={2.4} className="filter-item-check" />
              )}
            </button>
          ))}
        </MenuShell>
      )}

      {sortMenu && (
        <MenuShell
          x={sortMenu.x}
          y={sortMenu.y}
          width={168}
          height={SORT_ITEMS.length * 32 + 14}
          label="选择排序方式"
          onClose={() => setSortMenu(null)}
        >
          {SORT_ITEMS.map((item) => (
            <button
              key={item.value}
              role="menuitemradio"
              aria-checked={sort === item.value}
              className="filter-item"
              onClick={() => {
                onSort(item.value);
                setSortMenu(null);
              }}
            >
              <span className="filter-item-label">{item.label}</span>
              {sort === item.value && (
                <Check size={14} strokeWidth={2.4} className="filter-item-check" />
              )}
            </button>
          ))}
        </MenuShell>
      )}
    </header>
  );
}
