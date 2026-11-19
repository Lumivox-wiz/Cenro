import type { BookType } from "../../types";
import type { ImportPhase } from "../../lib/mobileImport";
import TitleCover from "./TitleCover";

/**
 * 导入中的占位条目。
 *
 * UX §5.2 要求「触发导入立即在书架插入占位卡片，标题=文件名，封面=格式占位图，
 * 状态=处理中」，成功后再原地换成正式卡片。这里用一个独立的轻量类型，
 * 不复用 Book——它还没有 id、没有进度，也不该响应打开与右键。
 *
 * 封面同样走书名文字封面：导入完成时的正式卡片也用它，颜色因此不会跳变。
 */
export interface PendingImport {
  key: string;
  name: string;
  type: BookType;
  phase: ImportPhase;
  error?: string;
}

function phaseLabel(phase: ImportPhase): string {
  if (phase === "failed") return "导入失败";
  // 文件已写入磁盘但还没扫描入库
  if (phase === "done") return "解析中…";
  return "导入中…";
}

/** 去掉扩展名，与入库后从文件名推导的标题同源，封面配色才能对上 */
function stem(name: string): string {
  return name.replace(/\.[^.\\/]+$/, "");
}

interface Props {
  item: PendingImport;
  /** 网格卡片 / 列表行 */
  variant?: "grid" | "row";
}

export default function ImportCard({ item, variant = "grid" }: Props) {
  const label = phaseLabel(item.phase);
  const title = item.error ? `${item.name}：${item.error}` : item.name;
  const coverTitle = stem(item.name);

  if (variant === "row") {
    return (
      <div className="shelf-row is-pending" data-phase={item.phase} title={title}>
        <div className="shelf-row-cover">
          <TitleCover title={coverTitle} variant="thumb" />
        </div>
        <div className="row-cell row-title">{item.name}</div>
        <div className="row-cell" data-phase={item.phase}>
          {label}
        </div>
        <div className="row-cell" />
        <div className="row-cell" />
      </div>
    );
  }

  return (
    <div className="book-card is-pending" data-phase={item.phase} title={title}>
      {/* 与正式卡片同一套卡面结构，导入完成时布局不跳动 */}
      <div className="card-target card-target-static">
        <div className="card-cover">
          <TitleCover title={coverTitle} />
        </div>
        <div className="card-title">{item.name}</div>
        <div className="card-sub" data-phase={item.phase}>
          {label}
        </div>
      </div>
    </div>
  );
}
