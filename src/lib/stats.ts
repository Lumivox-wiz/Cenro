import type { Book } from "../types";
import { CATEGORY_LABEL, categoryOf, type CategoryKey } from "./filters";

/**
 * 书库统计。
 *
 * 刻意放在前端算：书列表本来就已经在内存里，`categoryOf()` 也是同一份，
 * 这样「统计里的分类数字」与「侧栏里的分类计数」永远一致——
 * 挪到后端就变成两套口径，迟早会出现「侧栏说 5 本、统计说 4 本」。
 *
 * 不统计阅读时长：应用从来没采过打开时长，硬凑一个数字没有意义。
 */

export interface CategoryStat {
  key: CategoryKey;
  label: string;
  count: number;
}

export interface LibraryStats {
  total: number;
  /** 进度 ≥ 99% */
  finished: number;
  /** 有进度但没读完；EPUB 的「章内比例」也算在这里 */
  reading: number;
  /** 从未打开 */
  unread: number;
  /** 最近 7 天有阅读的天数（去重到「天」） */
  activeDays: number;
  /** 最近 7 天读过的书数 */
  recentBooks: number;
  byCategory: CategoryStat[];
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

/**
 * 全书进度 0–1；算不出来时返回 null。
 *
 * EPUB 存的是 `progression`（章内比例），不是全书比例——单靠它无法判断读没读完，
 * 因此 EPUB 一律返回 null，落到「在读」里。宁可少报一个「已读完」，
 * 也不要给用户一个假的完成度。
 */
export function percentOf(book: Book): number | null {
  const progress = book.progress;
  if (!progress) return null;
  switch (progress.kind) {
    case "text":
      return progress.total > 0 ? progress.offset / progress.total : null;
    case "paged":
      return progress.total > 0 ? (progress.page + 1) / progress.total : null;
    case "epub":
      return null;
  }
}

/** 最近 7 天、每本书各算一天，去重 */
function activeDayCount(books: Book[], now: number): number {
  const days = new Set<string>();
  for (const book of books) {
    if (!book.last_read_at) continue;
    const at = book.last_read_at * 1000;
    if (now - at > WEEK || at > now) continue;
    const date = new Date(at);
    days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
  }
  return days.size;
}

export function computeStats(books: Book[], now: number = Date.now()): LibraryStats {
  const counts = new Map<CategoryKey, number>();
  let finished = 0;
  let reading = 0;
  let unread = 0;
  let recentBooks = 0;

  for (const book of books) {
    const key = categoryOf(book);
    counts.set(key, (counts.get(key) ?? 0) + 1);

    if (!book.progress) {
      unread += 1;
    } else {
      const pct = percentOf(book);
      if (pct !== null && pct >= 0.99) finished += 1;
      else reading += 1;
    }

    if (book.last_read_at && now - book.last_read_at * 1000 <= WEEK) recentBooks += 1;
  }

  const order: CategoryKey[] = ["text", "ebook", "doc", "comic", "pdf"];
  const byCategory = order
    .map((key) => ({ key, label: CATEGORY_LABEL[key], count: counts.get(key) ?? 0 }))
    .filter((item) => item.count > 0);

  return {
    total: books.length,
    finished,
    reading,
    unread,
    activeDays: activeDayCount(books, now),
    recentBooks,
    byCategory,
  };
}
