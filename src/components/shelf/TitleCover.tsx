import type { CSSProperties } from "react";
import type { BookFormat, BookType } from "../../types";

/**
 * 没有可提取封图的书籍，用书名生成一块「文字封面」。
 *
 * 为什么不用图片：本地优先的应用不该为了一个占位封面去引模型或联网。
 * 纯 DOM 渲染零额外体积、不需要缓存文件，字号与配色还能随书名即时变化。
 *
 * 配色**按格式族固定**，而不是每本书随机取色：
 * 随机色占了最大视觉面积却不携带任何信息，用户扫书架时反而更乱。
 * 现在同一族（小说 / 电子书 / 漫画 / 文档 / PDF）共享一套色系，
 * 族内只做 ±6° 的微差，避免整排一模一样的色块。
 */

export type CoverFamily = "novel" | "ebook" | "comic" | "doc" | "pdf";

interface Props {
  title: string;
  author?: string | null;
  format?: BookFormat;
  /** 书籍类型参与判定：漫画型 MOBI 与文字型 MOBI 的封面不该同色 */
  kind?: BookType;
  /** thumb 用于列表行的小缩略图：竖排前三字，比单个首字更能认出是哪本 */
  variant?: "card" | "thumb";
}

/** 格式 → 封面族。族决定底色，族内再按书名微调色相。 */
export function coverFamily(format?: BookFormat, kind?: BookType): CoverFamily {
  if (kind === "pdf" || format === "pdf") return "pdf";
  if (
    kind === "comic" ||
    format === "cbz" ||
    format === "cbr" ||
    format === "cbt" ||
    format === "cb7" ||
    format === "zip" ||
    format === "folder"
  ) {
    return "comic";
  }
  if (format === "epub" || format === "mobi" || format === "azw3") return "ebook";
  if (
    format === "docx" ||
    format === "rtf" ||
    format === "mhtml" ||
    format === "ofd" ||
    format === "xlsx"
  ) {
    return "doc";
  }
  return "novel";
}

/**
 * 族的基础色相与饱和度（PDF 走纸面色，单独处理）
 *
 * v0.15.2：饱和整体压一档（原 novel 26 / ebook 22 / comic 32 / doc 16 / pdf 18）。
 * 族色携带信息、比随机取色好，但原来的强度让八张卡在密集网格里连成一片色块墙，
 * 视线先落在封面色上而不是书名上。压一档后仍能分辨五族，只是退成底噪。
 */
const FAMILY_HUE: Record<CoverFamily, { hue: number; sat: number }> = {
  novel: { hue: 214, sat: 20 },
  ebook: { hue: 170, sat: 17 },
  comic: { hue: 4, sat: 26 },
  doc: { hue: 36, sat: 13 },
  pdf: { hue: 40, sat: 14 },
};

/** 书名 → 稳定的小幅偏移，保证同族不撞色又不跳出色系 */
function wobble(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) % 997;
  }
  return (h % 13) - 6; // -6..6
}

/** 字数越多字号越小，让三行之内尽量放完整书名 */
function titleSize(title: string): number {
  const n = [...title].length;
  if (n <= 3) return 26;
  if (n <= 6) return 21;
  if (n <= 10) return 17;
  if (n <= 16) return 14;
  if (n <= 24) return 12;
  return 11;
}

export default function TitleCover({
  title,
  author,
  format,
  kind,
  variant = "card",
}: Props) {
  const family = coverFamily(format, kind);
  const { hue, sat } = FAMILY_HUE[family];
  const h = hue + wobble(title);

  const style = {
    /* 明度同步压一档（30/13/62 → 27/11/58）：底色更沉，白字对比反而更高 */
    "--cover-h1": `hsl(${h} ${sat}% 27%)`,
    "--cover-h2": `hsl(${h} ${sat + 4}% 11%)`,
    "--cover-accent": `hsl(${h} ${sat + 10}% 58%)`,
  } as CSSProperties;

  if (variant === "thumb") {
    return (
      <div
        className="title-cover"
        data-family={family}
        data-variant="thumb"
        style={style}
        aria-hidden="true"
      >
        <span className="title-cover-initial">{([...title].slice(0, 3).join("") || "?")}</span>
      </div>
    );
  }

  return (
    <div className="title-cover" data-family={family} style={style} aria-hidden="true">
      {/* 纸纹：极细斜线，让大面积纯色不至于像色块 */}
      <span className="title-cover-texture" />

      {/* PDF 走文档版式：顶部几道「文本行」，书名像落在纸页上 */}
      {family === "pdf" && (
        <span className="title-cover-doclines">
          <span />
          <span />
          <span />
        </span>
      )}

      <div className="title-cover-body">
        <span className="title-cover-rule" />
        <div className="title-cover-title" style={{ fontSize: titleSize(title) }}>
          {title}
        </div>
        {author && <div className="title-cover-author">{author}</div>}
      </div>
    </div>
  );
}
