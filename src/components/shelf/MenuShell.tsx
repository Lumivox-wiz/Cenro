import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  x: number;
  y: number;
  /** 用于贴边内收。菜单项固定，宽高由调用方给常量即可 */
  width: number;
  height: number;
  label?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 右键菜单外壳：负责定位、贴边内收、点击外部关闭，以及键盘导航。
 *
 * 菜单是 fixed 定位在鼠标点上，一旦页面滚动就会与锚点错位，
 * 因此滚动（含内部容器滚动）与窗口 resize 都直接收起。
 *
 * 键盘：打开即聚焦首项，↑↓ 在可用项间循环，Esc 关闭，Tab 不外逃。
 * 这是 UX 规范 §8.2 第 5 步「Shift+F10 → 选择从书架移除」能走通的前提。
 */
export default function MenuShell({
  x,
  y,
  width,
  height,
  label,
  onClose,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const left = Math.min(x, window.innerWidth - width - 8);
    const top = Math.min(y, window.innerHeight - height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y, width, height]);

  useEffect(() => {
    const items = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
        ) ?? [],
      );

    // preventScroll：否则聚焦会触发滚动，而滚动监听会立刻把菜单关掉
    items()[0]?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = items();
        if (list.length === 0) return;
        const current = list.indexOf(document.activeElement as HTMLButtonElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = current === -1 ? 0 : (current + delta + list.length) % list.length;
        list[next]?.focus({ preventScroll: true });
        return;
      }

      if (e.key === "Tab") {
        // 菜单内循环，不让焦点跑到页面其它元素上
        e.preventDefault();
        items()[0]?.focus({ preventScroll: true });
      }
    };

    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    // 捕获阶段才能收到内部滚动容器的 scroll
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="book-menu glass"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={label}
    >
      {children}
    </div>
  );
}
