import { FolderOpen, FolderSearch, Lock, PencilLine, Tag, Trash2, XCircle } from "lucide-react";
import { IS_MOBILE } from "../../lib/platform";
import type { Book } from "../../types";
import MenuShell from "./MenuShell";

interface Props {
  book: Book;
  x: number;
  y: number;
  onOpen: (book: Book) => void;
  onReveal: (book: Book) => void;
  /** 编辑书名与作者（规范 §10.1 第一组第三项） */
  onEdit: (book: Book) => void;
  /** 给这本书打标签 */
  onTag: (book: Book) => void;
  /** 文件已丢失或待恢复时，把记录指回用户新选的文件 */
  onRelocate: (book: Book) => void;
  /** 只删记录，保留本地文件（可撤销） */
  onRemove: (book: Book) => void;
  /** 连同本地文件一起删除（危险，需二次确认） */
  onDelete: (book: Book) => void;
  /**
   * 移入隐私书架。只会在解锁态下传进来——锁定/未启用时这一项根本不存在，
   * 免得「菜单里有个隐私选项」本身成为泄露。
   */
  onMakePrivate?: (book: Book) => void;
  onClose: () => void;
}

const MENU_W = 216;
/**
 * 贴边内收用的高度估算（每项 32px + 内边距）。
 * 手机端没有「在文件夹中显示」——`revealItemInDir` 是桌面端 API，
 * 在 Android 上调用会直接抛 "API not supported on the current platform"。
 */
const MENU_H = IS_MOBILE ? 208 : 240;
const MENU_H_ABNORMAL = IS_MOBILE ? 176 : 208;

/**
 * UX 规范 §10.1：文件操作组与移除组之间必须有分隔线，
 * 「删除本地文件」是 Danger 项，且两项都在分隔线之下。
 *
 * 异常态（UX §10.2）换一套项：多一条「重新定位」，去掉对不存在文件的
 * 操作入口——「在文件夹中显示」和「删除本地文件」在文件已经不在时
 * 点了只会报错，留着是干扰。
 */
export default function BookMenu({
  book,
  x,
  y,
  onOpen,
  onReveal,
  onEdit,
  onTag,
  onRelocate,
  onRemove,
  onDelete,
  onMakePrivate,
  onClose,
}: Props) {
  const pending = book.status === "pending";
  const abnormal = pending || book.missing;
  // 多一项就多 32px，贴边内收的高度估算要跟着走，否则菜单会被裁
  const extra = onMakePrivate && !abnormal ? 32 : 0;

  return (
    <MenuShell
      x={x}
      y={y}
      width={MENU_W}
      height={(abnormal ? MENU_H_ABNORMAL : MENU_H) + extra}
      label={`${book.title} 的操作`}
      onClose={onClose}
    >
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onOpen(book);
        }}
      >
        打开
      </button>

      {abnormal && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onRelocate(book);
          }}
        >
          <FolderSearch size={14} strokeWidth={2} />
          重新定位
        </button>
      )}

      {!abnormal && !IS_MOBILE && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onReveal(book);
          }}
        >
          <FolderOpen size={14} strokeWidth={2} />
          在文件夹中显示
        </button>
      )}

      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onEdit(book);
        }}
      >
        <PencilLine size={14} strokeWidth={2} />
        编辑信息
      </button>

      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onTag(book);
        }}
      >
        <Tag size={14} strokeWidth={2} />
        标签…
      </button>

      {onMakePrivate && !abnormal && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onMakePrivate(book);
          }}
        >
          <Lock size={14} strokeWidth={2} />
          移入隐私书架
        </button>
      )}

      <div className="book-menu-sep" role="separator" />

      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onRemove(book);
        }}
      >
        <XCircle size={14} strokeWidth={2} />
        {pending ? "移除记录" : "从书架移除"}
      </button>

      {!abnormal && (
        <button
          role="menuitem"
          className="book-menu-danger"
          onClick={() => {
            onClose();
            onDelete(book);
          }}
        >
          <Trash2 size={14} strokeWidth={2} />
          删除本地文件
        </button>
      )}
    </MenuShell>
  );
}
