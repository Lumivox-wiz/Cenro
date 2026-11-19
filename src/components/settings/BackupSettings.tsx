import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  CloudUpload,
  HardDriveDownload,
  RefreshCw,
  Trash2,
  UploadCloud,
  Zap,
} from "lucide-react";
import {
  backupApi,
  errorText,
  type BackupConfig,
  type LocalBackup,
  type RemoteBackup,
  type WebdavConfig,
} from "../../api";
import { formatRecent, formatSize } from "../../lib/format";
import { IS_MOBILE } from "../../lib/platform";
import { pickBackupArchive } from "../../lib/mobileImport";
import Dialog from "../ui/Dialog";

interface Props {
  onToast: (text: string, tone?: "info" | "danger") => void;
  /** 恢复后用备份里的记录覆盖了书架，需要重载 */
  onRestored: () => void;
  /** 打开 / 关闭二次确认框时通知外壳：抽屉要让出 Esc 与焦点 */
  onModal: (open: boolean) => void;
}

/** 等用户回答「要不要备份隐私书」的那个动作 */
type PendingBackup =
  | { mode: "local"; quick: boolean; privateBooks: number }
  | { mode: "remote"; privateBooks: number };

type Confirm =
  | { kind: "restore-local"; path: string; label: string }
  | { kind: "restore-remote"; name: string }
  | { kind: "delete-local"; path: string; label: string }
  | { kind: "delete-remote"; name: string };

const EMPTY_WEBDAV: WebdavConfig = {
  url: "",
  username: "",
  password: "",
  dir: "cenro",
  keep: 5,
};

/** 本地时间 → `20261115-192312`，与后端的文件名格式对齐 */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

/**
 * 备份子页：本地 zip + WebDAV。
 *
 * 两条链路共用同一套包格式（manifest.json + cenro.db + covers/），
 * 所以「备份到本地」的包可以原样丢到网盘，「云端恢复」也能读本地文件。
 */
