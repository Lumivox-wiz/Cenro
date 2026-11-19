import type { Progress } from "../types";

/** 进度百分比 0–100。无进度或无法计算时返回 null。 */
export function progressPercent(progress: Progress | null): number | null {
  if (!progress) return null;
  switch (progress.kind) {
    case "text": {
      if (!progress.total) return null;
      return clampPercent((progress.offset / progress.total) * 100);
    }
    case "epub":
      return clampPercent(progress.progression * 100);
    case "paged": {
      if (!progress.total) return null;
      // page 从 0 起：读到第 1 页时进度为 1/total
      return clampPercent(((progress.page + 1) / progress.total) * 100);
    }
  }
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatRecent(ts: number | null): string {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
