import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { logError } from "../../lib/log";

interface Props {
  doc: PDFDocumentProxy;
  /** 0 基页码 */
  index: number;
  scale: number;
  rotation: number;
  /** 滚动模式下进入视口才渲染 */
  lazy?: boolean;
  onVisible?: (index: number) => void;
}

/**
 * 单页渲染单元。分页模式直接渲染，滚动模式交给 IntersectionObserver，
 * 离屏页只占位不建 canvas —— 这是 720 页文档内存不爆的关键。
 */
export default function PdfPage({
  doc,
  index,
  scale,
  rotation,
  lazy = false,
  onVisible,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!lazy) {
      setVisible(true);
      return;
    }
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setVisible(true);
          onVisible?.(index);
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [lazy, index, onVisible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;

        const viewport = page.getViewport({ scale, rotation });
        setSize({ w: viewport.width, h: viewport.height });

        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const hiRes = page.getViewport({ scale: scale * dpr, rotation });
        canvas.width = Math.floor(hiRes.width);
        canvas.height = Math.floor(hiRes.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const renderTask = page.render({ canvas, viewport: hiRes });
        task = renderTask;
        await renderTask.promise;
        page.cleanup();
      } catch (e) {
        if (!(e instanceof Error) || !/cancel/i.test(e.message)) {
          // 单页失败不打断整本，保留占位；同时写进运行日志，排查时不用再靠猜
          console.warn("PDF 页渲染失败", index, e);
          logError(`PDF 第 ${index + 1} 页渲染失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, index, scale, rotation]);

  return (
    <div
      className="pdf-page"
      ref={wrapRef}
      style={size ? { width: `${size.w}px`, height: `${size.h}px` } : undefined}
    >
      {visible ? (
        <canvas ref={canvasRef} className="pdf-canvas" />
      ) : (
        <div className="pdf-page-placeholder" />
      )}
    </div>
  );
}
