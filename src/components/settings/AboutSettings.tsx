import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Ruler, Scale, ScrollText } from "lucide-react";
import logoUrl from "../../assets/logo-mark.svg";
import { licenseApi, type LicenseText } from "../../api";
import Dialog from "../ui/Dialog";
import LayoutProbe from "../dev/LayoutProbe";
import type { GroupId } from "./shared";

interface Props {
  version: string;
  /** 跳到其它设置子页（书库 / 阅读） */
  onNavigate: (id: GroupId) => void;
}

/**
 * 关于子页，参考常见的「居中 hero + 圆角卡片分组」范式重构：
 * 顶部图标、名称、版本，下方卡片放可跳转入口与格式清单。
 * 「检查更新」没有做入口——应用不联网，一行提示比一个点了报错的按钮诚实。
 */
export default function AboutSettings({ version, onNavigate }: Props) {
  const [probeOpen, setProbeOpen] = useState(false);
  const [logText, setLogText] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [licenses, setLicenses] = useState<LicenseText[] | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  /*
   * 日志放在「关于」里：它是排错用的，不是日常功能。
   * 读的是文件尾部 500 行 —— 一次贴几千行进对话框没有意义，反而卡。
   */
  const openLog = useCallback(async () => {
    setCopied(false);
    try {
      const [text, path] = await Promise.all([
        invoke<string>("read_log", { maxLines: 500 }),
        invoke<string | null>("log_path"),
      ]);
      setLogError(null);
      setLogText(text || `（日志还是空的）\n\n文件位置：${path ?? "未知"}`);
    } catch (e) {
      setLogText(null);
      setLogError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const copyLog = useCallback(async () => {
    if (!logText) return;
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
    } catch {
      // WebView 下剪贴板可能被策略挡住：不假装成功，提示直接看文件
      setCopied(false);
      setLogError("复制失败，可以直接打开日志文件查看");
    }
  }, [logText]);

  /*
   * 许可全文编在二进制里（见 src-tauri/src/license.rs），所以这里只是取一次文本。
   * 为什么不直接展示在页面上：GPL 正文三十多 KB，摊开会把「关于」页撑成一份合同。
   */
  const openLicenses = useCallback(async () => {
    try {
      setLicenses(await licenseApi.all());
      setLicenseError(null);
    } catch (e) {
      setLicenses(null);
      setLicenseError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <>
      <div className="about-hero">
        {/* 纯图形标志（无字）：矢量源直接引用，任意缩放都清晰；换设计只替换文件 */}
        <img className="about-logo" src={logoUrl} alt="" aria-hidden="true" />
        <div className="about-name">岑序</div>
        <div className="about-version">{version ? `v${version}` : "—"}</div>
      </div>

      <section className="about-card">
        <button className="about-row about-row-link" onClick={() => onNavigate("library")}>
          <span className="about-row-label">书库与缓存</span>
          <ChevronRight size={16} strokeWidth={2} className="about-row-chevron" aria-hidden="true" />
        </button>
        <button className="about-row about-row-link" onClick={() => onNavigate("reading")}>
          <span className="about-row-label">阅读设置</span>
          <ChevronRight size={16} strokeWidth={2} className="about-row-chevron" aria-hidden="true" />
        </button>
      </section>

        <section className="about-card">
        <button className="about-row about-row-link" onClick={() => void openLog()}>
          <span className="about-row-label">运行日志</span>
          <ScrollText size={16} strokeWidth={2} className="about-row-chevron" aria-hidden="true" />
        </button>
        {/* 排错用：把关键元素的实际尺寸打出来，手机端尤其需要（拿不到截图时看数字） */}
        <button className="about-row about-row-link" onClick={() => setProbeOpen(true)}>
          <span className="about-row-label">布局自检</span>
          <Ruler size={16} strokeWidth={2} className="about-row-chevron" aria-hidden="true" />
        </button>
        {/* 许可全文随包：GPL 正文 + unrar-rs 的附加条款，不需要联网也不需要翻安装目录 */}
        <button className="about-row about-row-link" onClick={() => void openLicenses()}>
          <span className="about-row-label">开源许可</span>
          <Scale size={16} strokeWidth={2} className="about-row-chevron" aria-hidden="true" />
        </button>
      </section>

      {probeOpen && <LayoutProbe onClose={() => setProbeOpen(false)} />}

      {logText !== null && (
        <Dialog
          title="运行日志"
          confirmLabel={copied ? "已复制" : "复制全部"}
          cancelLabel="关闭"
          onConfirm={() => void copyLog()}
          onCancel={() => setLogText(null)}
        >
          <pre className="log-view">{logText}</pre>
        </Dialog>
      )}

      {logError && logText === null && (
        <Dialog title="读取日志失败" confirmLabel="知道了" hideCancel onConfirm={() => setLogError(null)} onCancel={() => setLogError(null)}>
          <div className="dialog-text">{logError}</div>
        </Dialog>
      )}

      {licenses && (
        <Dialog
          title="开源许可"
          confirmLabel="关闭"
          hideCancel
          wide
          onConfirm={() => setLicenses(null)}
          onCancel={() => setLicenses(null)}
        >
          {/* 单一滚动区包住两段：两个各自 46vh 的滚动块会顶出对话框 */}
          <div className="license-scroll">
            {licenses.map((item) => (
              <div className="license-block" key={item.name}>
                <div className="license-name">{item.name}</div>
                <pre className="license-body">{item.body}</pre>
              </div>
            ))}
          </div>
        </Dialog>
      )}

      {licenseError && (
        <Dialog title="读取许可失败" confirmLabel="知道了" hideCancel onConfirm={() => setLicenseError(null)} onCancel={() => setLicenseError(null)}>
          <div className="dialog-text">{licenseError}</div>
        </Dialog>
      )}

      <section className="about-card">
          <div className="about-row">
            <span className="about-row-label">小说</span>
            <span className="about-row-value">TXT · MD · HTML · EPUB · MOBI · AZW3 · FB2</span>
          </div>
          <div className="about-row">
            <span className="about-row-label">漫画</span>
            <span className="about-row-value">CBZ · CBR · CBT · CB7 · ZIP · 图片文件夹 · 图片型 MOBI</span>
          </div>
          <div className="about-row">
            <span className="about-row-label">文档</span>
            <span className="about-row-value">PDF · OFD · DOCX · RTF · MHTML · XLSX</span>
          </div>
        </section>
    </>
  );
}
