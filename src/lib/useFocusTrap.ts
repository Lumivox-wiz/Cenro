import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * UX §8.1：抽屉打开时焦点陷阱在抽屉内，关闭后回到触发元素。
 *
 * - Tab / Shift+Tab 出界时绕回抽屉首尾元素；
 * - 挂载时把焦点收进抽屉（优先输入框，其次第一个可聚焦项）；
 * - 卸载时把焦点还给打开抽屉前所在的元素。
 *
 * 抽屉都是条件渲染（`{open && <aside/>}`），所以 active 一般恒为 true；
 * 设置抽屉内有二次确认对话框时会临时置 false——对话框自己接管键盘。
 */
export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    // 容器兜底可聚焦：没有可聚焦子元素时 Tab 也不至于掉出
    el.tabIndex = -1;

    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const raf = requestAnimationFrame(() => {
      const first = el.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");
      (first ?? el).focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (list.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const current = document.activeElement;
      const inside = current instanceof Node && el.contains(current);
      if (e.shiftKey) {
        if (!inside || current === list[0]) {
          e.preventDefault();
          list[list.length - 1].focus();
        }
      } else {
        if (!inside || current === list[list.length - 1]) {
          e.preventDefault();
          list[0].focus();
        }
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      // 回到触发元素；触发元素若已卸载（如阅读页退出），focus 静默无效果
      prev?.focus();
    };
  }, [active]);

  return ref;
}
