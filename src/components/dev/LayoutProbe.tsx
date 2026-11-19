import { useCallback, useEffect, useState } from "react";
import { Copy, Ruler, X } from "lucide-react";

/**
 * 布局自检。
 *
 * 存在的理由很具体：这台开发机上 Edge 的无头截图彻底失效
 *（`--screenshot` 与 `--dump-dom` 都静默返回 0、无产物），
 * 手机端的视觉问题只能靠「改完出包 → 用户截图 → 我再猜」来定位，
 * 关于页那次连塌三轮就是这么来的。
 *
 * 这个面板把关键元素的实际盒模型打印成可复制的文本：
 * 高度、内边距、字号、安全区变量值。以后遇到「文字叠在一起」「被刘海压住」，
 * 先要一段数字，而不是先猜一条 CSS。
 */
interface Props {
  onClose: () => void;
}

/** 关心的元素：都是出过问题或者一旦出问题最难查的 */
const TARGETS: { label: string; selector: string }[] = [
  { label: "顶栏", selector: ".topbar" },
  { label: "侧栏", selector: ".sidebar" },
  { label: "内容区", selector: ".shelf-body" },
  { label: "阅读顶栏", selector: ".reader-topbar" },
  { label: "阅读底栏", selector: ".reader-bottombar" },
  { label: "阅读正文", selector: ".reader-text" },
  { label: "抽屉", selector: ".drawer" },
  { label: "抽屉内容", selector: ".drawer-body" },
  { label: "侧面板", selector: ".toc" },
  { label: "关于行", selector: ".about-row" },
];

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function measure(): string {
  const lines: string[] = [];
  const vv = window.visualViewport;
  lines.push(
    `视口 ${window.innerWidth}×${window.innerHeight} · dpr ${window.devicePixelRatio}` +
      (vv ? ` · visual ${fmt(vv.width)}×${fmt(vv.height)} @${fmt(vv.offsetTop)}` : ""),
  );

  const root = getComputedStyle(document.documentElement);
  const vars = ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right", "--safe-top-extra"];
  lines.push(
    "安全区 " + vars.map((v) => `${v}=${root.getPropertyValue(v).trim() || "—"}`).join(" · "),
  );
  lines.push(`UA ${navigator.userAgent}`);
  lines.push("");

  for (const target of TARGETS) {
    const nodes = document.querySelectorAll<HTMLElement>(target.selector);
    if (nodes.length === 0) continue;
    // 同名的多个元素（如关于页每行）只报前三个，再多就是噪音
    nodes.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const tag = index === 0 ? target.label : `${target.label}#${index + 1}`;
      lines.push(
        `${tag.padEnd(10)} ${fmt(rect.width)}×${fmt(rect.height)} @(${fmt(rect.left)},${fmt(rect.top)}) ` +
          `pt=${cs.paddingTop} pb=${cs.paddingBottom} fs=${cs.fontSize} disp=${cs.display}`,
      );
      if (index >= 2) return;
    });
  }
  return lines.join("\n");
}

export default function LayoutProbe({ onClose }: Props) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  const run = useCallback(() => {
    setCopied(false);
    setText(measure());
  }, []);

  useEffect(() => {
    run();
    // 首帧尺寸常常还没稳定（字体、安全区、工具栏让位都是后到的），再取一次
    const timer = window.setTimeout(run, 1200);
    return () => window.clearTimeout(timer);
  }, [run]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [text]);

  return (
    <div className="overlay overlay-dialog" onClick={onClose}>
      <div
        className="dialog layout-probe"
        role="dialog"
        aria-modal="true"
        aria-label="布局自检"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">布局自检</div>
        <pre className="layout-probe-text">{text}</pre>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            <X size={14} strokeWidth={2} />
            关闭
          </button>
          <button className="btn btn-secondary" onClick={run}>
            <Ruler size={14} strokeWidth={2} />
            重新测量
          </button>
          <button className="btn btn-primary" onClick={() => void copy()}>
            <Copy size={14} strokeWidth={2} />
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}
