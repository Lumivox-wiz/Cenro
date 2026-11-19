import { useEffect, useRef, useState } from "react";

/** 播报节流窗口，UX §7.3 规定 500ms */
const THROTTLE = 500;

/**
 * 把翻转位置变化交给 aria-live 播报，并按 500ms 节流。
 *
 * 不节流的话连翻十页会往语音队列里塞十条消息，屏幕阅读器念到的永远
 * 是若干秒前的位置，最后还得等队列排空。节流保证「停下来之后那一条」
 * 一定是当前真实位置。
 *
 * 返回要渲染进 `role="status"` 节点的文本。
 */
export function useAnnounce(text: string, enabled = true): string {
  const [announced, setAnnounced] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const lastAt = useRef(0);

  useEffect(() => {
    if (!enabled || !text || text === announced) return;

    const wait = Math.max(0, THROTTLE - (Date.now() - lastAt.current));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      lastAt.current = Date.now();
      setAnnounced(text);
    }, wait);

    return () => window.clearTimeout(timer.current);
  }, [text, enabled, announced]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return announced;
}
