import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { UploadCloud } from "lucide-react";
import { api, docxApi, errorText, fileUrl, mdApi, privacyApi, tagApi, xlsxApi } from "./api";
import type { TagCount } from "./api";
import { installGlobalErrorLogging, logError, logInfo, logWarn } from "./lib/log";
import { computeStats } from "./lib/stats";
import type { PrivacyStatus } from "./api";
import { IS_MOBILE } from "./lib/platform";
import {
  pickBookFiles,
  saveFilesToLibrary,
  type ImportProgress,
} from "./lib/mobileImport";
import { BOOK_EXTENSIONS } from "./lib/formats";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAndroidBack } from "./lib/useAndroidBack";
import { useContextMenuGuard } from "./lib/useContextMenuGuard";
import {
  FORMAT_LABEL,
  type Book,
  type BookFormat,
  type LibraryRoot,
  type Progress,
  type ScanFailure,
} from "./types";
import TopBar from "./components/shelf/TopBar";
import Sidebar from "./components/shelf/Sidebar";
import { matchesFilter, type ShelfFilter } from "./lib/filters";
import BookCard from "./components/shelf/BookCard";
import ShelfList from "./components/shelf/ShelfList";
import EmptyState from "./components/shelf/EmptyState";
import BookMenu from "./components/shelf/BookMenu";
import TagDialog from "./components/shelf/TagDialog";
import ShelfMenu from "./components/shelf/ShelfMenu";
import ImportCard, { type PendingImport } from "./components/shelf/ImportCard";
import Dialog from "./components/ui/Dialog";
import SettingsDrawer from "./components/settings/SettingsDrawer";
import PrivateShelf from "./components/privacy/PrivateShelf";
import SelectionBar from "./components/shelf/SelectionBar";
import ToastStack, { type ToastData } from "./components/ui/Toast";
import ShelfSkeleton from "./components/ui/Skeleton";
import ReaderShell from "./components/reader/ReaderShell";
import PdfViewer from "./components/reader/PdfViewer";
import ComicViewer from "./components/reader/ComicViewer";
import EpubViewer from "./components/reader/EpubViewer";
import HtmlViewer from "./components/reader/HtmlViewer";
import OfdViewer from "./components/reader/OfdViewer";
import {
  applyAppTheme,
  applyMaterial,
  applyReaderVars,
  loadPrefs,
  savePrefs,
  type Prefs,
} from "./lib/prefs";
import { applyMonet } from "./lib/monet";

/**
 * F11 全屏开关。
 *
 * 动态 import：`@tauri-apps/api/window` 只在真的要全屏时才加载，
 * 而浏览器预览环境里根本没有这个模块，失败就直接当没按过。
 */
async function toggleFullscreen() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch {
    /* 非 Tauri 环境 / 权限未授予：静默失败，不值得弹 toast */
  }
}

/** 阅读页退场动画时长，需与 components.css 中的 --dur-reader-out 保持一致 */
const READER_EXIT_MS = 220;

/**
 * 按扩展名猜大类，只用于导入占位卡片的图标。
 * 真实分类由扫描器决定（MOBI 甚至要看内部是不是图片）。
 */
function guessBookType(name: string): Book["type"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["cbz", "cbr", "cbt", "cb7", "zip"].includes(ext)) return "comic";
  if (["ofd", "xlsx", "docx", "rtf", "mhtml"].includes(ext)) return "doc";
  return "novel";
}

