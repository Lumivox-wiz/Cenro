import { CheckSquare, Download, EyeOff, Square, X } from "lucide-react";

/**
 * 多选动作条。
 *
 * 贴在书架底部，只在选择模式下出现。做成独立组件是因为主书架与隐私书架
 * 用的是同一套多选语义（同一份「取消 / 全选 / 执行」），复制两份迟早走散。
 */
interface Props {
  /** 已选本数 */
  count: number;
  /** 当前列表里可选的总数，用于「全选 / 取消全选」 */
  total: number;
  /** 主操作文案与方向：移入隐私 / 移出隐私 */
  actionLabel: string;
  onAction: () => void;
  /** 次要操作（批量导出）：不给就只显示主操作 */
  secondary?: { label: string; onAction: () => void; busy?: boolean };
  onSelectAll: () => void;
  onClearAll: () => void;
  onExit: () => void;
  /** 执行中禁用按钮，避免连点触发两批 */
  busy?: boolean;
}

export default function SelectionBar({
  count,
  total,
  actionLabel,
  onAction,
  secondary,
  onSelectAll,
  onClearAll,
  onExit,
  busy = false,
}: Props) {
  const allSelected = total > 0 && count >= total;

  return (
    <div className="selection-bar" role="toolbar" aria-label="批量操作">
      <button className="icon-btn" onClick={onExit} aria-label="退出多选" title="退出多选">
        <X size={18} strokeWidth={2} />
      </button>

      <span className="selection-count">已选 {count} 本</span>

      <button
        className="selection-toggle"
        onClick={allSelected ? onClearAll : onSelectAll}
        aria-pressed={allSelected}
      >
        {allSelected ? <CheckSquare size={14} strokeWidth={2} /> : <Square size={14} strokeWidth={2} />}
        {allSelected ? "取消全选" : "全选"}
      </button>

      {secondary && (
        <button
          className="btn btn-secondary selection-action"
          onClick={secondary.onAction}
          disabled={count === 0 || secondary.busy}
        >
          <Download size={15} strokeWidth={2} />
          {secondary.label}
        </button>
      )}

      <button
        className="btn btn-primary selection-action"
        onClick={onAction}
        disabled={count === 0 || busy}
      >
        <EyeOff size={15} strokeWidth={2} />
        {actionLabel}
      </button>
    </div>
  );
}
