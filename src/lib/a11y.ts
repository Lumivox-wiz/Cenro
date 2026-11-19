/**
 * 阅读器工具栏的无障碍辅助。
 *
 * 四个阅读器（TXT / EPUB / 漫画 / PDF）各有自己的工具栏节点，走 class 选择器
 * 而不是层层传 ref，可以让它们共用同一份实现，不会因为某个模块漏接而出现
 * 「有的格式能按 F6、有的不能」。
 */

/**
 * F6：在顶栏与底栏之间循环聚焦（UI §7.2）。
 *
 * - 焦点不在任一栏内时，落到顶栏第一个可聚焦控件；
 * - 在顶栏时切到底栏，在底栏时切回顶栏；
 * - Shift + F6 反向。
 *
 * 调用方需保证工具栏已从 data-hidden 切到可见态，否则焦点框不可见。
 * 这里等一帧再聚焦，给样式切换留出时间。
 */
export function focusChromeBand(shift: boolean): void {
  const topbar = document.querySelector<HTMLElement>(".reader-topbar");
  const bottombar = document.querySelector<HTMLElement>(".reader-bottombar");

  const inTop = !!topbar?.contains(document.activeElement);
  const inBottom = !!bottombar?.contains(document.activeElement);

  let band: "top" | "bottom";
  if (inTop) band = shift ? "top" : "bottom";
  else if (inBottom) band = shift ? "bottom" : "top";
  else band = shift ? "bottom" : "top";

  const host = band === "top" ? topbar : bottombar;
  if (!host) return;

  const selector =
    band === "top"
      ? "button:not([disabled])"
      : "input:not([disabled]), button:not([disabled])";

  requestAnimationFrame(() => {
    host.querySelector<HTMLElement>(selector)?.focus();
  });
}
