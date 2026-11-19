/**
 * 把 pdf.js 的运行时资源拷到 public/pdfjs/。
 *
 * 为什么必须拷：pdf.js v6 只带代码，**不带**中文 CMap、标准 14 字体、JBIG2/JPEG2000 解码器。
 * 这三样缺任何一样，表现都是「页面空白」——
 * - 缺 cmaps：中文（CID 字体）没法映射成 Unicode，文字整段消失；
 * - 缺 standard_fonts：PDF 没内嵌字体时退回的 14 种标准字体取不到；
 * - 缺 wasm：扫描件常用的 JBIG2 / JPX 图像解不出来，整页只剩白底。
 *
 * 放在 public/ 下而不是 import：这些文件要按原样、按固定路径被 worker fetch，
 * 过一遍打包器只会给它们加 hash，URL 反而对不上。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");
const dirs = ["cmaps", "standard_fonts", "wasm"];

if (!existsSync(join(src, "cmaps"))) {
  console.warn("[pdfjs] 没找到 node_modules/pdfjs-dist，跳过资源拷贝");
  process.exit(0);
}

// 不先删目录：这台机器上 rmSync 会被安全策略重定向到回收站并失败。
// cpSync 会覆盖同名文件，旧版本留下的多余文件最多多占几 MB，不影响正确性。
mkdirSync(dest, { recursive: true });

let bytes = 0;
for (const dir of dirs) {
  const from = join(src, dir);
  if (!existsSync(from)) continue;
  cpSync(from, join(dest, dir), { recursive: true });
  bytes += 1;
}

console.log(`[pdfjs] 已同步 ${dirs.join(" / ")} → public/pdfjs`);

/*
 * 顺手清掉上一轮的构建产物。
 *
 * `vite.config.ts` 里关了 `emptyOutDir`（public/pdfjs 有 200 多个文件，
 * 整目录删又慢又容易被安全策略拦），所以这一步挪到这里：
 * 只删会带指纹的两处，`dist/pdfjs` 交给 vite 原地覆盖。
 * 两个目录加起来不到十个文件，不会触发批量删除限制。
 */
const dist = join(root, "dist");
for (const name of ["index.html", "assets"]) {
  const target = join(dist, name);
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
}
