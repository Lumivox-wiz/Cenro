import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  x: number;
  y: number;
  /**
   * 贴边内收用的**估算**宽高。
   *
   * 挂载后会以实测尺寸再夹一次：菜单宽度由 CSS 决定、高度随条目数与分组标题变化，
   * 调用方给的常量迟早对不上（顶栏的分类菜单传 168，而 `.book-menu` 实际 216）。
   * 估错不影响正确性，只是首帧可能闪一下位置——所以调用方仍该给一个接近的值。
   */
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

  /*
   * 首帧之前按实测尺寸夹一次：用 useLayoutEffect 而不是 useEffect，
   * 这样浏览器还没绘制就被摆到正确位置，不会出现「先跳出屏幕再缩回来」的一帧。
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth || width;
    const h = el.offsetHeight || height;
    const left = Math.min(x, window.innerWidth - w - 8);
    const top = Math.min(y, window.innerHeight - h - 8);
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
    /*
     * 菜单自己滚动时不能关。
     *
     * 捕获阶段能收到任意容器的 scroll，包括菜单内部那条——菜单一旦高过视口
     * （顶栏的分类菜单在小屏上合并了排序与视图，会到 400px 以上），
     * 用户滚动它就会被当成「页面滚了，锚点错位」而立刻收起，菜单等于滚不动。
     */
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onClose();
    };

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
