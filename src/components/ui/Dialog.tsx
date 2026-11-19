import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * 宽版：给许可全文这类硬折行的长文本用。
   * 默认 440px 会把 GPL 的 75 字符行压成每行十几个字。
   */
  wide?: boolean;
  /**
   * 第三个动作，排在取消左侧。
   * 用于「文件已丢失」这类必须给出两条出路的场景（UX §5.3）：
   * 主操作是抢救（重新定位），次操作是放弃（从书架移除）。
   */
  extraLabel?: string;
  danger?: boolean;
  /** 纯提示型对话框（例如导入失败明细）：只留一个「知道了」，不给「取消」 */
  hideCancel?: boolean;
  onConfirm?: () => void;
  onExtra?: () => void;
  onCancel: () => void;
}

/** 5.8：危险操作二次确认，主按钮为 Danger；Esc 关闭（7.2 最高优先级）。 */
export default function Dialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "取消",
  extraLabel,
  danger = false,
  hideCancel = false,
  wide = false,
  onConfirm,
  onExtra,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  /*
   * 用 portal 挂到 body。
   *
   * 设置抽屉带 .glass，backdrop-filter 会创建包含块，导致 position: fixed
   * 的遮罩不再是「相对视口」，而是相对抽屉——对话框被挤进右侧那 360px 窄栏，
   * 许可全文这种硬折行长文本会被压成每行十几个字。挂到 body 才回到视口。
   */
  return createPortal(
    <div className="overlay overlay-dialog" onClick={onCancel}>
      <div
        className={wide ? "dialog dialog-wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>
        {children && <div className="dialog-text">{children}</div>}
        <div className="dialog-actions">
          {extraLabel && (
            <button className="btn btn-ghost dialog-extra" onClick={onExtra}>
              {extraLabel}
            </button>
          )}
          {!hideCancel && (
            <button className="btn btn-secondary" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          {confirmLabel && (
            <button
              className={danger ? "btn btn-danger" : "btn btn-primary"}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
