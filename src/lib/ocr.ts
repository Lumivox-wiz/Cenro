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
import { extractFlatText } from "./pdfText";

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

export type OcrBlock = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrBlocks = { width: number; height: number; blocks: OcrBlock[] };

export const ocrApi = {
  info: () => invoke<OcrInfo>("ocr_info"),
  status: (id: string) => invoke<OcrStatus>("ocr_status", { id }),
  begin: (id: string, total: number) => invoke<OcrStatus>("ocr_begin", { id, total }),
  page: (id: string, page: number, jpeg: string) =>
    invoke<{ chars: number; done: number }>("ocr_page", { id, page, jpeg }),
  finish: (id: string, status: string) => invoke<OcrStatus>("ocr_finish", { id, status }),
  search: (id: string, query: string) => invoke<OcrHit[]>("ocr_search", { id, query }),
  clear: (id: string) => invoke<void>("ocr_clear", { id }),
  /** 带坐标的识别（漫画用）：不落库，纯一次性的结果 */
  blocks: (id: string, jpeg: string, vertical: boolean) =>
    invoke<OcrBlocks>("ocr_blocks", { id, jpeg, vertical }),
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

/**
 * 把一张已经显示出来的图片（漫画页）转成 JPEG base64。
 *
 * 直接 `fetch(src).blob()` 再解码：drawImage 到 canvas 在跨源时会污染画布，
 * `toDataURL` 直接抛异常。asset 协议同源，才能这样走。
 */
export async function imageUrlToJpeg(url: string, maxEdge = 1600): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读取图片失败：${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("拿不到 2D 上下文");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
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
 * 两个「不做什么」比「做什么」更重要：
 * - **能搜的页直接跳过**。混合型 PDF（论文、说明书）里大半页本来就有文字层，
 *   再识别一遍既费时又会让同一个词出现两次。判据是「每页 ≥ 40 字**且**不是乱码」——
 *   知网那类扫描件的自动 OCR 层全是一片全角字母，字数够但搜不到，必须照样识别。
 * - **单页出错不中断**。那页留空，继续下一页——扫描件里偶尔夹整页广告或纯图，
 *   为一页放弃整本不值得。
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

  const TEXT_LAYER_MIN = 40;

  for (let n = 1; n <= total; n += 1) {
    if (isCancelled?.()) {
      return ocrApi.finish(bookId, "cancelled");
    }
    try {
      // 先问 pdf.js 这页有没有文字层：有就不用识别，省时也免得重复命中
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const flat = extractFlatText(
        content.items as unknown as Array<{ str?: string; hasEOL?: boolean }>,
      ).flat;
      page.cleanup();
      // 有文字层且不像噪声才跳过；文字层是乱码的页照样要识别
      if (flat.trim().length >= TEXT_LAYER_MIN && !looksGarbled(flat)) {
        onProgress?.(n, total);
        continue;
      }
    } catch {
      /* 取文字层失败就照常识别，别因为探测把这一页丢掉 */
    }
    try {
      const jpeg = await renderPageJpeg(doc, n);
      await ocrApi.page(bookId, n - 1, jpeg);
      onProgress?.(n, total);
    } catch {
      // 这一页失败就跳过，进度照常前进，不假装成功
      onProgress?.(n, total);
    }
  }
  return ocrApi.finish(bookId, "done");
}

/**
 * 文字层是不是「有字但不可信」。
 *
 * 知网那类扫描件常带一版自动 OCR 的文字层，取出来是一片全角拉丁字母
 * （`－ｃａｒｂｏ打ｍａｔｅｒ`）——字数够、搜不到任何正常词，比没有文字层更坑。
 * 判据只看全角 ASCII 的占比：正经排版里全角字母极少，超过三成就当它是噪声。
 */
export function looksGarbled(text: string): boolean {
  const chars = [...text.replace(/\s+/g, "")];
  if (chars.length === 0) return false;
  let wide = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0) ?? 0;
    // 全角 ASCII（！-～）与替换符，都是「这段字没救」的信号
    if ((c >= 0xff01 && c <= 0xff5e) || c === 0xfffd) wide += 1;
  }
  return wide / chars.length > 0.3;
}

/** 这本 PDF 是不是「基本上没有文字层」——判据与搜索面板的提示一致。 */
export function looksScanned(charCount: number, pagesSampled: number): boolean {
  if (pagesSampled <= 0) return false;
  return charCount / pagesSampled < 40;
}
