import { useCallback, useState } from "react";
import { FolderPlus, RefreshCw, Trash2 } from "lucide-react";
import { cacheApi, errorText, type CacheReport } from "../../api";
import { formatSize } from "../../lib/format";
import { IS_MOBILE } from "../../lib/platform";
import type { LibraryRoot } from "../../types";
import type { LibraryStats } from "../../lib/stats";

interface Props {
  roots: LibraryRoot[];
  onAddRoot: () => void;
  onRemoveRoot: (id: number) => void;
  onScan: () => void;
  scanning: boolean;
  cache: CacheReport | null;
  /** 阅读情况，由 App 用同一份书列表算好传进来 */
  stats: LibraryStats;
  /** 缓存统计有变化时通知外壳重取（顶部菜单的占用摘要也用它） */
  onCacheChange: () => void;
  /** 封面重建后需要重载书架 */
  onCoversRebuilt: () => void;
  onToast: (text: string, tone?: "info" | "danger") => void;
}

/** 书库子页：目录管理 → 缓存占用 → 维护动作。原先「缓存」是独立分组，收进来更贴合「书库的本机数据」 */
export default function LibrarySettings({
  roots,
  onAddRoot,
  onRemoveRoot,
  onScan,
  scanning,
  cache,
  stats,
  onCacheChange,
  onCoversRebuilt,
  onToast,
}: Props) {
  const [clearing, setClearing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const clearCache = useCallback(async () => {
    setClearing(true);
    try {
      const freed = await cacheApi.clear("all");
      onCacheChange();
      onToast(`已释放 ${formatSize(freed)}`);
    } catch (e) {
      onToast(errorText(e), "danger");
    } finally {
      setClearing(false);
    }
  }, [onCacheChange, onToast]);

  const rebuildCovers = useCallback(async () => {
    setRebuilding(true);
    try {
      const report = await cacheApi.rebuildCovers();
      onCacheChange();
      onCoversRebuilt();
      const parts = [`已重建 ${report.rebuilt} 张封面`];
      // placeholder 现在不是「空着」，而是按书名生成了文字封面
      if (report.placeholder > 0) parts.push(`${report.placeholder} 本按书名生成`);
      if (report.failed > 0) parts.push(`${report.failed} 本读取失败`);
      onToast(parts.join(" · "), report.failed > 0 ? "danger" : "info");
    } catch (e) {
      onToast(errorText(e), "danger");
    } finally {
      setRebuilding(false);
    }
  }, [onCacheChange, onCoversRebuilt, onToast]);

  return (
    <>
      <section className="drawer-section">
        <div className="section-title">阅读情况</div>

        {stats.total === 0 ? (
          <div className="field-hint">书架还是空的。导入或添加目录后，这里会显示进度分布。</div>
        ) : (
          <>
            <div className="stats-grid">
              <div className="stat-cell">
                <span className="stat-value">{stats.total}</span>
                <span className="stat-label">在架</span>
              </div>
              <div className="stat-cell">
                <span className="stat-value">{stats.reading}</span>
                <span className="stat-label">在读</span>
              </div>
              <div className="stat-cell">
                <span className="stat-value">{stats.finished}</span>
                <span className="stat-label">已读完</span>
              </div>
              <div className="stat-cell">
                <span className="stat-value">{stats.unread}</span>
                <span className="stat-label">未开始</span>
              </div>
            </div>

            {stats.byCategory.length > 0 && (
              <div className="stat-bars">
                {stats.byCategory.map((item) => {
                  const pct = stats.total > 0 ? (item.count / stats.total) * 100 : 0;
                  return (
                    <div className="stat-bar-row" key={item.key}>
                      <span className="stat-bar-label">{item.label}</span>
                      <span className="stat-bar-track" aria-hidden="true">
                        <span className="stat-bar-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="stat-bar-count">{item.count}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="field-hint">
              最近 7 天：读过 {stats.recentBooks} 本 · 活跃 {stats.activeDays} 天。
              「已读完」按 99% 以上判定；EPUB 只记录章内位置，无法折算全书进度，
              因此一律计入「在读」。
            </div>
          </>
        )}
      </section>

      <section className="drawer-section">
        <div className="section-title">目录</div>

        {roots.length === 0 ? (
          <div className="field-hint">还没有添加目录。</div>
        ) : (
          roots.map((root) => (
            <div className="root-row" key={root.id}>
              <span className="root-path">{root.path}</span>
              <button
                className="icon-btn"
                onClick={() => onRemoveRoot(root.id)}
                aria-label={`移除目录 ${root.path}`}
                title="移除目录"
              >
                <Trash2 size={16} strokeWidth={2} />
              </button>
            </div>
          ))
        )}

        <div className="option-group">
          {/* 移动端没有系统文件夹选择器，入口隐藏而不是留个点了报错的按钮 */}
          {!IS_MOBILE && (
            <button className="btn btn-secondary" onClick={onAddRoot}>
              <FolderPlus size={16} strokeWidth={2} />
              添加目录
            </button>
          )}
          <button
            className="btn btn-secondary"
            onClick={onScan}
            disabled={scanning || roots.length === 0}
          >
            <RefreshCw size={16} strokeWidth={2} />
            {scanning ? "扫描中…" : "重新扫描"}
          </button>
        </div>

        <div className="field-hint">
          {IS_MOBILE
            ? "导入的文件会复制到应用私有目录，卸载应用时会一并清除。"
            : "支持 txt、md、html、epub、mobi、azw3、fb2、docx、rtf、mhtml、pdf、cbz、cbr、cbt、cb7、zip，以及同层图片不少于 3 张的文件夹。"}
        </div>
      </section>

      <section className="drawer-section">
        <div className="section-title">缓存</div>

        <div className="field-row">
          <span className="field-label">漫画解压</span>
          <span className="field-value">{cache ? formatSize(cache.comic) : "—"}</span>
        </div>
        <div className="field-row">
          <span className="field-label">EPUB 资源</span>
          <span className="field-value">{cache ? formatSize(cache.epub) : "—"}</span>
        </div>
        <div className="field-row">
          <span className="field-label">封面缩略图</span>
          <span className="field-value">{cache ? formatSize(cache.covers) : "—"}</span>
        </div>

        <div className="option-group">
          <button
            className="btn btn-secondary"
            onClick={() => void clearCache()}
            disabled={clearing}
          >
            <Trash2 size={16} strokeWidth={2} />
            清理解压缓存
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void rebuildCovers()}
            disabled={rebuilding}
          >
            {rebuilding ? "正在重建…" : "重建封面"}
          </button>
        </div>

        <div className="field-hint">
          书籍本身不受影响。「重建封面」会重新从每本书里提取首图；启动时自动裁剪缓存：
          先清掉已移出书库的记录，再把单个目录压到 1.5GB 以内。
        </div>
      </section>
    </>
  );
}
