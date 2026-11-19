import { useEffect, useRef } from "react";
import { X } from "lucide-react";

interface Props {
  /** 注释正文（已折过空白） */
  text: string;
  /** 点击处的视口坐标，用来把卡片贴在手指旁边 */
  anchor: { left: number; top: number; bottom: number; right: number };
  onClose: () => void;
}

/**
 * 脚注弹窗。
 *
 * 存在的理由很单纯：脚注链接一点就跳走，读两行再找回原来的位置，
 * 是长篇阅读里最扫兴的动作之一。弹出来看一眼就够了。
 *
 * 定位跟着点击处走，下方放不下就翻到上方；宽度与最大高度都夹在视口内，
 * 手机上一行字挤成三行也不会溢出屏幕。
 */
export default function FootnoteCard({ text, anchor, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  // 点卡片以外的地方收起
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  /*
   * 卡片是按视口坐标贴上去的，正文一滚就和标记对不上了，直接收起。
   * 用捕获阶段的 scroll：滚动发生在正文容器里，不捕获就收不到。
   */
  useEffect(() => {
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const width = Math.min(340, window.innerWidth - 24);
  const below = anchor.bottom < window.innerHeight - 160;
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
  const style: React.CSSProperties = {
    width,
    left,
    top: below ? anchor.bottom + 8 : anchor.top - 8,
    transform: below ? undefined : "translateY(-100%)",
    maxHeight: Math.min(window.innerHeight * 0.45, 320),
  };

  return (
    <div
      ref={cardRef}
      className="footnote-card"
      style={style}
      role="dialog"
      aria-label="脚注"
      // 卡片内的点击不要落到舞台分区上（那会翻页）
      onClick={(e) => e.stopPropagation()}
    >
      <p className="footnote-text">{text}</p>
      <button className="footnote-close" onClick={onClose} aria-label="关闭脚注">
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
