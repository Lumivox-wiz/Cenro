/**
 * 扫描件文字索引的前端一半。
 *
 * 分工：**前端负责把页面画成图**（Rust 侧没有 PDF 引擎，pdf.js 就在这儿），
 * **Rust 负责认字与落库**（那边的引擎常驻，一页几百毫秒）。
 *
 * 之所以逐页来回而不是整本一次：单页失败不拖垮整本，进度能按页涨，
 * 用户中途退出时已完成的部分还在库里，下次接着建。
 */
import "../styles/ocr.css";
import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";

export type OcrStatus = {
  total: number;
  done: number;
  /** idle / running / done / cancelled / failed */
  status: string;
  /** 库里已落库的页数 */
  pages: number;
};

export type OcrHit = { page: number; snippet: string };

export type OcrInfo = { ready: boolean; bytes: number; engine: string };

export const ocrApi = {
  info: () => invoke<OcrInfo>("ocr_info"),
  status: (id: string) => invoke<OcrStatus>("ocr_status", { id }),
  begin: (id: string, total: number) => invoke<OcrStatus>("ocr_begin", { id, total }),
  page: (id: string, page: number, jpeg: string) =>
    invoke<{ chars: number; done: number }>("ocr_page", { id, page, jpeg }),
  finish: (id: string, status: string) => invoke<OcrStatus>("ocr_finish", { id, status }),
  search: (id: string, query: string) => invoke<OcrHit[]>("ocr_search", { id, query }),
  clear: (id: string) => invoke<void>("ocr_clear", { id }),
};

/**
 * 把一页渲染成 JPEG（base64，不含 `data:` 前缀）。
 *
 * 200 dpi 是实测出来的性价比点：再高只慢不快好，再低小字会掉。
 * 渲染完立刻把 canvas 尺寸清零，否则一本几百页跑下来位图会把内存吃光。
 */
export async function renderPageJpeg(
  doc: PDFDocumentProxy,
  pageNumber: number,
  dpi = 200,
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("拿不到 2D 上下文");

  // 扫描件的底通常是白纸，先铺白再画，避免透明区域在 JPEG 里变黑
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const task = page.render({ canvas, viewport });
  try {
    await task.promise;
  } finally {
    page.cleanup();
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export type BuildOptions = {
  doc: PDFDocumentProxy;
  bookId: string;
  /** 每完成一页回调一次，用于面板上的进度 */
  onProgress?: (done: number, total: number) => void;
  /** 置为 true 时在下一页之前停下，已完成的页保留 */
  isCancelled?: () => boolean;
};

/**
 * 建整本索引。返回最终状态；中途取消返回 `cancelled`。
 *
 * 单页出错不中断：那页留空（搜索里就是没命中），继续下一页——
 * 扫描件里偶尔有整页广告或纯图，为一页放弃整本不值得。
 */
export async function buildIndex({
  doc,
  bookId,
  onProgress,
  isCancelled,
}: BuildOptions): Promise<OcrStatus> {
  const total = doc.numPages;
  await ocrApi.begin(bookId, total);
  onProgress?.(0, total);

  for (let n = 1; n <= total; n += 1) {
    if (isCancelled?.()) {
      return ocrApi.finish(bookId, "cancelled");
    }
    try {
      const jpeg = await renderPageJpeg(doc, n);
      const res = await ocrApi.page(bookId, n - 1, jpeg);
      onProgress?.(res.done, total);
    } catch {
      // 这一页失败就跳过，进度按「已落库页数」走，不假装成功
      onProgress?.(n, total);
    }
  }
  return ocrApi.finish(bookId, "done");
}

/** 这本 PDF 是不是「基本上没有文字层」——判据与搜索面板的提示一致。 */
export function looksScanned(charCount: number, pagesSampled: number): boolean {
  if (pagesSampled <= 0) return false;
  return charCount / pagesSampled < 40;
}
