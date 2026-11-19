import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpenText,
  ChevronRight,
  CloudUpload,
  Image as ImageIcon,
  Info,
  Keyboard,
  Library,
  Lock,
  Palette,
  X,
  type LucideIcon,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { cacheApi, type CacheReport } from "../../api";
import { DEFAULT_PREFS, type Prefs } from "../../lib/prefs";
import type { LibraryStats } from "../../lib/stats";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { IS_MOBILE } from "../../lib/platform";
import type { LibraryRoot } from "../../types";
import Dialog from "../ui/Dialog";
import AboutSettings from "./AboutSettings";
import BackgroundSettings from "./BackgroundSettings";
import BackupSettings from "./BackupSettings";
import PrivacySettings from "./PrivacySettings";
import LibrarySettings from "./LibrarySettings";
import ReadingSettings from "./ReadingSettings";
import ShortcutsSettings from "./ShortcutsSettings";
import ThemeSettings from "./ThemeSettings";
import { THEME_OPTIONS, optionLabel } from "./shared";
import type { GroupId } from "./shared";

interface Props {
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  roots: LibraryRoot[];
  onAddRoot: () => void;
  onRemoveRoot: (id: number) => void;
  onScan: () => void;
  scanning: boolean;
  stats: LibraryStats;
  onToast: (text: string, tone?: "info" | "danger") => void;
  /** 封面重建后需要重载书架（图片 URL 不变，得靠 key 变化触发重新请求） */
  onCoversRebuilt: () => void;
  /** 从备份恢复后，书架记录整批换过，必须重载 */
  onRestored: () => void;
  /** 从「隐私」页直接进入隐私书架（手机上唯一入口） */
  onOpenPrivateShelf: () => void;
  /** 退场动画播放中 */
  closing?: boolean;
  onClose: () => void;
}

/** 设置分类。顺序即菜单顺序，与 UI §4.4 的分组一一对应 */
const GROUPS: { id: GroupId; label: string; icon: LucideIcon }[] = [
  { id: "reading", label: "阅读", icon: BookOpenText },
  { id: "theme", label: "主题", icon: Palette },
  { id: "background", label: "背景", icon: ImageIcon },
  { id: "library", label: "书库", icon: Library },
  { id: "backup", label: "备份", icon: CloudUpload },
  { id: "privacy", label: "隐私", icon: Lock },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
  { id: "about", label: "关于", icon: Info },
];

/**
 * 「恢复默认」只重置该组自己的键（UX §8.2）。
 * 书库 / 快捷键 / 关于没有可回退的偏好，故不出现在这张表里，也就不显示按钮。
 */
const RESET_PATCH: Partial<Record<GroupId, Partial<Prefs>>> = {
  reading: {
    readerFontSize: DEFAULT_PREFS.readerFontSize,
    readerLineHeight: DEFAULT_PREFS.readerLineHeight,
    readerPageWidth: DEFAULT_PREFS.readerPageWidth,
    spreadMode: DEFAULT_PREFS.spreadMode,
    pdfMode: DEFAULT_PREFS.pdfMode,
    spreadCover: DEFAULT_PREFS.spreadCover,
    comicDirHint: DEFAULT_PREFS.comicDirHint,
  },
  theme: {
    theme: DEFAULT_PREFS.theme,
    readerTheme: DEFAULT_PREFS.readerTheme,
  },
  background: {
    background: DEFAULT_PREFS.background,
    monet: DEFAULT_PREFS.monet,
  },
};

/**
 * 4.4 设置抽屉：两级结构。首页是分类菜单，点进去是该分类的子页，
 * 子页左上角返回。原先六段平铺要滚一整屏，手机上「关于」在第三屏之外。
 */
