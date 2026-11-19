/**
 * 移动端导入。
 *
 * 为什么不用 `dialog.open({ directory: true })`：
 * Android 的系统选择器返回 `content://` URI，而书库扫描器用的是 `std::fs`，
 * 拿不到内容；反过来从 URI 也推不出真实文件名（末段是 `document%3A1000…`）。
 *
 * 改用 WebView 的 <input type="file">：系统选择器同样原生，但 JS 拿到的是
 * File 对象，既有 `name` 也有字节流，直接写入应用私有目录即可。
 * 之后把该目录注册为书库根，桌面端那套扫描流程原样复用，Rust 侧零改动。
 */

import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile } from "@tauri-apps/plugin-fs";

// 图片需要成组才有意义，单张导入不构成一本书，故 accept 里不含图片
import { isSupportedBook, MOBILE_ACCEPT } from "./formats";

export interface MobileImportResult {
  /** 书籍落盘的目录，注册为书库根 */
  dir: string;
  saved: number;
  /** 失败项：文件名 + 原因（选择器放行之后仍可能选中不支持的文件） */
  failed: { name: string; reason: string }[];
  /** 成功写入的绝对路径，顺序与写入顺序一致（重新定位要靠它回填记录） */
  paths: string[];
}

/** 弹出系统文件选择器，返回选中的 File 对象（含真实文件名与字节）。 */
function pickFiles(accept = MOBILE_ACCEPT, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = accept;
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";

    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    // 用户取消时部分 WebView 只触发 cancel，不触发 change
    input.addEventListener("cancel", () => finish([]));

    document.body.appendChild(input);
    input.click();
  });
}

/** 去掉路径分隔符与 Windows 非法字符，避免写到目录外。 */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "");
  return cleaned || "book";
}

/** 同名文件加序号，不覆盖已有书籍。 */
async function uniquePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  let candidate = await join(dir, name);
  let index = 1;
  while (await exists(candidate)) {
    candidate = await join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

/**
 * 选一个备份包（zip），写进应用数据目录的 `backups/` 并返回绝对路径。
 *
 * 手机上没有「另存为」对话框，也没有文件夹选择器，只有这个 `<input type=file>`；
 * 选出来的 File 只有字节和文件名，所以先落到 backups/ 再交给后端解包。
 * 落在 backups/ 而不是临时目录还有个好处：它同时会出现在「本地备份包」列表里。
 */
export async function pickBackupArchive(): Promise<string | null> {
  const [file] = await pickFiles("application/zip,.zip", false);
  if (!file) return null;

  const dir = await join(await appDataDir(), "backups");
  await mkdir(dir, { recursive: true });
  const target = await uniquePath(dir, safeName(file.name));
  await writeFile(target, new Uint8Array(await file.arrayBuffer()));
  return target;
}

/** 弹出系统文件选择器。拆成独立一步，调用方才能在写入前先立占位卡片。 */
export async function pickBookFiles(): Promise<File[]> {
  return pickFiles();
}

export type ImportPhase = "copying" | "done" | "failed";

export interface ImportProgress {
  index: number;
  name: string;
  phase: ImportPhase;
  error?: string;
}

/**
 * 把选中的文件复制进应用私有目录。
 *
 * 逐条 try/catch：单个文件写失败不影响其余文件（UX §5.2「逐条失败隔离」）。
 * 进度通过回调上报，供书架上的占位卡片更新状态。
 */
export async function saveFilesToLibrary(
  files: File[],
  onProgress?: (p: ImportProgress) => void,
): Promise<MobileImportResult> {
  const dir = await join(await appDataDir(), "books");
  await mkdir(dir, { recursive: true });

  let saved = 0;
  const failed: { name: string; reason: string }[] = [];
  const paths: string[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    onProgress?.({ index: i, name: file.name, phase: "copying" });

    // 选择器为了放行 .ofd 已经放宽到 octet-stream，这里按扩展名收口
    if (!isSupportedBook(file.name)) {
      failed.push({ name: file.name, reason: "不支持的格式" });
      onProgress?.({
        index: i,
        name: file.name,
        phase: "failed",
        error: "不支持的格式",
      });
      continue;
    }

    try {
      const target = await uniquePath(dir, safeName(file.name));
      await writeFile(target, new Uint8Array(await file.arrayBuffer()));
      saved += 1;
      paths.push(target);
      onProgress?.({ index: i, name: file.name, phase: "done" });
    } catch (e) {
      failed.push({
        name: file.name,
        reason: e instanceof Error ? e.message : "写入失败",
      });
      onProgress?.({
        index: i,
        name: file.name,
        phase: "failed",
        error: e instanceof Error ? e.message : "写入失败",
      });
    }
  }

  return { dir, saved, failed, paths };
}
