import {
  BookOpen,
  Clock,
  FileText,
  FileType,
  Folder,
  Images,
  Library,
  Package,
  Tag,
} from "lucide-react";
import type { ShelfFilter } from "../../lib/filters";
import type { TagCount } from "../../api";

interface Props {
  filter: ShelfFilter;
  onChange: (filter: ShelfFilter) => void;
  counts: Record<ShelfFilter, number>;
  /** 添加书库目录：与设置 → 书库里的「添加目录」同一入口 */
  onAddFolder: () => void;
  /** 标签与「分类」正交，可以叠加在分类之上一起筛 */
  tags: TagCount[];
  /** 当前选中的标签；null 表示没按标签筛 */
  tag: string | null;
  onTag: (tag: string | null) => void;
}

interface Item {
  key: ShelfFilter;
  label: string;
  icon: typeof Library;
}

/**
 * 侧栏分两块面板：
 * - 视图：全部 / 最近阅读（跨格式的切面）
 * - 格式：按容器族互斥划分，一本书只出现一次；面板底部是固定的「添加目录」
 *
 * 设置入口不在这里：抽屉从**右侧**滑出，按钮却在左下角，位置对不上。
 * 现在它回到顶栏最右（与抽屉同侧），点击后从按钮下方长出面板。
 */
const PRIMARY: Item[] = [
  { key: "all", label: "全部", icon: Library },
  { key: "recent", label: "最近阅读", icon: Clock },
];

const FORMATS: Item[] = [
  { key: "text", label: "文本", icon: FileText },
  { key: "ebook", label: "电子书", icon: BookOpen },
  { key: "doc", label: "文档", icon: FileType },
  { key: "comic", label: "漫画", icon: Images },
  { key: "pdf", label: "PDF", icon: Package },
];

/** 4.2 侧栏：标准 240px，紧凑断点折叠为 64px 图标栏。 */
export default function Sidebar({
  filter,
  onChange,
  counts,
  onAddFolder,
  tags,
  tag,
  onTag,
}: Props) {
  const renderItem = ({ key, label, icon: Icon }: Item) => (
    <button
      key={key}
      className="sidebar-item"
      aria-current={filter === key}
      onClick={() => onChange(key)}
      title={label}
    >
      <Icon size={20} strokeWidth={2} aria-hidden="true" />
      <span className="sidebar-label">{label}</span>
      <span className="sidebar-count">{counts[key]}</span>
    </button>
  );

  return (
    <nav className="sidebar" aria-label="书架分类">
      <section className="side-panel" aria-label="视图">
        {PRIMARY.map(renderItem)}
      </section>

      {/*
        标签块只在有标签时出现：没有标签的用户看不到一个永远空着的分区，
        有标签的用户则多一条自己建的入口。再点一次已选中的标签即取消。
      */}
      {tags.length > 0 && (
        <section className="side-panel" aria-label="按标签筛选">
          <div className="side-panel-scroll">
            {tags.map((item) => (
              <button
                key={item.name}
                className="sidebar-item"
                aria-current={tag === item.name}
                onClick={() => onTag(tag === item.name ? null : item.name)}
                title={`标签：${item.name}`}
              >
                <Tag size={20} strokeWidth={2} aria-hidden="true" />
                <span className="sidebar-label">{item.name}</span>
                <span className="sidebar-count">{item.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="side-panel side-panel-grow" aria-label="按格式筛选">
        <div className="side-panel-scroll">{FORMATS.map(renderItem)}</div>
        <div className="side-panel-foot">
          <button className="sidebar-item" onClick={onAddFolder} title="添加书库目录">
            <Folder size={20} strokeWidth={2} aria-hidden="true" />
            <span className="sidebar-label">添加目录</span>
          </button>
        </div>
      </section>

    </nav>
  );
}
