import { useEffect, useRef, useState } from "react";
import { Highlighter, NotebookPen, X } from "lucide-react";
import { readSelection, watchRectChange, type SelectionTarget } from "../../lib/highlight";
import { IS_MOBILE } from "../../lib/platform";

interface Props {
  /** 正文容器。每次读都现取——换章会换掉整个节点 */
  getRoot: () => HTMLElement | null;
  /** 正文还没到位 / 面板打开时不接管选区 */
  enabled: boolean;
  /** 落库中：按钮先置灰，避免连点出两条一样的标注 */
  busy?: boolean;
  onCreate: (kind: "highlight" | "note", target: SelectionTarget, note: string | null) => void;
}

/**
 * 划词后浮在选区旁的操作条。
 *
 * 只做两件事：记下「选区快照」和画浮条。快照在选中那一刻就算好并冻结，
 * 之后无论浏览器把选区交还给谁（点按钮、聚焦输入框都会清选区），
 * 用的都是这份快照——这是划词功能最容易被搞坏的地方。
 *
 * 不接管「选中」这个动作本身：浏览器原生的长按选词、拖选、双击选词
 * 都比自己实现的好用，尤其在有系统选择手柄的移动端。
 */
export default function SelectionActions({ getRoot, enabled, busy, onCreate }: Props) {
  const [target, setTarget] = useState<SelectionTarget | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [draft, setDraft] = useState("");
  // 调用方通常内联传 getRoot（每次渲染都是新函数），存进 ref 才不会反复重挂监听
  const rootOf = useRef(getRoot);
  rootOf.current = getRoot;
  const cardRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // 选区变化：防抖 140ms，拖动过程里不会疯狂重渲染
  useEffect(() => {
    if (!enabled) {
      setTarget(null);
      setNoteMode(false);
      return;
    }

    const onSelectionChange = () => {
      // 写笔记时选区必然已经收起，这时候不能再跟着清掉快照
      if (noteMode) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const root = rootOf.current();
        if (!root) return;
        const next = readSelection(root);
        // 选到正文外（工具栏、输入框）就当没选
        setTarget(next);
      }, 140);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [enabled, noteMode]);

  // 浮条位置是按视口坐标算的，滚动或窗口变化后就不对了，直接收起
  useEffect(() => {
    if (!target || noteMode) return;
    return watchRectChange(() => setTarget(null));
  }, [target, noteMode]);

  // 点浮条以外的地方收起。用 pointerdown 而不是 click：
  // 点空白处立刻反应，不用等一次完整的按下-抬起
  useEffect(() => {
    if (!target) return;
    const onDown = (e: PointerEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      setTarget(null);
      setNoteMode(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [target]);

  useEffect(() => {
    if (noteMode) areaRef.current?.focus();
  }, [noteMode]);

  const close = () => {
    setTarget(null);
    setNoteMode(false);
    setDraft("");
    window.getSelection()?.removeAllRanges();
  };

  const submit = (kind: "highlight" | "note", note: string | null) => {
    if (!target) return;
    onCreate(kind, target, note);
    setTarget(null);
    setNoteMode(false);
    setDraft("");
    window.getSelection()?.removeAllRanges();
  };

  if (!target || !enabled) return null;

  const { rect } = target;
  const viewportH = window.innerHeight;
  /*
   * 放上方还是下方：
   * - 触屏优先放下方——安卓长按选词时系统自带一条「复制 / 全选」浮在选区上方，
   *   我们再挤上去就叠在一起了；
   * - 桌面优先放上方（鼠标离手最近、不挡下面的正文）；
   * - 无论哪种，越界了就翻到另一侧。
   */
  const placeBelow = IS_MOBILE ? rect.bottom < viewportH - 96 : rect.top <= 72;
  const mid = (rect.left + rect.right) / 2;
  const style: React.CSSProperties = {
    // 两侧留 110px：浮条本身约 200px 宽，clamp 保证不出屏
    left: noteMode ? "50%" : `clamp(110px, ${mid}px, calc(100vw - 110px))`,
    top: placeBelow ? rect.bottom + 10 : rect.top - 10,
    transform: placeBelow ? "translateX(-50%)" : "translate(-50%, -100%)",
    maxHeight: viewportH - 24,
  };

  return (
    <div
      ref={cardRef}
      className={noteMode ? "sel-bar sel-bar-note" : "sel-bar"}
      style={style}
      role="toolbar"
      aria-label="划词操作"
    >
      {noteMode ? (
        <>
          <textarea
            ref={areaRef}
            className="sel-note-input"
            value={draft}
            rows={3}
            maxLength={2000}
            placeholder="写下想法…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setNoteMode(false);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit("note", draft.trim() || null);
              }
            }}
          />
          <div className="sel-bar-row">
            <span className="sel-hint">⌘/Ctrl + Enter 保存</span>
            <button className="sel-btn" onClick={() => setNoteMode(false)} disabled={busy}>
              取消
            </button>
            <button
              className="sel-btn sel-btn-primary"
              onClick={() => submit("note", draft.trim() || null)}
              disabled={busy}
            >
              保存
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            className="sel-btn"
            onClick={() => submit("highlight", null)}
            disabled={busy}
            title="高亮选中的文字"
          >
            <Highlighter size={15} strokeWidth={2} />
            高亮
          </button>
          <button
            className="sel-btn"
            onClick={() => setNoteMode(true)}
            disabled={busy}
            title="高亮并写一条笔记"
          >
            <NotebookPen size={15} strokeWidth={2} />
            笔记
          </button>
          <button className="sel-close" onClick={close} aria-label="取消">
            <X size={14} strokeWidth={2} />
          </button>
        </>
      )}
    </div>
  );
}