export default function BackupSettings({ onToast, onRestored, onModal }: Props) {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [draft, setDraft] = useState<WebdavConfig>(EMPTY_WEBDAV);
  const [includeCovers, setIncludeCovers] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [localList, setLocalList] = useState<LocalBackup[]>([]);
  const [remoteList, setRemoteList] = useState<RemoteBackup[] | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** 备份前发现隐私书：先问「要不要一并备份」再动手 */
  const [ask, setAsk] = useState<PendingBackup | null>(null);
  /** 详情展开：密码默认遮起来，但允许看一眼，避免「打错一个字查不出」 */
  const [showPassword, setShowPassword] = useState(false);

  const configRef = useRef<BackupConfig | null>(null);
  const draftRef = useRef<WebdavConfig>(EMPTY_WEBDAV);
  const coversRef = useRef(true);
  draftRef.current = draft;
  coversRef.current = includeCovers;

  const refreshLocal = useCallback(async () => {
    try {
      setLocalList(await backupApi.listLocal());
    } catch {
      /* 列目录失败不影响其它操作 */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    backupApi
      .config()
      .then((cfg) => {
        if (!alive) return;
        configRef.current = cfg;
        setConfig(cfg);
        setDraft({ ...EMPTY_WEBDAV, ...cfg.webdav });
        setIncludeCovers(cfg.include_covers);
      })
      .catch(() => {
        /* 非 Tauri 环境（浏览器预览）没有这些命令 */
      });
    void refreshLocal();
    return () => {
      alive = false;
    };
  }, [refreshLocal]);

  /** 落盘配置。地址 / 账号 / 密码都存本机，下次打开不用重填。 */
  const persist = useCallback((patch: Partial<BackupConfig> = {}) => {
    const base = configRef.current;
    if (!base) return;
    const next: BackupConfig = {
      ...base,
      webdav: draftRef.current,
      include_covers: coversRef.current,
      ...patch,
    };
    configRef.current = next;
    setConfig(next);
    void backupApi.saveConfig(next).catch(() => {
      /* 配置写失败只影响下次是否要重填 */
    });
  }, []);

  // 输入即存（去抖）：用户改完地址直接关抽屉也不会丢
  useEffect(() => {
    if (!configRef.current) return;
    const timer = window.setTimeout(() => persist(), 600);
    return () => window.clearTimeout(timer);
  }, [draft, includeCovers, persist]);

  const openModal = useCallback(
    (next: Confirm) => {
      setConfirm(next);
      onModal(true);
    },
    [onModal],
  );

  const closeModal = useCallback(() => {
    setConfirm(null);
    onModal(false);
  }, [onModal]);

  // ---------------- 本地 ----------------

  /**
   * `quick = true` 时不弹保存框，直接写进应用数据目录的 backups/。
   * 每天备份的人不该每次都点一遍另存为；想自己选位置的走完整流程。
   */
  const runLocalExport = useCallback(
    async (quick: boolean, includePrivate: boolean) => {
      setBusy("export");
      try {
        let target: string | null = null;
        if (!quick && !IS_MOBILE) {
          const picked = await saveDialog({
            title: "保存备份",
            defaultPath: `cenro-backup-${fileStamp()}.zip`,
            filters: [{ name: "岑序备份包", extensions: ["zip"] }],
          });
          // 取消保存：静默退出，不提示「失败」
          if (!picked) return;
          target = picked;
        }

        const report = await backupApi.export(target, includeCovers, includePrivate);
        persist({ last_local_at: report.created_at });
        await refreshLocal();
        onToast(
          `备份完成 · ${report.books} 本 · ${formatSize(report.bytes)}` +
            (report.private_books > 0 ? ` · 含 ${report.private_books} 本隐私书` : ""),
        );
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(null);
      }
    },
    [includeCovers, onToast, persist, refreshLocal],
  );

  /**
   * 备份前的一次范围确认。
   *
   * 有隐私书就先问，不问就直接按「不含隐私书」跑——**默认必须在安全的一侧**：
   * 用户点「备份」时最坏的误操作是隐私书上了云，不是少备份两本。
   * 没有隐私书时不打扰（绝大多数用户看不到这个对话框）。
   */
  const startLocal = useCallback(
    async (quick: boolean) => {
      try {
        const scope = await backupApi.scope();
        if (scope.private_books > 0) {
          setAsk({ mode: "local", quick, privateBooks: scope.private_books });
          onModal(true);
          return;
        }
      } catch (e) {
        onToast(errorText(e), "danger");
        return;
      }
      await runLocalExport(quick, false);
    },
    [onModal, onToast, runLocalExport],
  );

  const runRestore = useCallback(
    async (path: string) => {
      setBusy("restore");
      try {
        const report = await backupApi.restore(path);
        await refreshLocal();
        onRestored();
        onToast(
          `已恢复 ${report.books} 本 · ${report.covers} 张封面` +
            (report.private_books > 0 ? ` · 其中 ${report.private_books} 本在隐私书架` : "") +
            (report.covers === 0 ? "（封面可在「书库」页重建）" : ""),
        );
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(null);
      }
    },
    [onRestored, onToast, refreshLocal],
  );

  /*
   * 选一个备份包来恢复。
   *
   * 桌面走 dialog（能直接读任意路径）；手机没有文件夹选择器，
   * Android 的 content:// URI 也喂不进 std::fs，所以走 <input type=file>：
   * 拿字节 → 落进应用的 backups/ → 再把路径交给后端。
   */
  const pickFileToRestore = useCallback(async () => {
    if (IS_MOBILE) {
      try {
        const path = await pickBackupArchive();
        // 用户取消：静默返回
        if (!path) return;
        openModal({ kind: "restore-local", path, label: path.split(/[\\/]/).pop() ?? path });
      } catch (e) {
        onToast(errorText(e), "danger");
      }
      return;
    }

    try {
      const picked = await openDialog({
        title: "选择备份包",
        multiple: false,
        directory: false,
        filters: [{ name: "岑序备份包", extensions: ["zip"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      openModal({ kind: "restore-local", path, label: path.split(/[\\/]/).pop() ?? path });
    } catch (e) {
      onToast(errorText(e), "danger");
    }
  }, [onModal, onToast]);

  // ---------------- WebDAV ----------------

  const urlReady = draft.url.trim().length > 0;

  const testConnection = useCallback(async () => {
    setBusy("test");
    try {
      persist();
      onToast(await backupApi.test(draft));
    } catch (e) {
      onToast(errorText(e), "danger");
    } finally {
      setBusy(null);
    }
  }, [draft, onToast, persist]);

  const runUpload = useCallback(
    async (includePrivate: boolean) => {
      setBusy("upload");
      try {
        const report = await backupApi.upload(draft, includeCovers, includePrivate);
        persist({ last_webdav_at: report.created_at });
        onToast(
          `已上传 ${formatSize(report.bytes)} · ${report.books} 本` +
            (report.private_books > 0 ? ` · 含 ${report.private_books} 本隐私书` : ""),
        );
        setRemoteList(await backupApi.list(draft));
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(null);
      }
    },
    [draft, includeCovers, onToast, persist],
  );

  /** 上传前同样先确认范围：云端是别人也能碰到的地方，问一次更该问 */
  const startUpload = useCallback(async () => {
    try {
      const scope = await backupApi.scope();
      if (scope.private_books > 0) {
        setAsk({ mode: "remote", privateBooks: scope.private_books });
        onModal(true);
        return;
      }
    } catch (e) {
      onToast(errorText(e), "danger");
      return;
    }
    await runUpload(false);
  }, [onModal, onToast, runUpload]);

  /** 取消：什么都不做，连备份都不发起 */
  const closeAsk = useCallback(() => {
    setAsk(null);
    onModal(false);
  }, [onModal]);

  /** 用户在「要不要备份隐私书」里做的选择 */
  const resolveAsk = useCallback(
    async (includePrivate: boolean) => {
      const pending = ask;
      setAsk(null);
      onModal(false);
      if (!pending) return;
      if (pending.mode === "local") await runLocalExport(pending.quick, includePrivate);
      else await runUpload(includePrivate);
    },
    [ask, onModal, runLocalExport, runUpload],
  );

  const loadRemote = useCallback(async () => {
    setBusy("list");
    try {
      persist();
      setRemoteList(await backupApi.list(draft));
    } catch (e) {
      onToast(errorText(e), "danger");
    } finally {
      setBusy(null);
    }
  }, [draft, onToast, persist]);

  const runRemoteRestore = useCallback(
    async (name: string) => {
      setBusy("restore");
      try {
        const report = await backupApi.restoreRemote(draft, name);
        onRestored();
        onToast(`已从云端恢复 ${report.books} 本`);
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(null);
      }
    },
    [draft, onRestored, onToast],
  );

  const removeRemote = useCallback(
    async (name: string) => {
      setBusy("delete");
      try {
        await backupApi.remove(draft, name);
        setRemoteList(await backupApi.list(draft));
        onToast("已删除云端备份");
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(null);
      }
    },
    [draft, onToast],
  );

  const removeLocal = useCallback(
    async (path: string) => {
      setBusy("delete");
      try {
        await backupApi.deleteLocal(path);
        await refreshLocal();
        onToast("已删除备份包");
      } catch (e) {
        onToast(errorText(e), "danger");
      } finally {
        setBusy(null);
      }
    },
    [onToast, refreshLocal],
  );

  const doConfirm = useCallback(async () => {
    const action = confirm;
    closeModal();
    if (!action) return;
    if (action.kind === "restore-local") await runRestore(action.path);
    else if (action.kind === "restore-remote") await runRemoteRestore(action.name);
    else if (action.kind === "delete-remote") await removeRemote(action.name);
    else if (action.kind === "delete-local") await removeLocal(action.path);
  }, [
    closeModal,
    confirm,
    removeLocal,
    removeRemote,
    runRemoteRestore,
    runRestore,
  ]);

  const lastLocal = useMemo(() => formatRecent(config?.last_local_at ?? null), [config]);
  const lastRemote = useMemo(() => formatRecent(config?.last_webdav_at ?? null), [config]);
  const disabled = busy !== null;

  return (
    <>
      <section className="drawer-section">
        <div className="section-title">本地备份</div>

        <div className="field-row">
          <span className="field-label">上次备份</span>
          <span className="field-value">{lastLocal}</span>
        </div>

        <label className="backup-check">
          <input
            type="checkbox"
            checked={includeCovers}
            onChange={(e) => setIncludeCovers(e.target.checked)}
          />
          包含封面缩略图（关掉可显著减小备份体积）
        </label>

        <div className="option-group">
          <button
            className="btn btn-secondary"
            onClick={() => void startLocal(IS_MOBILE)}
            disabled={disabled}
          >
            <HardDriveDownload size={16} strokeWidth={2} />
            {busy === "export" ? "正在打包…" : IS_MOBILE ? "备份到应用目录" : "另存为…"}
          </button>
          {!IS_MOBILE && (
            <button
              className="btn btn-secondary"
              onClick={() => void startLocal(true)}
              disabled={disabled}
            >
              <Zap size={16} strokeWidth={2} />
              快速备份
            </button>
          )}
          {/* 两端都有：桌面走系统对话框，手机走 <input type=file> 再落盘 */}
          <button
            className="btn btn-secondary"
            onClick={() => void pickFileToRestore()}
            disabled={disabled}
          >
            <UploadCloud size={16} strokeWidth={2} />
            从文件恢复
          </button>
          {IS_MOBILE && (
            <button
              className="btn btn-secondary"
              onClick={() => void refreshLocal()}
              disabled={disabled}
            >
              <RefreshCw size={16} strokeWidth={2} />
              刷新列表
            </button>
          )}
        </div>

        {localList.length === 0 && (
          <div className="field-hint">
            应用目录里还没有备份包。点「从文件恢复」可以选一个别处导出的 zip。
          </div>
        )}

        {localList.length > 0 && (
          <>
            <div className="field-hint">应用目录下的备份包</div>
            {localList.map((item) => (
              <div className="root-row" key={item.path}>
                <span className="root-path">
                  {item.name}
                  <span className="backup-row-meta">
                    {formatSize(item.bytes)} · {formatRecent(item.created_at)}
                  </span>
                </span>
                <button
                  className="btn btn-ghost"
                  onClick={() => openModal({ kind: "restore-local", path: item.path, label: item.name })}
                  disabled={disabled}
                >
                  恢复
                </button>
                <button
                  className="icon-btn"
                  onClick={() => openModal({ kind: "delete-local", path: item.path, label: item.name })}
                  disabled={disabled}
                  aria-label={`删除备份包 ${item.name}`}
                  title="删除"
                >
                  <Trash2 size={16} strokeWidth={2} />
                </button>
              </div>
            ))}
          </>
        )}

        <div className="field-hint">
          备份包含书架记录、书名作者、阅读进度与封面；书籍文件本身不打进包里，
          恢复后仍按原路径查找，换了电脑需要重新添加书库目录。
        </div>
      </section>

      <section className="drawer-section">
        <div className="section-title">WebDAV</div>

        <div className="backup-form">
          <label className="field-label" htmlFor="dav-url">
            服务器地址
          </label>
          <input
            id="dav-url"
            className="input"
            placeholder="https://dav.example.com/dav"
            spellCheck={false}
            autoComplete="off"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
          />

          <div className="backup-pair">
            <div>
              <label className="field-label" htmlFor="dav-user">
                用户名
              </label>
              <input
                id="dav-user"
                className="input"
                spellCheck={false}
                autoComplete="username"
                value={draft.username}
                onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="dav-pass">
                密码
              </label>
              <div className="backup-pass">
                <input
                  id="dav-pass"
                  className="input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={draft.password}
                  onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
                />
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </div>
            </div>
          </div>

          <div className="backup-pair">
            <div>
              <label className="field-label" htmlFor="dav-dir">
                远端目录
              </label>
              <input
                id="dav-dir"
                className="input"
                placeholder="cenro"
                spellCheck={false}
                value={draft.dir}
                onChange={(e) => setDraft((d) => ({ ...d, dir: e.target.value }))}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="dav-keep">
                保留份数
              </label>
              <input
                id="dav-keep"
                className="input"
                type="number"
                min={0}
                max={50}
                value={draft.keep}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setDraft((d) => ({ ...d, keep: Number.isFinite(n) ? n : 0 }));
                }}
              />
            </div>
          </div>

          <div className="field-hint">
            地址填 WebDAV 根路径。Nextcloud 形如 https://主机/remote.php/dav/files/用户名；
            坚果云要用「应用密码」，不是登录密码。保留 0 份表示不清理旧备份。
          </div>
        </div>

        <div className="option-group">
          <button className="btn btn-secondary" onClick={() => void testConnection()} disabled={!urlReady || disabled}>
            {busy === "test" ? "正在连接…" : "测试连接"}
          </button>
          <button className="btn btn-primary" onClick={() => void startUpload()} disabled={!urlReady || disabled}>
            <CloudUpload size={16} strokeWidth={2} />
            {busy === "upload" ? "正在上传…" : "备份到云端"}
          </button>
          <button className="btn btn-ghost" onClick={() => void loadRemote()} disabled={!urlReady || disabled}>
            {busy === "list" ? "读取中…" : "查看云端备份"}
          </button>
        </div>

        <div className="field-row">
          <span className="field-label">上次上传</span>
          <span className="field-value">{lastRemote}</span>
        </div>

        {remoteList !== null && (
          <>
            <div className="field-hint">
              {remoteList.length === 0 ? "云端目录里还没有备份。" : `云端共 ${remoteList.length} 份`}
            </div>
            {remoteList.map((item) => (
              <div className="root-row" key={item.name}>
                <span className="root-path">
                  {item.name}
                  <span className="backup-row-meta">
                    {formatSize(item.bytes)}
                    {item.modified ? ` · ${item.modified}` : ""}
                  </span>
                </span>
                <button
                  className="btn btn-ghost"
                  onClick={() => openModal({ kind: "restore-remote", name: item.name })}
                  disabled={disabled}
                >
                  恢复
                </button>
                <button
                  className="icon-btn"
                  onClick={() => openModal({ kind: "delete-remote", name: item.name })}
                  disabled={disabled}
                  aria-label={`删除云端备份 ${item.name}`}
                  title="删除"
                >
                  <Trash2 size={16} strokeWidth={2} />
                </button>
              </div>
            ))}
          </>
        )}
      </section>

      {ask && (
        <Dialog
          title="备份包含隐私书架？"
          confirmLabel="只备份普通书架"
          extraLabel="一并备份"
          onConfirm={() => void resolveAsk(false)}
          onExtra={() => void resolveAsk(true)}
          onCancel={closeAsk}
        >
          隐私书架里有 {ask.privateBooks} 本。
          「一并备份」会把它们的书名、阅读进度与封面一起写进这个包
          {ask.mode === "remote" ? "，并上传到 WebDAV 服务器" : "，包在本地可以被解压看到"}。
          默认不包含隐私书。
        </Dialog>
      )}

      {confirm?.kind === "restore-local" && (
        <Dialog
          title="用备份覆盖书库？"
          confirmLabel="覆盖并恢复"
          danger
          onConfirm={() => void doConfirm()}
          onCancel={closeModal}
        >
          将用「{confirm.label}」里的书架记录、阅读进度与封面覆盖当前数据。
          本地书籍文件不会被删除，但当前书架里的记录会丢失。
        </Dialog>
      )}

      {confirm?.kind === "restore-remote" && (
        <Dialog
          title="从云端恢复？"
          confirmLabel="下载并覆盖"
          danger
          onConfirm={() => void doConfirm()}
          onCancel={closeModal}
        >
          将下载「{confirm.name}」并用它覆盖当前书架、阅读进度与封面。
          本地书籍文件不会被删除。
        </Dialog>
      )}

      {confirm?.kind === "delete-remote" && (
        <Dialog
          title="删除云端备份"
          confirmLabel="删除"
          danger
          onConfirm={() => void doConfirm()}
          onCancel={closeModal}
        >
          从服务器上删除「{confirm.name}」？这个操作不可撤销，本地书架不受影响。
        </Dialog>
      )}

      {/* 本地包的删除走同一条确认链；只允许删列表里给出的路径 */}
      {confirm?.kind === "delete-local" && (
        <Dialog
          title="删除备份包"
          confirmLabel="删除"
          danger
          onConfirm={() => void doConfirm()}
          onCancel={closeModal}
        >
          删除「{confirm.label}」？本地书架不受影响。
        </Dialog>
      )}
    </>
  );
}
