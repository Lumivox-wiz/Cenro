export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastData {
  id: number;
  text: string;
  tone: "info" | "danger";
  /** 可撤销操作：Toast 上出现一个按钮，停留时间自动延长到 5 秒 */
  action?: ToastAction;
}

interface Props {
  items: ToastData[];
  /** 点掉撤销后立刻收起该条，不必等计时器 */
  onDismiss?: (id: number) => void;
}

/** 5.8：底部居中，最多 3 条堆叠；普通 3 秒、带撤销 5 秒后消失，--z-toast。 */
export default function ToastStack({ items, onDismiss }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className="toast-item glass"
          data-tone={t.tone}
          // 容器整体 pointer-events:none（不挡下方点击），
          // 只有带操作按钮的这一条需要恢复可点，否则按钮点不动。
          data-interactive={t.action ? "true" : undefined}
        >
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                // 先收起，避免用户连点触发第二次撤销
                onDismiss?.(t.id);
                t.action?.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
