import { useLayoutEffect, useRef } from "react";
import { paintMarks, type MarkSpec } from "../../lib/highlight";

interface Props {
  /** 本章纯文本。换章就整段替换。 */
  text: string;
  /** 本章要高亮的区间。引用变了就重画一遍。 */
  marks: MarkSpec[];
  className?: string;
  /** 把正文节点交给调用方（划词、定位高亮都要用） */
  innerRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * 正文渲染器。刻意不走 React 的文本子节点。
 *
 * 高亮的做法是把文本节点切开、套上 `<mark>`。如果这层文本由 React 持有，
 * 它记着的是「一个文本节点」，而我们已经把这个节点切成了好几段：
 * 换章时 React 只改它记着的那一段，剩下的旧文字就会留在页面上——
 * 表现是两章内容叠在一起，非常难查。所以这里由 DOM 全权持有，
 * React 只负责在 text 变化时把整段写进去。
 *
 * 副作用是布局测量必须在写入之后跑：子组件的 layout effect 早于父组件，
 * 所以分页测量拿到的永远是已经排好版的正文。
 */
export default function ReaderText({ text, marks, className, innerRef }: Props) {
  const own = useRef<HTMLDivElement>(null);
  const ref = innerRef ?? own;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (marks.length > 0) paintMarks(el, marks);
  }, [text, marks, ref]);

  return <div ref={ref} className={className} />;
}
