import { epubApi, fileUrl } from "../api";

/** 把相对路径拼到章节所在目录，消掉 ./ 与 ../ */
function resolveRelative(baseDir: string, src: string): string {
  const clean = src.split("#")[0].split("?")[0];
  const parts = baseDir.split("/").filter(Boolean);
  for (const segment of clean.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * EPUB 里的 <img src> 指向 zip 内相对路径，webview 无法直接加载。
 * 这里把每张图解压到本地缓存并改写为 asset URL。
 *
 * 必须先做 sanitize 再做这一步：清理阶段只处理标签与属性，
 * 改写阶段只替换 src，职责不重叠。
 */
export async function rewriteImages(
  html: string,
  chapterHref: string,
  bookId: string,
): Promise<string> {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const baseDir = chapterHref.includes("/")
    ? chapterHref.slice(0, chapterHref.lastIndexOf("/") + 1)
    : "";

  const images = Array.from(doc.body.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src) return;

      const lower = src.toLowerCase();
      if (
        lower.startsWith("data:") ||
        lower.startsWith("http://") ||
        lower.startsWith("https://") ||
        lower.startsWith("blob:")
      ) {
        return;
      }

      const resolved = resolveRelative(baseDir, src);
      try {
        const path = await epubApi.resource(bookId, resolved);
        const url = fileUrl(path);
        if (url) img.setAttribute("src", url);
        else img.removeAttribute("src");
      } catch {
        // 资源缺失不影响正文，去掉 src 即可
        img.removeAttribute("src");
      }
    }),
  );

  return doc.body.innerHTML;
}
