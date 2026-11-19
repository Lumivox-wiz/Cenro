import { SHORTCUTS } from "./shared";

/** 快捷键子页：仅桌面端进入（移动端在菜单层就不渲染入口） */
export default function ShortcutsSettings() {
  return (
    <section className="drawer-section">
      <div className="kbd-list">
        {SHORTCUTS.map(([label, keys]) => (
          <div className="kbd-row" key={label}>
            <span>{label}</span>
            <kbd>{keys}</kbd>
          </div>
        ))}
      </div>
      <div className="field-hint">
        阅读页内按「?」可随时查看当前格式可用的键位。自定义快捷键在后续版本提供。
      </div>
    </section>
  );
}
