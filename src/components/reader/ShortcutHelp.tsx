import { useEffect } from "react";
import { X } from "lucide-react";
import { IS_MOBILE } from "../../lib/platform";

export interface HelpRow {
  /** 这一行的作用 */
  label: string;
  /** 键位或按钮位置 */
  hint: string;
}

export interface HelpSection {
  title: string;
  /** keys 用 kbd 样式渲染；buttons 用弱化文本，避免把按钮名伪装成键位 */
  kind: "keys" | "buttons";
  rows: HelpRow[];
}

interface Props {
  open: boolean;
  sections: HelpSection[];
  onClose: () => void;
}

/**
 * 快捷键与工具栏提示浮层。挂在阅读器外壳上，用 capture 阶段拦截 Esc，
 * 避免与阅读页自身的 Esc 优先级栈冲突。
 */
export default function ShortcutHelp({ open, sections, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  /*
   * 手机上没物理键盘，整段键位只是占屏。工具栏部分保留——
   * 那部分讲的是「哪个按钮在哪」，触屏下反而更需要。
   */
  const visible = IS_MOBILE ? sections.filter((s) => s.kind !== "keys") : sections;

  return (
    <>
      <div className="shortcut-help-backdrop" onClick={onClose} />
      <div className="shortcut-help" role="dialog" aria-label="操作提示">
        <div className="shortcut-help-head">
          <span className="section-title">操作提示</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭操作提示">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {visible.map((section) => (
          <div className="shortcut-help-section" key={section.title}>
            <div className="shortcut-help-section-title">{section.title}</div>
            {section.rows.map((row) => (
              <div className="shortcut-help-row" key={`${row.label}-${row.hint}`}>
                <span>{row.label}</span>
                {section.kind === "keys" ? (
                  <kbd>{row.hint}</kbd>
                ) : (
                  <span className="shortcut-help-hint">{row.hint}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