export default function SettingsDrawer({
  prefs,
  onPrefs,
  roots,
  onAddRoot,
  onRemoveRoot,
  onScan,
  scanning,
  stats,
  onToast,
  onCoversRebuilt,
  onRestored,
  onOpenPrivateShelf,
  closing = false,
  onClose,
}: Props) {
  const [page, setPage] = useState<GroupId | null>(null);
  /** 子页进场方向：进分类从右滑入，返回菜单从左滑入 */
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [confirmReset, setConfirmReset] = useState(false);
  /** 子页（备份）里开着确认框：抽屉要让出 Esc 与焦点 */
  const [modal, setModal] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Partial<Record<GroupId, HTMLButtonElement | null>>>({});
  /** 返回菜单后要把焦点还给进来时点的那一项 */
  const restoreTo = useRef<GroupId | null>(null);
  /*
   * 抽屉焦点陷阱（UX §8.1）：Tab 不出抽屉，关闭后回到触发元素。
   * 二次确认对话框打开时暂停——对话框自己接管键盘与焦点。
   */
  const drawerTrap = useFocusTrap(!confirmReset && !modal);

  const back = useCallback(() => {
    restoreTo.current = page;
    setDir("back");
    setPage(null);
  }, [page]);

  const open = useCallback((id: GroupId) => {
    setDir("fwd");
    setPage(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 二次确认开着时 Esc 归对话框，不能顺手把抽屉一起关了
      if (confirmReset || modal) return;
      e.preventDefault();
      e.stopPropagation();
      if (page) back();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [back, confirmReset, modal, onClose, page]);

  // 换页后滚回顶部，否则从长页返回会停在半截
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [page]);

  /*
   * 焦点跟着页面走：进分类时落到标题（读屏会念出新分类，且不需要给非交互元素画焦点环），
   * 返回时还给刚才那一项——键盘用户连按两次 Esc 之后不会莫名掉到 body。
   */
  useEffect(() => {
    if (page) {
      const raf = requestAnimationFrame(() => titleRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    const target = restoreTo.current;
    if (!target) return;
    restoreTo.current = null;
    const raf = requestAnimationFrame(() => itemRefs.current[target]?.focus());
    return () => cancelAnimationFrame(raf);
  }, [page]);

  // 缓存统计与版本号：菜单摘要与子页共用，抽屉打开时取一次
  const [cache, setCache] = useState<CacheReport | null>(null);
  const refreshCache = useCallback(() => {
    cacheApi
      .report()
      .then(setCache)
      .catch(() => {
        /* 统计失败不影响设置页其它功能 */
      });
  }, []);

  useEffect(() => {
    refreshCache();
  }, [refreshCache]);

  // 版本号只有一个来源：tauri.conf.json。运行时读，避免前端硬编码与之不同步。
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {
        /* 非 Tauri 环境（浏览器预览）拿不到，留空 */
      });
  }, []);

  const groups = GROUPS.filter((g) => !(IS_MOBILE && g.id === "shortcuts"));

  /*
   * 摘要只写「当前值」，不写「这页里有什么」。
   *
   * 原来的摘要是内容预告（"目录 · 缓存占用 · 封面重建"），子页里都有，
   * 预告一遍等于同一事实存两份——子页一改，摘要就撒谎（DX 单一真相源）。
   * 现在每格要么是真实当前值，要么留空。
   */
  const summary = (id: GroupId): string => {
    switch (id) {
      case "reading": {
        const fontLabel =
          { serif: "衬线", sans: "黑体", kai: "楷体", mono: "等宽" }[prefs.readerFont ?? "serif"] ??
          "衬线";
        return `${fontLabel} ${prefs.readerFontSize}px`;
      }
      case "theme":
        return optionLabel(THEME_OPTIONS, prefs.theme);
      case "background":
        return prefs.background.path ? "已设置" : "未设置";
      case "library":
        return roots.length === 0 ? "未添加" : `${roots.length} 个目录`;
      case "about":
        return version ? `v${version}` : "";
      default:
        // 备份 / 隐私 / 快捷键：没有「当前值」可写，留空。
        // 隐私的启用状态在后端（privacy_status），为一行摘要新增一次异步取数
        // 并不划算——它在隐私子页里本来就一目了然。
        return "";
    }
  };

  const activeLabel = page ? (GROUPS.find((g) => g.id === page)?.label ?? "设置") : "设置";
  const resetPatch = page ? RESET_PATCH[page] : undefined;

  const applyReset = useCallback(() => {
    if (page && RESET_PATCH[page]) onPrefs(RESET_PATCH[page] as Partial<Prefs>);
    setConfirmReset(false);
  }, [onPrefs, page]);

  return (
    <>
      <div className="overlay" data-closing={closing} onClick={onClose} />
      <aside
        className="drawer glass"
        data-closing={closing}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        ref={drawerTrap}
      >
        <div className="drawer-head">
          {/*
           * 只有一个退出入口：右上角的 X。
           * 原来左上角的返回箭头和 X 干的是同一件事，还占走了标题的位置。
           * 子页里把「设置」做成面包屑，点它回分类，比一个孤零零的箭头更说明位置。
           */}
          <span className="drawer-title" ref={titleRef} tabIndex={-1}>
            {page && (
              <button className="drawer-crumb" onClick={back}>
                设置
              </button>
            )}
            {page && <span className="drawer-crumb-sep">/</span>}
            {activeLabel}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭设置">
            <X size={20} strokeWidth={2} />
          </button>
        </div>

        <div className="drawer-body" ref={bodyRef}>
          {/* key 变化才会重放进场动画；方向由 dir 决定，避免返回时也从右滑 */}
          <div className="settings-page" key={page ?? "menu"} data-dir={dir}>
            {page === null ? (
              <nav className="settings-menu" aria-label="设置分类">
                {groups.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    className="settings-item"
                    ref={(el) => {
                      itemRefs.current[id] = el;
                    }}
                    onClick={() => open(id)}
                  >
                    <span className="settings-item-icon" aria-hidden="true">
                      <Icon size={18} strokeWidth={1.8} />
                    </span>
                    <span className="settings-item-text">
                      <span className="settings-item-label">{label}</span>
                      <span className="settings-item-summary">{summary(id)}</span>
                    </span>
                    <ChevronRight
                      className="settings-item-chevron"
                      size={16}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </nav>
            ) : (
              <>
                {page === "reading" && <ReadingSettings prefs={prefs} onPrefs={onPrefs} />}
                {page === "theme" && <ThemeSettings prefs={prefs} onPrefs={onPrefs} />}
                {page === "background" && (
                  <BackgroundSettings prefs={prefs} onPrefs={onPrefs} onToast={onToast} />
                )}
                {page === "library" && (
                  <LibrarySettings
                    stats={stats}
                    roots={roots}
                    onAddRoot={onAddRoot}
                    onRemoveRoot={onRemoveRoot}
                    onScan={onScan}
                    scanning={scanning}
                    cache={cache}
                    onCacheChange={refreshCache}
                    onCoversRebuilt={onCoversRebuilt}
                    onToast={onToast}
                  />
                )}
                {page === "backup" && (
                  <BackupSettings
                    onToast={onToast}
                    onRestored={onRestored}
                    onModal={setModal}
                  />
                )}
                {page === "privacy" && (
                  <PrivacySettings
                    onToast={onToast}
                    onChanged={onRestored}
                    onOpenShelf={onOpenPrivateShelf}
                  />
                )}
                {page === "shortcuts" && <ShortcutsSettings />}
                {page === "about" && (
                  <AboutSettings version={version} onNavigate={open} />
                )}

                {resetPatch && (
                  /*
                   * 作用域写进按钮本身，不靠旁边的句子解释。
                   * 原来这里挂着一句「只影响「X」页；单个分组可在标题右侧单独恢复」，
                   * 那句话存在的唯一原因是按钮只叫「恢复全部」——它和分组标题旁的
                   * 「恢复默认」同名不同域，读者只能靠解释分辨。
                   * 改成「恢复本页默认」后两个按钮不再同名，提示句自然可以删掉。
                   * 功能没变：仍然重置本页全部可回退项。
                   */
                  <div className="settings-reset">
                    <button className="btn btn-ghost" onClick={() => setConfirmReset(true)}>
                      恢复本页默认
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </aside>

      {confirmReset && (
        <Dialog
          title="恢复本页默认"
          confirmLabel="恢复本页默认"
          onConfirm={applyReset}
          onCancel={() => setConfirmReset(false)}
        >
          将「{activeLabel}」页的全部设置恢复为默认值？
          书架内容、阅读进度与本地文件都不受影响。
        </Dialog>
      )}
    </>
  );
}
