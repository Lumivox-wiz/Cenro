import { useCallback, useEffect, useState } from "react";
import { EyeOff, ListChecks, Lock, ShieldQuestion, X } from "lucide-react";
import { errorText, fileUrl, privacyApi, type PrivacyStatus } from "../../api";
import type { Book } from "../../types";
import PinPad from "./PinPad";
import SelectionBar from "../shelf/SelectionBar";
import TitleCover from "../shelf/TitleCover";

interface Props {
  onClose: () => void;
  onOpenBook: (book: Book) => void;
  /** 书架内容变了（移出 / 新增），外层要重新拉一次公开书架 */
  onChanged: () => void;
  onOpenSettings: () => void;
  onToast: (text: string, tone?: "info" | "danger") => void;
}

/**
 * 隐私书架：独立视图，不开新窗口。
 *
 * 开新窗口会进任务栏和系统「最近使用」列表，等于把「这里有个隐私书架」
 * 写进了操作系统——所以它是覆盖在当前窗口上的一层。
 */
export default function PrivateShelf({
  onClose,
  onOpenBook,
  onChanged,
  onOpenSettings,
  onToast,
}: Props) {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 多选：null = 未进入；集合 = 已选 id */
  const [selection, setSelection] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await privacyApi.list();
      setBooks(list);
    } catch (e) {
      onToast(errorText(e), "danger");
    }
  }, [onToast]);

  useEffect(() => {
    privacyApi
      .status()
      .then((s) => {
        setStatus(s);
        // 未启用 PIN 时后端把会话当作解锁（防「忘 PIN 死局」），所以这里也要拉
        if (s.unlocked || !s.enabled) void load();
      })
      .catch(() => {
        /* 非 Tauri 环境 */
      });
  }, [load]);

  const unlock = useCallback(
    async (pin: string) => {
      setBusy(true);
      setPinError(null);
      try {
        await privacyApi.unlock(pin);
        setStatus(await privacyApi.status());
        await load();
      } catch (e) {
        setPinError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** 立即隐藏：锁上会话并退回普通书架 */
  const hideNow = useCallback(async () => {
    try {
      await privacyApi.lock();
    } catch {
      /* 锁失败也要退出，界面上不能再留着内容 */
    }
    onClose();
  }, [onClose]);

  const release = useCallback(
    async (book: Book) => {
      setBusy(true);
      try {
        await privacyApi.release(book.id);
        await load();
        onChanged();
        onToast(`「${book.title}」已移回书架`);
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged, onToast],
  );

  const enabled = status?.enabled ?? false;
  const unlocked = status?.unlocked ?? false;

  const toggleSelect = (book: Book) => {
    setSelection((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });
  };

  const releaseSelected = useCallback(async () => {
    const ids = Array.from(selection ?? []);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const moved = await privacyApi.moveMany(ids, false);
      setSelection(null);
      await load();
      onChanged?.();
      onToast(`已移出 ${moved} 本`);
    } catch (e) {
      onToast(errorText(e), "danger");
    } finally {
      setBusy(false);
    }
  }, [load, onChanged, onToast, selection]);

  return (
    <div className="overlay overlay-dialog" onClick={onClose}>
      <div
        className="private-shelf"
        role="dialog"
        aria-modal="true"
        aria-label="隐私书架"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="private-head">
          <span className="private-title">
            <Lock size={16} strokeWidth={2} aria-hidden="true" />
            隐私书架
            {unlocked && <span className="private-count">{books.length} 本</span>}
          </span>
          <span className="private-actions">
            {unlocked && books.length > 0 && selection === null && (
              <button className="btn btn-ghost" onClick={() => setSelection(new Set())}>
                <ListChecks size={15} strokeWidth={2} />
                <span className="private-action-label">多选</span>
              </button>
            )}
            {unlocked && (
              <button className="btn btn-ghost" onClick={() => void hideNow()}>
                <EyeOff size={15} strokeWidth={2} />
                <span className="private-action-label">立即隐藏</span>
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="关闭隐私书架">
              <X size={18} strokeWidth={2} />
            </button>
          </span>
        </header>

        {!enabled && books.length === 0 && (
          <div className="private-empty">
            <ShieldQuestion size={28} strokeWidth={1.6} aria-hidden="true" />
            <p className="private-empty-title">还没有启用隐私书架</p>
            <p className="private-hint">设一个 6 位 PIN 就能启用。</p>
            <button className="btn btn-secondary" onClick={onOpenSettings}>
              去设置
            </button>
          </div>
        )}

        {/*
         * 没启用 PIN 但书架里还有书：这是「忘了 PIN，删掉 privacy.json」之后的恢复现场。
         * 这时候不设防（也没有东西可防），但必须给出把书移出去的路径，
         * 否则那几本会永远卡在 books_private 里、界面上再也看不到。
         */}
        {!enabled && books.length > 0 && (
          <div className="private-body">
            <p className="private-hint">
              当前没有 PIN，这些书暂时可见。先移出。
            </p>
            <div className="private-grid">
              {books.map((book) => (
                <div className="private-card" key={book.id}>
                  <button
                    className="private-cover"
                    onClick={() => onOpenBook(book)}
                    aria-label={`打开 ${book.title}`}
                  >
                    {fileUrl(book.cover_path) ? (
                      <img src={fileUrl(book.cover_path) as string} alt="" loading="lazy" />
                    ) : (
                      /*
                       * 与主书架用同一个 TitleCover：同一个书名在两边长得一样，
                       * 而且不会出现「只显示一个 `[`」——这些书的标题正是以 [ 开头的。
                       */
                      <TitleCover
                        title={book.title}
                        author={book.author}
                        format={book.format}
                        kind={book.type}
                      />
                    )}
                  </button>
                  <div className="private-meta" title={book.title}>
                    {book.title}
                  </div>
                  <button
                    className="btn btn-ghost private-release"
                    onClick={() => void release(book)}
                    disabled={busy}
                  >
                    移出
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {enabled && !unlocked && (
          <div className="private-gate">
            <PinPad
              title="输入 PIN"
              hint="隐私书架已锁定"
              error={pinError}
              busy={busy}
              onSubmit={(pin) => void unlock(pin)}
              onCancel={onClose}
            />
          </div>
        )}

        {enabled && unlocked && (
          <div className="private-body">
            {books.length === 0 ? (
              <div className="private-empty">
                <p className="private-empty-title">这里还是空的</p>
                <p className="private-hint">
                  在书架上右键（手机长按）一本书，选「移入隐私书架」。
                  这个选项只在解锁后出现，锁定时菜单里看不到。
                </p>
              </div>
            ) : (
              <div className="private-grid">
                {books.map((book) => (
                  <div
                    className="private-card"
                    key={book.id}
                    data-selected={selection ? selection.has(book.id) : undefined}
                  >
                    <button
                      className="private-cover"
                      onClick={() => {
                        if (selection) {
                          toggleSelect(book);
                          return;
                        }
                        onOpenBook(book);
                      }}
                      aria-label={`打开 ${book.title}`}
                    >
                      {fileUrl(book.cover_path) ? (
                        <img src={fileUrl(book.cover_path) as string} alt="" loading="lazy" />
                      ) : (
                        <TitleCover
                          title={book.title}
                          author={book.author}
                          format={book.format}
                          kind={book.type}
                        />
                      )}
                    </button>
                    <div className="private-meta" title={book.title}>
                      {book.title}
                    </div>
                    {selection === null && (
                      <button
                        className="btn btn-ghost private-release"
                        onClick={() => void release(book)}
                        disabled={busy}
                      >
                        移出
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {selection !== null && (
              <SelectionBar
                count={selection.size}
                total={books.length}
                actionLabel="移出隐私书架"
                onAction={() => void releaseSelected()}
                onSelectAll={() => setSelection(new Set(books.map((b) => b.id)))}
                onClearAll={() => setSelection(new Set())}
                onExit={() => setSelection(null)}
                busy={busy}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
