/**
 * EPUB 章节是可信度未知的 XHTML，等同不可信输入。
 * 这里移除脚本类元素与事件属性后再交给 React 渲染。
 *
 * 说明：UI_SPEC 5 章要求 iframe + sandbox 隔离；此处选择 DOM 清理 + 直接渲染，
 * 原因是分页需要与 TXT 共用同一套 CSS columns 测量，iframe 内无法直接测量列宽。
 * 偏离已登记于 UI_SPEC 附录 A。
 */
const DANGEROUS_TAGS = ["script", "iframe", "object", "embed", "link", "meta"];

export function sanitizeXhtml(raw: string): { title: string; html: string } {
  const parsed = new DOMParser().parseFromString(raw, "application/xhtml+xml");
  const failed = parsed.querySelector("parsererror");
  const doc = failed
    ? new DOMParser().parseFromString(raw, "text/html")
    : parsed;

  doc.querySelectorAll(DANGEROUS_TAGS.join(",")).forEach((node) => {
    // 保留 meta charset 之外的一律移除；link 只留非样式表也无意义，直接清掉
    node.remove();
  });

  doc.querySelectorAll("style").forEach((node) => {
    // 去掉 @import 与外部 url()，避免绕过资源白名单
    node.textContent = (node.textContent ?? "").replace(
      /@import[^;]+;|url\((?!['"]?data:)[^)]*\)/gi,
      "",
    );
  });

  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      const value = attr.value.trim().toLowerCase();
      if (
        (name === "href" || name === "src" || name === "xlink:href") &&
        value.startsWith("javascript:")
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });

  const body = doc.querySelector("body");
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  return { title, html: body?.innerHTML ?? raw };
}
