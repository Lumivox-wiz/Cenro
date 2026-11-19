import { useCallback, useRef } from "react";
import type { Book } from "../../types";

/**
 * 长按打开操作菜单。
 *
 * 移动端长按 <button> 不会触发 contextmenu（那是链接/文本的行为），
 * 所以自己计时：按住 450ms 触发，松手或移开取消。
 * 触发后要吃掉紧接着的 click，否则会同时打开书籍。
 */
export function useLongPress(onMenu: (book: Book, x: number, y: number) => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, book: Book) => {
      // 鼠标交给原生 contextmenu 处理，避免右键被这里抢走
      if (e.pointerType === "mouse") return;
      fired.current = false;
      const { clientX, clientY } = e;
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onMenu(book, clientX, clientY);
      }, 450);
    },
    [onMenu],
  );

  const cancel = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  /** 返回 true 表示这次点击应由长按消费，不再执行原动作 */
  const consumeClick = useCallback(() => {
    if (fired.current) {
      fired.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    onPointerDown,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    // 手指划动触发滚动时浏览器会发 pointercancel，不接这个回调计时器会漏停
    onPointerCancel: cancel,
    consumeClick,
  };
}
