/**
 * 版心（单列）宽度计算。
 *
 * 坑：Android WebView 首帧会先用默认尺寸（约 800×600）布局，
 * 此时容器 `clientWidth` 可能是 704 而不是真实的 388，
 * 直接用它算版心，会得到一个比屏幕还宽的列宽；页窗口居中后
 * 左右各溢出一截，正文两侧被裁掉。
 *
 * 因此同时取「容器实测宽」「文档宽」「窗口宽」的最小值 —— 三者中
 * 只要有一个是当前真实视口，结果就不会宽于屏幕。
 */
/** 太窄会挤成一列几个字，低于这个值就不再收 */
const MIN_WIDTH = 260;

export function resolvePageWidth(
  viewport: HTMLElement | null,
  prefWidth: number,
  /** 左右各留多少页边距（px）。分页宽度是排版依据，页边距必须在这里扣掉， */
  /** 而不是给正文加 padding——padding 不参与 column 宽度计算，会让末列溢出。 */
  margin = 0,
): number {
  const candidates = [
    viewport?.clientWidth ?? 0,
    document.documentElement.clientWidth,
    window.innerWidth,
  ].filter((n) => Number.isFinite(n) && n > 0);

  // 全都拿不到（极早期）时退回偏好值，宁可窄一帧，也别算出更宽的值
  if (candidates.length === 0) return prefWidth;

  const available = Math.min(...candidates) - Math.max(0, margin) * 2;
  return Math.max(MIN_WIDTH, Math.min(prefWidth, available));
}
