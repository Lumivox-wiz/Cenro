import type { Prefs, ReaderTheme, ThemePref } from "../../lib/prefs";

/** 设置分类 id，外壳（SettingsDrawer）与子页共用 */
export type GroupId =
  | "reading"
  | "theme"
  | "background"
  | "library"
  | "backup"
  | "privacy"
  | "shortcuts"
  | "about";

/** 各设置子页共用的入参：只读偏好 + 打补丁 */
export interface SectionProps {
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
}

export const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export const READER_THEME_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: "follow", label: "跟随应用" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "sepia", label: "护眼" },
  { value: "oled", label: "纯黑" },
];

export const SHORTCUTS: [string, string][] = [
  ["聚焦搜索", "Ctrl + F"],
  ["导入文件", "Ctrl + O"],
  ["打开设置", "Ctrl + ,"],
  ["返回书架", "Ctrl + B"],
  ["折叠侧栏", "Ctrl + \\"],
  ["关闭弹层 / 返回", "Esc"],
  ["上一页 / 下一页", "← / →"],
  ["下一页 / 上一页", "Space / Shift+Space"],
  ["下一页 / 上一页", "J / K"],
  ["切换目录", "T"],
  ["切换单页 / 双页", "D"],
  ["放大 / 缩小", "+ / -"],
  ["适合宽度", "0"],
  ["全屏", "F11"],
  ["工具栏循环聚焦", "F6"],
];

export function optionLabel<T extends string>(
  options: { value: T; label: string }[],
  value: T,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}
