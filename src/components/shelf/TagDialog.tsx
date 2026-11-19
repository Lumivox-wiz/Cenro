import { useMemo, useState } from "react";
import { Tag, X } from "lucide-react";
import Dialog from "../ui/Dialog";

interface Props {
  bookTitle: string;
  /** 这本书当前的标签 */
  value: string[];
  /** 全库已有的标签（用于一键复用，不重复输入） */
  suggestions: string[];
  onSave: (tags: string[]) => void;
  onClose: () => void;
}

const MAX_TAGS = 20;
const MAX_LEN = 24;

/**
 * 给一本书打标签。
 *
 * 标签与分类是两件事：分类由格式决定、一本书只能落一格；
 * 标签是「我怎么用它」——「工作 + 待读」「闲书 + 睡前」这类组合只有标签表达得出。
 *
 * 交互刻意做得直白：输入回车加、点已有标签复用、点 × 去掉。
 * 不做「标签管理页」——几十个标签在弹窗里就够了，多一层页面只会提高门槛。
 */
export default function TagDialog({ bookTitle, value, suggestions, onSave, onClose }: Props) {
  const [tags, setTags] = useState<string[]>(value);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addable = useMemo(
    () => suggestions.filter((s) => !tags.includes(s)).slice(0, 24),
    [suggestions, tags],
  );

  const add = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    if (name.length > MAX_LEN) {
      setError(`标签名最多 ${MAX_LEN} 个字`);
      return;
    }
    if (tags.includes(name)) {
      setError("这个标签已经加过了");
      return;
    }
    if (tags.length >= MAX_TAGS) {
      setError(`一本书最多 ${MAX_TAGS} 个标签`);
      return;
    }
    setError(null);
    setTags([...tags, name]);
    setDraft("");
  };

  return (
    <Dialog
      title="标签"
      confirmLabel="保存"
      onConfirm={() => onSave(tags)}
      onCancel={onClose}
    >
      <div className="dialog-form">
        <div className="field-hint" style={{ marginBottom: 4 }}>
          给《{bookTitle}》贴上标签，书架侧栏可以按标签筛选。
        </div>

        <input
          className="input"
          value={draft}
          autoFocus
          maxLength={MAX_LEN}
          placeholder="输入标签后回车，例如「待读」"
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && tags.length > 0) {
              // 空输入时退格删掉最后一个，省得去点那个小 ×
              setTags(tags.slice(0, -1));
            }
          }}
          aria-label="新标签"
        />

        {tags.length > 0 && (
          <div className="tag-list" aria-label="已选标签">
            {tags.map((tag) => (
              <span key={tag} className="tag-chip">
                <Tag size={12} strokeWidth={2.4} aria-hidden="true" />
                {tag}
                <button
                  className="tag-remove"
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                  aria-label={`移除标签 ${tag}`}
                >
                  <X size={12} strokeWidth={2.4} />
                </button>
              </span>
            ))}
          </div>
        )}

        {addable.length > 0 && (
          <>
            <div className="field-label" style={{ fontSize: "var(--fs-12)" }}>
              已有标签
            </div>
            <div className="tag-list">
              {addable.map((tag) => (
                <button key={tag} className="tag-chip tag-chip-add" onClick={() => add(tag)}>
                  {tag}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="field-hint">
          {error ?? "标签按原样保存，一本书最多 20 个。没有书的标签会自动清理。"}
        </div>
      </div>
    </Dialog>
  );
}
