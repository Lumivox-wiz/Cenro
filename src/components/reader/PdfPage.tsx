import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { logError } from "../../lib/log";
import type { AnnotationKind } from "../../api";

/** 画在页面上的一条标注：矩形已是归一化值（0–1），与缩放无关 */
export interface PageHighlight {
  id: string;
  kind: AnnotationKind;
  rects: [number, number, number, number][];
}

interface Props {
  doc: PDFDocumentProxy;
  /** 0 基页码 */
  index: number;
  scale: number;
  rotation: number;
  /** 滚动模式下进入视口才渲染 */
  lazy?: boolean;
  onVisible?: (index: number) => void;
  /** 这一页上的划线 / 批注 */
  highlights?: PageHighlight[];
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
  highlights,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
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
        if (cancelled) return;

        /*
         * 文本层：透明文字叠在 canvas 上，只为「能选」。
         *
         * 没有它，PDF 里选不了字，也就没法划线——pdf.js 自己不做选择，
         * 它只把每段文字的位置算好塞进 DOM，选中与取矩形交给浏览器。
         * 这层必须与 canvas 同尺寸同位置，否则选出来的框会偏。
         */
        const container = textRef.current;
        if (container) {
          const textContent = await page.getTextContent();
          if (cancelled) return;
          container.replaceChildren();
          // 文本层的尺寸与字号都由这几个变量算出来（见 reader.css 的说明）
          container.style.setProperty("--total-scale-factor", String(viewport.scale));
          container.style.setProperty("--scale-round-x", "1px");
          container.style.setProperty("--scale-round-y", "1px");
          const { TextLayer } = await import("pdfjs-dist");
          const layer = new TextLayer({ textContentSource: textContent, container, viewport });
          await layer.render();
        }
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
      data-page={index}
      style={size ? { width: `${size.w}px`, height: `${size.h}px` } : undefined}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="pdf-canvas" />
          <div className="pdf-text-layer" ref={textRef} />
          {highlights && highlights.length > 0 && (
            <div className="pdf-hl-layer" aria-hidden="true">
              {highlights.flatMap((item) =>
                item.rects.map((r, i) => (
                  <span
                    key={`${item.id}-${i}`}
                    className={`pdf-hl pdf-hl-${item.kind}`}
                    style={{
                      left: `${r[0] * 100}%`,
                      top: `${r[1] * 100}%`,
                      width: `${Math.max(0, r[2] - r[0]) * 100}%`,
                      height: `${Math.max(0, r[3] - r[1]) * 100}%`,
                    }}
                  />
                )),
              )}
            </div>
          )}
        </>
      ) : (
        <div className="pdf-page-placeholder" />
      )}
    </div>
  );
}