/** HTML 阅读器的数据源：把「转成 HTML 再读」的格式映射到各自的命令 */
function richSource(format: BookFormat) {
  if (format === "md") return mdApi;
  if (format === "docx") return docxApi;
  if (format === "xlsx") return xlsxApi;
  return undefined;
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function App() {
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs());
  const [books, setBooks] = useState<Book[]>([]);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [filter, setFilter] = useState<ShelfFilter>("all");
  /** 标签与分类叠加筛：分类答「是什么格式」，标签答「我怎么用它」 */
  const [tags, setTags] = useState<TagCount[]>([]);
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagEditing, setTagEditing] = useState<Book | null>(null);
  const [exportingBooks, setExportingBooks] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  /** 拖拽文件悬停在窗口上：显示全窗口投放层 */
  const [dropActive, setDropActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  /** 导入失败明细。有值就弹对话框，空则不显示。 */
  const [importFailures, setImportFailures] = useState<ScanFailure[] | null>(null);
  const [readingBook, setReadingBook] = useState<Book | null>(null);
  // 退场动画播放中：此刻阅读页仍在 DOM 里，等动画结束再卸载
  const [readerClosing, setReaderClosing] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  // 封面重建后递增：封面 URL 不变，只能靠 key 变化让 img 重新请求
  const [coverRev, setCoverRev] = useState(0);
  // 右键 / 长按打开的书籍操作菜单
  const [menu, setMenu] = useState<{ book: Book; x: number; y: number } | null>(null);
  // 书架空白处的右键菜单（导入 / 扫描 / 设置）
  const [shelfMenu, setShelfMenu] = useState<{ x: number; y: number } | null>(null);
  // 键盘唤出菜单时的触发元素，关闭后焦点还给它
  const menuAnchor = useRef<HTMLElement | null>(null);
  // 导入中的占位条目（UX §5.2：先占位再解析）
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  // 编辑书名 / 作者
  const [editing, setEditing] = useState<Book | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  // 待确认「删除本地文件」的书
  const [pendingDelete, setPendingDelete] = useState<Book | null>(null);
  // 隐私书架：覆盖层是否打开；status 决定菜单里出不出现「移入隐私书架」
  const [privateOpen, setPrivateOpen] = useState(false);
  const [privacy, setPrivacy] = useState<PrivacyStatus | null>(null);
  /** 多选：null 表示未进入选择模式，空集合表示已进入但还没勾 */
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [movingPrivacy, setMovingPrivacy] = useState(false);
  // 记录还在、文件却不见了：不直接进空白阅读页，先给两条出路（UX §5.3）
  const [missingBook, setMissingBook] = useState<Book | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // 屏蔽 WebView 默认右键菜单（刷新 / 另存为 / 打印），只保留输入框与选区
  useContextMenuGuard();

  // Android 返回键：与 Esc 同一套层级语义
  useAndroidBack(() => {
    if (privateOpen) {
      setPrivateOpen(false);
      return true;
    }
    if (missingBook) {
      setMissingBook(null);
      return true;
    }
    if (settingsOpen) {
      // 设置有子页：合成一次 Esc，让抽屉自己按「子页 → 菜单 → 关闭」逐级退，
      // 不会在子页里按一下就直接飞回书架
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return true;
    }
    if (readingBook) {
      // 阅读页内部有自己的 Esc 栈（帮助 → 目录 → 工具栏 → 退出），
      // 派发一次合成按键即可复用，不必在两处各写一份优先级
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return true;
    }
    if (query) {
      setQuery("");
      return true;
    }
    return false;
  });
  const toastSeq = useRef(0);

  /*
   * Android 的「用其他应用打开」不会重启 Activity：文件由 Kotlin 复制到 cache，
   * 排进队列，没有任何事件能告诉前端。这里在每次回到前台时去问一次，
   * 并短轮询几轮——复制是放在后台线程做的，刚切回来时往往还没写完。
   *
   * 桌面端也会走到这里（最小化恢复），但那时队列是空的，代价只有一次 IPC。
   */
  useEffect(() => {
    // 只有安卓需要：桌面端的「打开方式」走 argv + 单实例转发，不经过这个目录
    if (!IS_MOBILE) return;
    let asking = false;

    const check = async () => {
      if (document.visibilityState !== "visible" || asking) return;
      asking = true;
      try {
        // 复制是后台线程做的，几十 MB 的文件可能要好几秒
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const id = await api.takeStartupBook();
          if (id) {
            const book = await api.getBook(id);
            if (book) await openBookRef.current?.(book);
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
      } catch (e) {
        // 问不到就等下次回到前台；记一笔，免得「点开没反应」时无从查起
        logWarn(`取启动书失败：${errorText(e)}`);
      } finally {
        asking = false;
      }
    };

    // 必须用同一个函数引用，否则 remove 删不掉、每次挂载都会多留一个监听
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /*
   * 事件监听只注册一次（重复注册会叠加回调），但 handleOpen 会随状态重建。
   * 用 ref 拿最新的那一个，effect 就不用把 handleOpen 放进依赖数组——
   * 放进去会导致「每次打开一本书都重新订阅一次」。
   */
  const openBookRef = useRef<((book: Book) => Promise<void>) | null>(null);

  const pushToast = useCallback(
    (
      text: string,
      tone: "info" | "danger" = "info",
      action?: { label: string; onClick: () => void },
    ) => {
      // 用户看到的红条就是「出事了」，顺手记进日志：
      // 否则事后只剩一句「刚才弹了个错」，连错的是什么都不知道
      if (tone === "danger") logError(text);
      const id = ++toastSeq.current;
      // 5.8：最多 3 条堆叠；带撤销时停留 5 秒（UX 规范 §10.3）
      setToasts((prev) => [...prev.slice(-2), { id, text, tone, action }]);
      window.setTimeout(
        () => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        },
        action ? 5000 : 3000,
      );
  }, []);

  /** 提前收起某条 Toast（点掉撤销按钮后立刻消失） */
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      applyAppTheme(next.theme);
      // 材质依赖 data-theme 决定亮玻璃还是暗玻璃，必须排在 applyAppTheme 之后
      applyMaterial(next.material);
      // 主题可能与莫奈配色同批变化（比如同时切到亮色又开取色），顺序不能反
      applyMonet(next.monet, next.background.path);
      applyReaderVars(next);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const [nextBooks, nextRoots] = await Promise.all([api.listBooks(), api.listRoots()]);
    setBooks(nextBooks);
    setRoots(nextRoots);
  }, []);

  const refreshPrivacy = useCallback(() => {
    privacyApi
      .status()
      .then(setPrivacy)
      .catch(() => {
        /* 非 Tauri 环境拿不到，菜单里就不出现隐私项 */
      });
  }, []);

  /*
   * 双击书籍文件启动时，后端已经把书收进书库并留下了 id。
   * 这里取一次就直接进阅读页——用户的心智是「双击 = 打开这本书」，
   * 不该先落到书架再自己找。
   */
  useEffect(() => {
    void (async () => {
      try {
        const id = await api.takeStartupBook();
        if (!id) return;
        const book = await api.getBook(id);
        if (book) await handleOpen(book);
      } catch (e) {
        // 打不开就停在书架，不打断启动；但要留下线索
        logWarn(`启动书打开失败：${errorText(e)}`);
      }
    })();
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 应用已经开着时又双击了一本书：后端（单实例插件）收下文件后发来 id。
   * 这里不能复用上面那个「挂载时取一次」的槽——那个槽在启动时就被取空了。
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<string>("open-book", async (event) => {
      try {
        const book = await api.getBook(event.payload);
        if (book) await openBookRef.current?.(book);
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    }).then((fn) => {
      // 监听是异步注册的，注册完成前组件可能已卸载
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [pushToast]);

  useEffect(() => {
    installGlobalErrorLogging();
    logInfo("界面已加载");
    // 前端活了就把 index.html 里的启动兜底层摘掉
    document.getElementById("boot")?.remove();
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => pushToast(errorText(e), "danger"))
      .finally(() => setLoading(false));
    refreshPrivacy();
  }, [refresh, refreshPrivacy, pushToast]);

  // 系统主题跟随：system 解析为实际值后写入 data-theme（规范 3.2）
  useEffect(() => {
    if (prefs.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      applyAppTheme("system");
      // 亮暗切换后同一组色值不再满足对比度，必须按新的纸面重算
      const latest = loadPrefs();
      applyMonet(latest.monet, latest.background.path);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [prefs.theme]);

  /*
   * 顶栏浮层（v1.7 方案 B）：内容区滚到顶栏下面时，顶栏的玻璃才淡入。
   *
   * 直接写 DOM 属性，不走 setState —— 滚动每帧 setState 会把整个书架（几百张卡）重渲染一遍。
   * ResizeObserver 兜住「切分类后书变少，scrollTop 被浏览器夹回 0 但不触发 scroll」的情况，
   * 否则会残留一条玻璃带浮在空列表上方，正好变回 v1.6 刚拆掉的那块白板。
   */
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shell = shellRef.current;
    const scroller = shell?.querySelector<HTMLElement>(".content");
    if (!shell || !scroller) return;

    const sync = () => {
      shell.dataset.scrolled = scroller.scrollTop > 2 ? "true" : "false";
    };

    sync();
    scroller.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);

    return () => {
      scroller.removeEventListener("scroll", sync);
      ro.disconnect();
      delete shell.dataset.scrolled;
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    const effectivelyCollapsed =
      prefs.sidebar === "collapsed" ||
      (prefs.sidebar === "auto" && window.innerWidth < 1200);
    setPrefs({ sidebar: effectivelyCollapsed ? "expanded" : "collapsed" });
  }, [prefs.sidebar, setPrefs]);

  const runScan = useCallback(
    async (silent = false) => {
      if (importing) return;
      setImporting(true);
      try {
        const report = await api.scanLibrary();
        await refresh();
        if (!silent) {
          // 手动重新扫描同样要能追问原因，否则「失败 N」依然是个黑盒
          pushToast(
            `扫描完成 · 新增 ${report.added} · 更新 ${report.updated} · 跳过 ${report.skipped}` +
              (report.removed ? ` · 移除 ${report.removed}` : "") +
              (report.failed ? ` · 失败 ${report.failed}` : "") +
              ` · ${(report.elapsed_ms / 1000).toFixed(1)}s`,
            report.failed > 0 ? "danger" : "info",
            report.failed > 0
              ? { label: "查看原因", onClick: () => setImportFailures(report.failures) }
              : undefined,
          );
        }
        return report;
      } catch (e) {
        pushToast(errorText(e), "danger");
        return null;
      } finally {
        setImporting(false);
      }
    },
    [importing, pushToast, refresh],
  );

  /** 汇总提示：成功 N / 失败 M（UX §5.2） */
  const toastImportSummary = useCallback(
    (added: number, failed: ScanFailure[]) => {
      const parts = [`导入完成 · 新增 ${added} 本`];
      if (failed.length > 0) parts.push(`失败 ${failed.length} 个`);
      /*
       * 失败时给一个「查看原因」入口：只说数字的话用户既不知道是哪几个文件，
       * 也不知道该修什么，最后只能把整批删掉重来。
       */
      pushToast(
        parts.join(" · "),
        failed.length > 0 ? "danger" : "info",
        failed.length > 0
          ? { label: "查看原因", onClick: () => setImportFailures(failed) }
          : undefined,
      );
    },
    [pushToast],
  );

  /**
   * 按路径导入：每个路径登记为一条书库根，再统一扫描一次。
   *
   * 文件与文件夹走同一条路——扫描器对「根是文件」记一本书、对目录递归，
   * 所以拖拽进来的文件夹不需要特殊分支。
   */
  const importPaths = useCallback(
    async (rawPaths: string[]) => {
      const paths = rawPaths.filter((p) => typeof p === "string" && p.length > 0);
      if (paths.length === 0) {
        pushToast("没有可导入的文件", "danger");
        return;
      }

      setImporting(true);
      setPendingImports(
        paths.map((p) => ({
          key: p,
          name: fileNameOf(p),
          type: guessBookType(p),
          phase: "copying" as const,
        })),
      );

      // 逐条登记：单个失败不影响其余（UX §5.2 失败隔离）
      const failures: ScanFailure[] = [];
      for (const path of paths) {
        try {
          await api.addRoot(path);
        } catch (e) {
          failures.push({ path, message: errorText(e) });
        }
      }

      const report = await api.scanLibrary();
      await refresh();
      setPendingImports([]);
      toastImportSummary(report.added, [...failures, ...report.failures]);
      setImporting(false);
    },
    [pushToast, refresh, toastImportSummary],
  );

  const handleImport = useCallback(async () => {
    try {
      setImporting(true);

      // 移动端没有「文件夹选择器」，改为选文件后复制进应用私有目录
      if (IS_MOBILE) {
        const files = await pickBookFiles();
        if (files.length === 0) {
          setImporting(false);
          return;
        }

        // 先立占位卡片，再逐个写入，卡片状态随进度更新
        setPendingImports(
          files.map((f, i) => ({
            key: `m${i}`,
            name: f.name,
            type: guessBookType(f.name),
            phase: "copying" as const,
          })),
        );

        const onProgress = (p: ImportProgress) => {
          setPendingImports((prev) =>
            prev.map((item) =>
              item.key === `m${p.index}`
                ? { ...item, phase: p.phase, error: p.error }
                : item,
            ),
          );
        };

        const result = await saveFilesToLibrary(files, onProgress);

        if (result.saved > 0) {
          await api.addRoot(result.dir);
          const report = await api.scanLibrary();
          await refresh();
          // 移动端拿不到原路径，失败项显示文件名；原因由导入层给出（格式不支持 / 写入失败）
          const writeFailures: ScanFailure[] = result.failed.map((f) => ({
            path: f.name,
            message: f.reason,
          }));
          toastImportSummary(report.added, [...writeFailures, ...report.failures]);
        } else {
          pushToast("没有可导入的文件", "danger");
        }

        // 失败项多留 3 秒，让用户看清是哪几本
        window.setTimeout(() => setPendingImports([]), 3000);
        setImporting(false);
        return;
      }

      // 桌面端：直接选文件，多选。每个文件作为一条书库根登记，
      // 扫描器对「根是文件」的情况会直接收作一本书，不复制、不改动原文件。
      const picked = await openDialog({
        multiple: true,
        title: "导入文件",
        filters: [{ name: "电子书", extensions: BOOK_EXTENSIONS }],
      });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      // 用户点了取消：静默返回，不弹「没有可导入的文件」
      if (paths.length === 0) {
        setImporting(false);
        return;
      }
      await importPaths(paths);
    } catch (e) {
      setPendingImports([]);
      setImporting(false);
      pushToast(errorText(e), "danger");
    }
  }, [importPaths, pushToast]);

  /** 导入整个文件夹（递归扫描）。移动端没有文件夹选择器，不提供该入口。 */
  const handleImportFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "导入书库目录",
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;

      setImporting(true);
      await api.addRoot(path);
      const report = await api.scanLibrary();
      await refresh();
      pushToast(
        `导入完成 · 新增 ${report.added} 本` +
          (report.failed ? ` · ${report.failed} 个失败` : ""),
      );
    } catch (e) {
      pushToast(errorText(e), "danger");
    } finally {
      setImporting(false);
    }
  }, [pushToast, refresh]);

  /*
   * 窗口级拖拽导入（桌面端）。
   *
   * 用 Tauri 的 webview 事件而不是 HTML5 的 drop：Tauri 拦截了原生拖放，
   * 页面根本收不到 dragover/drop，只有 onDragDropEvent 能拿到真实路径。
   * 拖入时给全窗口投放提示——只高亮某个小区域会让人以为别处不能放。
   */
  useEffect(() => {
    if (IS_MOBILE) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDropActive(true);
          } else if (payload.type === "drop") {
            setDropActive(false);
            void importPaths(payload.paths);
          } else {
            setDropActive(false);
          }
        }),
      )
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {
        /* 浏览器预览等非 Tauri 环境没有这个事件 */
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [importPaths]);

  const handleRemoveRoot = useCallback(
    async (id: number) => {
      try {
        await api.removeRoot(id);
        await refresh();
        pushToast("已移除目录，书籍记录会在下次扫描时清理");
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    },
    [pushToast, refresh],
  );

  const handleOpen = useCallback(
    async (book: Book) => {
      /*
       * 文件被外部移动 / 删除时，记录还在书架上。这时候进阅读页只会得到
       * 一个空白页加一句技术错误，所以先在这里拦下来问用户怎么办（UX §5.3）。
       */
      if (book.missing) {
        setMissingBook(book);
        return;
      }

      if (
        ![
          "txt",
          "md",
          "html",
          "epub",
          "mobi",
          "azw3",
          "fb2",
          "docx",
          "rtf",
          "mhtml",
          "pdf",
          "cbz",
          "cbr",
          "cbt",
          "cb7",
          "zip",
          "folder",
          "ofd",
          "xlsx",
        ].includes(book.format)
      ) {
        // 未知格式时别把 undefined 抛给用户
        pushToast(`${FORMAT_LABEL[book.format] ?? book.format} 阅读器还没接入`);
        return;
      }

      /*
       * MOBI 可能是文字书也可能是图片型漫画，且分类规则会随版本变化，
       * 老记录不会自动更新。打开前问一次后端，必要时当场纠正并刷新卡片，
       * 避免「明明是漫画却进了文字阅读器」。
       */
      let target = book;
      if (book.format === "mobi" || book.format === "azw3") {
        try {
          const kind = await api.bookKind(book.id);
          if (kind !== book.type) {
            target = { ...book, type: kind as Book["type"] };
            void refresh();
          }
        } catch (e) {
          // 判定失败就按原类型打开，不阻塞用户
          logWarn(`判定书籍类型失败：${errorText(e)}`);
        }
      }

      setReaderClosing(false);
      setReadingBook(target);
    },
    [pushToast, refresh],
  );

  /** 阅读中即时落库；刻意不 refresh 书架，避免 book 对象变化导致阅读器重载 */
  const handleProgress = useCallback(
    async (progress: Progress) => {
      if (!readingBook) return;
      try {
        await api.saveProgress(readingBook.id, progress);
      } catch (e) {
        // 进度保存失败不打断阅读，但这是会丢进度的错误，必须留痕
        logError(`保存进度失败：${errorText(e)}`);
      }
    },
    [readingBook],
  );

  const handleExitReader = useCallback(() => {
    // 连按返回键 / Esc 会重复触发，退场中直接忽略
    if (readerClosing) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setReadingBook(null);
      void refresh();
      return;
    }

    // 先播退场动画，结束后再卸载；书架一直在底下，淡出即露出
    setReaderClosing(true);
    window.setTimeout(() => {
      setReaderClosing(false);
      setReadingBook(null);
      void refresh();
    }, READER_EXIT_MS);
  }, [readerClosing, refresh]);

  useEffect(() => {
    openBookRef.current = handleOpen;
  }, [handleOpen]);

  /** 设置抽屉退场：同理，先播动画再卸载 */
  const closeSettings = useCallback(() => {
    if (settingsClosing) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setSettingsOpen(false);
      return;
    }

    setSettingsClosing(true);
    window.setTimeout(() => {
      setSettingsClosing(false);
      setSettingsOpen(false);
    }, 180);
  }, [settingsClosing]);


  // ---------------- 书籍操作（右键菜单） ----------------

  /** 把一本书移进隐私书架：标记 + 封面挪走，然后从公开书架消失 */
  const handleMakePrivate = useCallback(
    async (book: Book) => {
      try {
        await privacyApi.move(book.id);
        await refresh();
        refreshPrivacy();
        pushToast(`「${book.title}」已移入隐私书架`);
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    },
    [pushToast, refresh, refreshPrivacy],
  );

  const handleMenu = useCallback(
    (book: Book, x: number, y: number, anchor?: HTMLElement) => {
      setShelfMenu(null);
      /*
       * 只有键盘唤出（卡片此刻就是焦点）才记录归还点。
       * 鼠标右键不该抢焦点，关闭后还给它反而会让焦点圈莫名其妙地跳。
       */
      menuAnchor.current = anchor && document.activeElement === anchor ? anchor : null;
      setMenu({ book, x, y });
    },
    [],
  );

  const closeBookMenu = useCallback(() => {
    setMenu(null);
    /*
     * 延迟一帧再决定要不要还焦点：
     * 菜单项的 onClick 是「先 onClose、再执行动作」，若动作是打开对话框，
     * 那里会自行聚焦输入框，这里就不该再把焦点抢回卡片。
     * 判据直接看对话框是否已挂载（同一批次渲染，rAF 时 DOM 已更新）。
     */
    requestAnimationFrame(() => {
      const anchor = menuAnchor.current;
      menuAnchor.current = null;
      if (!anchor || !anchor.isConnected) return;
      if (document.querySelector(".dialog")) return;
      anchor.focus({ preventScroll: true });
    });
  }, []);

  /**
   * 重新定位：文件被移走、或删除事务中断后，把记录指回真实文件。
   * 只改路径，阅读进度与加入时间原样保留——用户要的是找回，不是重新入库。
   */
  const handleRelocate = useCallback(
    async (book: Book) => {
      /*
       * 移动端不能走 dialog.open：Android 的系统选择器返回 content:// URI，
       * 扫描器用 std::fs 读不到，而且 dialog 插件的 open 在移动端根本没实现。
       * 改为「选文件 → 复制进应用目录 → 把记录指过去」，和导入走同一套。
       */
      if (IS_MOBILE) {
        try {
          const files = await pickBookFiles();
          if (files.length === 0) return;
          const result = await saveFilesToLibrary(files.slice(0, 1));
          if (result.saved === 0 || result.paths.length === 0) {
            pushToast("重新定位失败，文件没能写入应用目录", "danger");
            return;
          }
          await api.relocateBook(book.id, result.paths[0]);
          await refresh();
          pushToast("已重新定位");
        } catch (e) {
          pushToast(errorText(e), "danger");
        }
        return;
      }

      let picked: string | string[] | null = null;
      try {
        picked = await openDialog({
          multiple: false,
          // 图片文件夹型书籍本身就是一个目录，选文件选不到它
          directory: book.format === "folder",
          title: `重新定位「${book.title}」`,
        });
      } catch (e) {
        pushToast(errorText(e), "danger");
        return;
      }
      if (!picked || Array.isArray(picked)) return;

      try {
        await api.relocateBook(book.id, picked);
        await refresh();
        pushToast("已重新定位");
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    },
    [pushToast, refresh],
  );

  const handleEdit = useCallback((book: Book) => {
    setEditTitle(book.title);
    setEditAuthor(book.author ?? "");
    setEditing(book);
  }, []);

  const saveMeta = useCallback(async () => {
    const book = editing;
    if (!book) return;

    const title = editTitle.trim();
    if (!title) {
      pushToast("书名不能为空", "danger");
      return;
    }

    try {
      await api.updateBookMeta(book.id, title, editAuthor.trim());
      setEditing(null);
      await refresh();
      pushToast("已保存");
    } catch (e) {
      pushToast(errorText(e), "danger");
    }
  }, [editing, editTitle, editAuthor, refresh, pushToast]);

  const handleReveal = useCallback(
    async (book: Book) => {
      // 菜单在手机上已隐藏该项，这里是兜底：opener 的 revealItemInDir 只有桌面端实现
      if (IS_MOBILE) return;
      try {
        await revealItemInDir(book.path);
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    },
    [pushToast],
  );

  /**
   * 移除一本书：删记录与缓存。
   * 用户自己的文件不动、5 秒内可撤销；库内副本（应用复制进来的那份）会被一并清掉，
   * 那种情况不给撤销——文件都没了，恢复只会得到一条「已丢失」的记录。
   */
  const handleRemove = useCallback(
    async (book: Book) => {
      // 单文件导入的书，根就是文件本身；删记录时会把根一并清掉，撤销要重新登记
      const wasRoot = roots.some((root) => root.path === book.path);
      try {
        const report = await api.removeBook(book.id, false);
        await refresh();
        if (report.removed_copy) {
          pushToast(`已移除「${book.title}」，库内副本已清理`, "info");
          return;
        }
        /*
         * 文件都已经不在了，撤销只会重新扫一遍再扫不出任何东西，
         * 却提示「已恢复到书架」——那是在骗人。这种情况干脆不给撤销键。
         */
        pushToast(
          `已从书架移除「${book.title}」`,
          "info",
          book.missing
            ? undefined
            : {
                label: "撤销",
                onClick: () => {
                  void (async () => {
                    try {
                      if (wasRoot) await api.addRoot(book.path);
                      await api.scanLibrary();
                      await refresh();
                      pushToast("已恢复到书架");
                    } catch (e) {
                      pushToast(errorText(e), "danger");
                    }
                  })();
                },
              },
        );
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    },
    [roots, refresh, pushToast],
  );

  const confirmDelete = useCallback(async () => {
    const book = pendingDelete;
    if (!book) {
      return;
    }
    setPendingDelete(null);
    try {
      const report = await api.removeBook(book.id, true);
      await refresh();
      if (report.pending) {
        // 删除事务只走完前半段：文件进了回收站，记录还在。如实说清楚，
        // 别让用户以为已经删干净了（UX §10.2）。
        pushToast("文件已移入回收站，但书库记录未能同步，已标记为「待恢复」", "danger");
      } else {
        pushToast(`已删除「${book.title}」，文件在回收站`);
      }
    } catch (e) {
      pushToast(errorText(e), "danger");
    }
  }, [pendingDelete, refresh, pushToast]);

  // 7.1 快捷键（阅读页内由 ReaderShell 接管）
  useEffect(() => {
    if (readingBook) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      /*
       * F11 全屏。WebView 不会自己处理这个键（WebView2 默认什么都不做），
       * 所以交给窗口 API；手机端没有「全屏」这个概念，忽略即可。
       * 放在 typing 判断之前：焦点在搜索框里时也该能全屏。
       */
      if (e.key === "F11" && !IS_MOBILE) {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (typing) return;
      if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (mod && e.key === "o") {
        e.preventDefault();
        void handleImport();
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleImport, toggleSidebar, readingBook]);

  /*
   * 书架背景图（v1.9）。
   *
   * 路径经 asset 协议转成 webview 能加载的 URL。图片不存在时 onError 置 true，
   * 整层不渲染——半透明图层下面没有图，只会留下一块比纸色更浅的脏区域，
   * 还不如什么都不显示。换图时重置，否则上次的失败状态会一直挡住新图。
   */
  const [bgBroken, setBgBroken] = useState(false);
  useEffect(() => setBgBroken(false), [prefs.background.path]);
  const shelfBg = bgBroken ? null : fileUrl(prefs.background.path);

  /*
   * 同时把标记写到 <html>：设置抽屉、书籍菜单、Toast 都挂在 app-shell 之外，
   * 只在外壳上打 data 属性它们一个都选不中，而那几处恰恰最需要
   * 「背后有图时退成实心」——玻璃浮在照片上，文字可读性没法保证。
   */
  useEffect(() => {
    const root = document.documentElement;
    if (shelfBg) root.dataset.shelfBg = "true";
    else delete root.dataset.shelfBg;
  }, [shelfBg]);

  /**
   * 标签一次取全量：清单给侧栏，映射给「哪本书有哪些标签」。
   * 逐本查会打出几百次 IPC，书架一滚动就卡。
   */
  const refreshTags = useCallback(async () => {
    try {
      const [list, pairs] = await Promise.all([tagApi.list(), tagApi.assignments()]);
      const map: Record<string, string[]> = {};
      for (const [bookId, tag] of pairs) (map[bookId] ??= []).push(tag);
      setTags(list);
      setTagMap(map);
    } catch (e) {
      // 标签失败不该挡住书架：记日志、保持旧值
      console.warn("读取标签失败", e);
    }
  }, []);

  useEffect(() => {
    void refreshTags();
  }, [refreshTags]);

  const saveTags = useCallback(
    async (book: Book, next: string[]) => {
      try {
        await tagApi.setForBook(book.id, next);
        setTagEditing(null);
        await refreshTags();
      } catch (e) {
        pushToast(errorText(e), "danger");
      }
    },
    [pushToast, refreshTags],
  );

  const counts = useMemo<Record<ShelfFilter, number>>(() => {
    const keys: ShelfFilter[] = ["all", "recent", "text", "ebook", "doc", "comic", "pdf"];
    const result = {} as Record<ShelfFilter, number>;
    for (const key of keys) {
      result[key] = books.filter((b) => matchesFilter(b, key)).length;
    }
    return result;
  }, [books]);

  // 统计用同一份 books 算，分类口径与侧栏完全一致
  const libraryStats = useMemo(() => computeStats(books), [books]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const collator = new Intl.Collator("zh-CN");

    // 分类规则集中在 lib/filters：侧栏与顶部下拉共用一套，避免口径漂移
    let list = books.filter((b) => matchesFilter(b, filter));

    // 标签筛与分类筛叠加：选「漫画 + 待读」得到的是既满足格式又贴了标签的那些
    if (tagFilter) {
      list = list.filter((b) => (tagMap[b.id] ?? []).includes(tagFilter));
    }

    if (q) {
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          (b.author ?? "").toLowerCase().includes(q),
      );
    }

    // UX §6.3：最近打开 / 添加时间 / 标题，标题按中文拼音排序
    const sorted = [...list];
    if (prefs.sort === "title") {
      sorted.sort((a, b) => collator.compare(a.title, b.title));
    } else if (prefs.sort === "added") {
      sorted.sort((a, b) => b.added_at - a.added_at);
    } else {
      sorted.sort(
        (a, b) =>
          (b.last_read_at ?? 0) - (a.last_read_at ?? 0) || b.added_at - a.added_at,
      );
    }
    return sorted;
  }, [books, filter, query, prefs.sort, tagFilter, tagMap]);

  const toggleSelect = useCallback((book: Book) => {
    setSelection((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });
  }, []);

  const exitSelection = useCallback(() => setSelection(null), []);

  /** 主操作：把选中的书批量移入隐私书架 */
  const moveSelectedToPrivate = useCallback(async () => {
    const ids = Array.from(selection ?? []);
    if (ids.length === 0) return;
    if (!privacy?.enabled || !privacy.unlocked) {
      pushToast("先在设置里启用并解锁隐私书架", "danger");
      return;
    }
    setMovingPrivacy(true);
    try {
      const moved = await privacyApi.moveMany(ids, true);
      await refresh();
      setSelection(null);
      pushToast(`已移入隐私书架 ${moved} 本`);
    } catch (e) {
      pushToast(errorText(e), "danger");
    } finally {
      setMovingPrivacy(false);
    }
  }, [privacy?.enabled, privacy?.unlocked, pushToast, refresh, selection]);

  /**
   * 批量导出：把选中的书复制到用户挑的文件夹。
   *
   * 复制而不是移动——「导出」这个词本身就不含删除的意思。
   * 目标目录里已有同名文件时后端会加 (1) 后缀，不覆盖。
   */
  const exportSelected = useCallback(async () => {
    const ids = Array.from(selection ?? []);
    if (ids.length === 0) return;
    if (IS_MOBILE) {
      pushToast("移动端没有文件夹选择器，导出请到电脑上操作", "danger");
      return;
    }
    try {
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "导出到哪个文件夹",
      });
      if (typeof dir !== "string") return;
      setExportingBooks(true);
      const report = await api.exportBooks(ids, dir);
      const parts = [`已导出 ${report.copied} 本`];
      if (report.renamed > 0) parts.push(`${report.renamed} 本重名已改名`);
      if (report.missing.length > 0) parts.push(`${report.missing.length} 本文件不在本地`);
      if (report.failed.length > 0) parts.push(`${report.failed.length} 本复制失败`);
      pushToast(parts.join("，"), report.failed.length > 0 ? "danger" : "info");
      if (report.copied > 0) setSelection(null);
    } catch (e) {
      pushToast(errorText(e), "danger");
    } finally {
      setExportingBooks(false);
    }
  }, [pushToast, selection]);

  const body =
    loading ? (
      <ShelfSkeleton />
    ) : visible.length > 0 || pendingImports.length > 0 ? (
      prefs.view === "grid" ? (
        <div className="shelf-grid">
          {pendingImports.map((item) => (
            <ImportCard key={item.key} item={item} />
          ))}
          {visible.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onOpen={handleOpen}
              onMenu={handleMenu}
              coverRev={coverRev}
              selecting={selection !== null}
              selected={selection?.has(book.id) ?? false}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      ) : (
        <ShelfList
          books={visible}
          onOpen={handleOpen}
          onMenu={handleMenu}
          coverRev={coverRev}
          pending={pendingImports}
        />
      )
    ) : (
      <EmptyState
        variant={books.length === 0 ? "empty-library" : "no-match"}
        hasQuery={query.trim().length > 0}
        onImport={handleImport}
        onImportFolder={handleImportFolder}
        onClearQuery={() => setQuery("")}
        onShowAll={() => {
          setFilter("all");
          setTagFilter(null);
        }}
        tagLabel={tagFilter}
      />
    );

  const settingsNode = settingsOpen ? (
    <SettingsDrawer
      prefs={prefs}
      onPrefs={setPrefs}
      roots={roots}
      /* 「添加目录」必须是选目录：此前接的是 handleImport（选文件），
         点进去只能挑单个文件，把书库页的主操作变成了文件导入。 */
      onAddRoot={handleImportFolder}
      onRemoveRoot={handleRemoveRoot}
      onScan={() => void runScan()}
      scanning={importing}
      stats={libraryStats}
      onToast={pushToast}
      onCoversRebuilt={() => {
        // 先重载数据（cover_path 可能变化），再递增版本号强制重取图片
        void refresh();
        setCoverRev((v) => v + 1);
      }}
      onRestored={() => {
        // 备份恢复是整库换过：记录、进度、封面全变了
        void refresh();
        refreshPrivacy();
        setCoverRev((v) => v + 1);
      }}
      onOpenPrivateShelf={() => {
        // 先收抽屉再开覆盖层：两层叠在一起时 Esc / 焦点归属会很别扭
        setSettingsOpen(false);
        setPrivateOpen(true);
      }}
      closing={settingsClosing}
      onClose={closeSettings}
    />
  ) : null;

  const readerNode = readingBook ? (
    <div className="reader-transition" data-closing={readerClosing}>
      {readingBook.format === "ofd" ? (
        <OfdViewer
          book={readingBook}
          onExit={handleExitReader}
          onProgress={handleProgress}
        />
      ) : readingBook.type === "pdf" ? (
          <PdfViewer
            book={readingBook}
            onExit={handleExitReader}
            onProgress={handleProgress}
            spreadPref={prefs.spreadMode}
            onSpreadPref={(value) => setPrefs({ spreadMode: value })}
            modePref={prefs.pdfMode}
            onModePref={(value) => setPrefs({ pdfMode: value })}
          />
        ) : readingBook.type === "comic" ? (
          <ComicViewer
            book={readingBook}
            onExit={handleExitReader}
            onProgress={handleProgress}
            coverAlign={prefs.spreadCover}
            spreadPref={prefs.spreadMode}
            onSpreadPref={(value) => setPrefs({ spreadMode: value })}
            dirHint={prefs.comicDirHint}
          />
        ) : (["html", "md", "docx", "xlsx"] as BookFormat[]).includes(
            readingBook.format,
          ) ? (
          <HtmlViewer
            book={readingBook}
            // Markdown / Word / Excel 在后端都已转成 HTML，差别只在取数据的方式
            source={richSource(readingBook.format)}
            // 笔记类文档只给滚动：长代码块与表格被页边界切断比「翻页」难读得多
            scrollOnly={readingBook.format === "md"}
            prefs={prefs}
            onExit={handleExitReader}
            onProgress={handleProgress}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : readingBook.format === "epub" ? (
          <EpubViewer
            book={readingBook}
            prefs={prefs}
            onExit={handleExitReader}
            onProgress={handleProgress}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <ReaderShell
            book={readingBook}
            prefs={prefs}
            onExit={handleExitReader}
            onProgress={handleProgress}
            onOpenSettings={() => setSettingsOpen(true)}
  
          />
        )}
    </div>
  ) : null;

  return (
    <>
      <div
        ref={shellRef}
        className="app-shell"
        data-sidebar={prefs.sidebar === "auto" ? undefined : prefs.sidebar}
        data-shelf-bg={shelfBg ? "true" : undefined}
      >
        {/*
         * 背景图放在外壳第一个子元素：DOM 顺序即层级（纸色底 → 图 → 遮罩 → 内容）。
         * 不用 z-index 负数，因为 .app-shell 自身有底色，负层会被它盖住。
         */}
        {shelfBg && (
          <div
            className="shelf-bg-layer"
            data-scrim={prefs.background.scrim ? "true" : "false"}
            aria-hidden="true"
          >
            <img
              className="shelf-bg"
              src={shelfBg}
              alt=""
              draggable={false}
              style={{
                // auto 与 cover 同一个行为：背景图的默认期待是铺满，留白不像壁纸
                objectFit: prefs.background.fit === "auto" ? "cover" : prefs.background.fit,
                opacity: prefs.background.opacity / 100,
                filter: prefs.background.blur > 0 ? `blur(${prefs.background.blur}px)` : undefined,
              }}
              onError={() => setBgBroken(true)}
            />
          </div>
        )}

        <TopBar
        filter={filter}
        onFilter={(value) => setFilter(value as ShelfFilter)}
        sort={prefs.sort}
        onSort={(value) => setPrefs({ sort: value })}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        onToggleSidebar={toggleSidebar}
        view={prefs.view}
        onView={(view) => setPrefs({ view })}
        onImport={handleImport}
        onSelectMode={() => setSelection(new Set())}
        canSelect={visible.length > 0 && selection === null}
        onOpenSettings={() => setSettingsOpen(true)}
        importing={importing}
        onBrandLongPress={() => setPrivateOpen(true)}
        settingsOpen={settingsOpen}
      />

      {importing && (
        <div className="import-progress" aria-hidden="true">
          <span />
        </div>
      )}

      {dropActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-target">
            <UploadCloud size={30} strokeWidth={1.8} />
            <div className="drop-title">松开即可导入</div>
          </div>
        </div>
      )}

      <div className="shelf-body">
        <Sidebar
          filter={filter}
          onChange={setFilter}
          counts={counts}
          onAddFolder={handleImportFolder}
          tags={tags}
          tag={tagFilter}
          onTag={setTagFilter}
        />
        <main
          className="content"
          onContextMenu={(e) => {
            const target = e.target as Element | null;
            // 卡片 / 按钮 / 输入框各有自己的语义，不弹书架菜单
            if (target?.closest(".book-card, .shelf-row, button, a, input, textarea")) return;
            e.preventDefault();
            setMenu(null);
            setShelfMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <div className="content-inner">
            {tagFilter && (
              <div className="tag-filter-bar">
                <span className="tag-filter-label">标签</span>
                <span className="tag-chip tag-chip-static">{tagFilter}</span>
                <button
                  className="tag-filter-clear"
                  onClick={() => setTagFilter(null)}
                  aria-label="清除标签筛选"
                >
                  清除
                </button>
              </div>
            )}
            {body}
          </div>

          {selection !== null && (
            <SelectionBar
              count={selection.size}
              total={visible.length}
              actionLabel="移入隐私书架"
              onAction={() => void moveSelectedToPrivate()}
              secondary={
                IS_MOBILE
                  ? undefined
                  : { label: "导出文件…", onAction: () => void exportSelected(), busy: exportingBooks }
              }
              onSelectAll={() => setSelection(new Set(visible.map((b) => b.id)))}
              onClearAll={() => setSelection(new Set())}
              onExit={exitSelection}
              busy={movingPrivacy}
            />
          )}
        </main>
      </div>

      </div>

      {readerNode}
      {settingsNode}

      {shelfMenu && (
        <ShelfMenu
          x={shelfMenu.x}
          y={shelfMenu.y}
          showFolderImport={!IS_MOBILE}
          scanning={importing}
          onImportFiles={handleImport}
          onImportFolder={handleImportFolder}
          onScan={() => void runScan()}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setShelfMenu(null)}
        />
      )}

      {menu && (
        <BookMenu
          book={menu.book}
          x={menu.x}
          y={menu.y}
          onOpen={handleOpen}
          onReveal={handleReveal}
          onEdit={handleEdit}
          onTag={(b) => setTagEditing(b)}
          onRelocate={(b) => void handleRelocate(b)}
          onRemove={handleRemove}
          onDelete={setPendingDelete}
          onMakePrivate={
            privacy?.enabled && privacy.unlocked ? (b) => void handleMakePrivate(b) : undefined
          }
          onClose={closeBookMenu}
        />
      )}

      {missingBook && (
        <Dialog
          title={missingBook.status === "pending" ? "文件待恢复" : "文件已丢失"}
          confirmLabel="重新定位"
          cancelLabel="关闭"
          extraLabel={missingBook.status === "pending" ? "移除记录" : "从书架移除"}
          onConfirm={() => {
            const book = missingBook;
            setMissingBook(null);
            void handleRelocate(book);
          }}
          onExtra={() => {
            const book = missingBook;
            setMissingBook(null);
            handleRemove(book);
          }}
          onCancel={() => setMissingBook(null)}
        >
          {missingBook.status === "pending" ? (
            <>
              上次删除时文件已移入回收站，但书库记录没能同步清理。可以把它重新定位到
              文件所在位置，或直接移除这条记录。
            </>
          ) : (
            <>
              在原位置找不到「{missingBook.title}」，它可能被移动、重命名或删除了。
            </>
          )}
          <div className="dialog-path">{missingBook.path}</div>
        </Dialog>
      )}

      {tagEditing && (
        <TagDialog
          bookTitle={tagEditing.title}
          value={tagMap[tagEditing.id] ?? []}
          suggestions={tags.map((t) => t.name)}
          onSave={(next) => void saveTags(tagEditing, next)}
          onClose={() => setTagEditing(null)}
        />
      )}

      {editing && (
        <Dialog
          title="编辑信息"
          confirmLabel="保存"
          onConfirm={() => void saveMeta()}
          onCancel={() => setEditing(null)}
        >
          <div className="dialog-form">
            <label className="field-label" htmlFor="edit-book-title">
              书名
            </label>
            <input
              id="edit-book-title"
              className="input"
              value={editTitle}
              autoFocus
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveMeta();
              }}
            />

            <label className="field-label" htmlFor="edit-book-author">
              作者
            </label>
            <input
              id="edit-book-author"
              className="input"
              value={editAuthor}
              placeholder="可留空"
              onChange={(e) => setEditAuthor(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveMeta();
              }}
            />

            <div className="field-hint">
              保存后会锁定书名，之后重新扫描不再用文件名覆盖它。
            </div>
          </div>
        </Dialog>
      )}

      {privateOpen && (
        <PrivateShelf
          onClose={() => {
            setPrivateOpen(false);
            // 关掉之后状态可能变了（锁 / 移出），刷新一次菜单的可见性
            refreshPrivacy();
          }}
          onOpenBook={(book) => {
            setPrivateOpen(false);
            void handleOpen(book);
          }}
          onChanged={() => {
            void refresh();
            refreshPrivacy();
          }}
          onOpenSettings={() => {
            setPrivateOpen(false);
            setSettingsOpen(true);
          }}
          onToast={pushToast}
        />
      )}

      {pendingDelete && (
        <Dialog
          title="删除本地文件"
          confirmLabel="删除本地文件"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        >
          <div className="dialog-text">
            {IS_MOBILE
              ? `将从书架移除「${pendingDelete.title}」并永久删除该文件，无法撤销。`
              : `将把「${pendingDelete.title}」移入系统回收站，并从书架移除。`}
          </div>
          <div className="dialog-path">{pendingDelete.path}</div>
        </Dialog>
      )}

      {importFailures && (
        <Dialog
          title={`导入失败 ${importFailures.length} 个`}
          confirmLabel="知道了"
          hideCancel
          onConfirm={() => setImportFailures(null)}
          onCancel={() => setImportFailures(null)}
        >
          <div className="import-failure-list">
            {importFailures.map((f) => (
              <div className="import-failure" key={f.path}>
                <div className="import-failure-name">{fileNameOf(f.path)}</div>
                <div className="import-failure-reason">{f.message}</div>
                <div className="dialog-path">{f.path}</div>
              </div>
            ))}
          </div>
          {importFailures.length >= 20 && (
            <div className="import-failure-more">仅列出前 20 条，其余同类问题不再重复。</div>
          )}
        </Dialog>
      )}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}
