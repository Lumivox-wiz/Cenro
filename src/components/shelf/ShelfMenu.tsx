import { FilePlus2, FolderPlus, RefreshCw, Settings } from "lucide-react";
import MenuShell from "./MenuShell";

interface Props {
  x: number;
  y: number;
  /** 移动端没有文件夹选择器，不提供该项 */
  showFolderImport: boolean;
  scanning: boolean;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onScan: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

const MENU_W = 216;

/**
 * 书架空白处的右键菜单。
 *
 * 与书籍卡片菜单共用外壳和样式，但按 UX 规范 §10.1 同样分组：
 * 导入属于「文件操作」，重新扫描与设置单独成组，中间用分隔线隔开。
 */
export default function ShelfMenu({
  x,
  y,
  showFolderImport,
  scanning,
  onImportFiles,
  onImportFolder,
  onScan,
  onOpenSettings,
  onClose,
}: Props) {
  // 只用于贴边内收的估算，多给一点不影响
  const height = showFolderImport ? 198 : 168;

  return (
    <MenuShell x={x} y={y} width={MENU_W} height={height} label="书架操作" onClose={onClose}>
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onImportFiles();
        }}
      >
        <FilePlus2 size={14} strokeWidth={2} />
        导入文件
      </button>

      {showFolderImport && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onImportFolder();
          }}
        >
          <FolderPlus size={14} strokeWidth={2} />
          导入文件夹
        </button>
      )}

      <div className="book-menu-sep" role="separator" />

      <button
        role="menuitem"
        disabled={scanning}
        onClick={() => {
          onClose();
          onScan();
        }}
      >
        <RefreshCw size={14} strokeWidth={2} />
        {scanning ? "正在扫描…" : "重新扫描"}
      </button>

      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onOpenSettings();
        }}
      >
        <Settings size={14} strokeWidth={2} />
        设置
      </button>
    </MenuShell>
  );
}
