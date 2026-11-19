import { useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { DEFAULT_PREFS, type FontChoice, type Prefs } from "../../lib/prefs";
import { fontNameFromPath } from "../../lib/fonts";
import { IS_MOBILE } from "../../lib/platform";
import { OptionRow, SectionHead, SliderRow } from "./Controls";
import type { SectionProps } from "./shared";

function Group({
  title,
  children,
  canReset,
  onReset,
}: {
  title: string;
  children: ReactNode;
  canReset: boolean;
  onReset: () => void;
}) {
  return (
    <section className="drawer-section">
      <SectionHead title={title} canReset={canReset} onReset={onReset} />
      {children}
    </section>
  );
}

const FONT_EXTENSIONS = ["ttf", "otf", "ttc", "woff", "woff2"];

/**
 * 自定义字体一行：显示当前用的字体名，右边「选择 / 更换 / 清除」。
 *
 * 不做字体预览列表——那需要把每个文件都读进内存试排一遍，几十 MB 的中文字体
 * 光加载就要几秒。让用户选文件、立刻在正文里看效果，比一个转圈的列表更直接。
 */
function FontPickerRow({
  label,
  font,
  hint,
  onChange,
}: {
  label: string;
  font: FontChoice | null;
  hint: string;
  onChange: (font: FontChoice | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        title: "选择字体文件",
        filters: [{ name: "字体文件", extensions: FONT_EXTENSIONS }],
      });
      if (typeof picked !== "string") return;
      setError(null);
      onChange({ path: picked, name: fontNameFromPath(picked) });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="setting-block">
      <div className="setting-head">
        <span className="field-label">{label}</span>
        {/*
          字体名放在右侧值位：与「字号 18px」同一条视觉基线，
          不像单独一行那样把这一组撑高。名字长了就省略，不换行。
        */}
        <span className="field-tail" style={{ gap: "var(--sp-2)", minWidth: 0 }}>
          <span className="field-value font-choice-name" title={font?.path ?? ""}>
            {font ? font.name : "跟随字体族"}
          </span>
          {font && (
            <button className="btn btn-ghost" onClick={() => onChange(null)}>
              清除
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => void pick()}>
            {font ? "更换…" : "选择…"}
          </button>
        </span>
      </div>
      <div className="field-hint">{error ? `打不开文件选择器：${error}` : hint}</div>
    </div>
  );
}

/**
 * 阅读子页：按「影响哪类内容」分成三组。
 *
 * 之前是「排版 / 漫画与 PDF」两段，单双页、PDF 模式、双页封面、方向提示全挤在
 * 一段里，用户读不出哪一项对漫画生效、哪一项对 PDF 生效。分组即答案。
 */
export default function ReadingSettings({ prefs, onPrefs }: SectionProps) {
  const set = (patch: Partial<Prefs>) => onPrefs(patch);

  const textChanged =
    prefs.readerFontSize !== DEFAULT_PREFS.readerFontSize ||
    prefs.readerLineHeight !== DEFAULT_PREFS.readerLineHeight ||
    prefs.readerPageWidth !== DEFAULT_PREFS.readerPageWidth ||
    prefs.readerFont !== DEFAULT_PREFS.readerFont ||
    prefs.readerParaGap !== DEFAULT_PREFS.readerParaGap ||
    prefs.readerMargin !== DEFAULT_PREFS.readerMargin ||
    prefs.readerFontCjk !== DEFAULT_PREFS.readerFontCjk ||
    prefs.readerFontLatin !== DEFAULT_PREFS.readerFontLatin;

  const comicChanged =
    prefs.spreadMode !== DEFAULT_PREFS.spreadMode ||
    prefs.spreadCover !== DEFAULT_PREFS.spreadCover ||
    prefs.comicDirHint !== DEFAULT_PREFS.comicDirHint;

  const pdfChanged = prefs.pdfMode !== DEFAULT_PREFS.pdfMode;

  return (
    <>
      <Group
        title="正文排版"
        canReset={textChanged}
        onReset={() =>
          set({
            readerFontSize: DEFAULT_PREFS.readerFontSize,
            readerLineHeight: DEFAULT_PREFS.readerLineHeight,
            readerPageWidth: DEFAULT_PREFS.readerPageWidth,
            readerFont: DEFAULT_PREFS.readerFont,
            readerParaGap: DEFAULT_PREFS.readerParaGap,
            readerMargin: DEFAULT_PREFS.readerMargin,
            readerFontCjk: DEFAULT_PREFS.readerFontCjk,
            readerFontLatin: DEFAULT_PREFS.readerFontLatin,
          })
        }
      >
        <OptionRow
          label="字体"
          value={prefs.readerFont}
          options={[
            { value: "serif", label: "衬线" },
            { value: "sans", label: "黑体" },
            { value: "kai", label: "楷体" },
            { value: "mono", label: "等宽" },
          ]}
          onChange={(value) => set({ readerFont: value })}
          hint={
            IS_MOBILE
              ? "衬线（宋体一类）适合长文，黑体更清爽，楷体偏纸书感，等宽用于代码与表格较多的文档。只用系统自带字体，不联网下载。"
              : "衬线（宋体一类）适合长文，黑体更清爽，楷体偏纸书感，等宽用于代码与表格较多的文档。都不合适时，可以在下面选自己的字体文件——离线读取，不联网。"
          }
        />

        {/* 自定义字体要有文件选择器，桌面端才给；手机端系统不允许随便读字体文件 */}
        {!IS_MOBILE && (
          <>
            <FontPickerRow
              label="中文正文"
              font={prefs.readerFontCjk}
              onChange={(font) => set({ readerFontCjk: font })}
              hint="选一个汉字字体文件（.ttf / .otf / .ttc），正文里的汉字就用它。乱码或没变化说明文件不是字体，或路径已经失效。"
            />
            <FontPickerRow
              label="西文与数字"
              font={prefs.readerFontLatin}
              onChange={(font) => set({ readerFontLatin: font })}
              hint="只影响拉丁字母、数字与标点；汉字仍用上面那套。留空则西文跟随中文字体。"
            />
          </>
        )}

        <SliderRow
          label="正文字号"
          min={14}
          max={28}
          step={1}
          unit="px"
          value={prefs.readerFontSize}
          defaultValue={DEFAULT_PREFS.readerFontSize}
          onChange={(value) => set({ readerFontSize: value })}
        />

        <SliderRow
          label="行高"
          min={1.4}
          max={2}
          step={0.05}
          unit=" 倍"
          digits={2}
          value={prefs.readerLineHeight}
          defaultValue={DEFAULT_PREFS.readerLineHeight}
          onChange={(value) => set({ readerLineHeight: value })}
        />

        <SliderRow
          label="段间距"
          min={0}
          max={1.6}
          step={0.1}
          unit=" 倍"
          digits={1}
          value={prefs.readerParaGap}
          defaultValue={DEFAULT_PREFS.readerParaGap}
          onChange={(value) => set({ readerParaGap: value })}
          hint="作用于按段落排版的格式（EPUB / HTML / Markdown / Word / Excel）。TXT 的段间空行来自原文，不由此项控制。"
        />

        {/* 手机版心恒等于屏宽，这一项改了看不出差别——桌面端才显示 */}
        {!IS_MOBILE && (
          <SliderRow
            label="版心宽度"
            min={480}
            max={900}
            step={20}
            unit="px"
            value={prefs.readerPageWidth}
            defaultValue={DEFAULT_PREFS.readerPageWidth}
            onChange={(value) => set({ readerPageWidth: value })}
          />
        )}

        <SliderRow
          label="页边距"
          min={0}
          max={48}
          step={4}
          unit="px"
          value={prefs.readerMargin}
          defaultValue={DEFAULT_PREFS.readerMargin}
          onChange={(value) => set({ readerMargin: value })}
          hint="左右各留这么多空白。它是在版心宽度里扣的，所以总宽不会超出屏幕；手机上默认 0 已经贴边，想更松快可以加到 8–16。"
        />

        <div className="field-hint">
          {IS_MOBILE
            ? "手机按屏宽排版，版心宽度沿用桌面设置。字体、字号、行高、段间距与页边距作用于小说、EPUB 与 HTML 正文。"
            : "字体、字号、行高、段间距、版心宽度与页边距作用于小说、EPUB 与 HTML 的正文，漫画与 PDF 不受影响。"}
        </div>
      </Group>

      <Group
        title="漫画"
        canReset={comicChanged}
        onReset={() =>
          set({
            spreadMode: DEFAULT_PREFS.spreadMode,
            spreadCover: DEFAULT_PREFS.spreadCover,
            comicDirHint: DEFAULT_PREFS.comicDirHint,
          })
        }
      >
        {/* 手机宽度到不了双页阈值（1440px），这两项在手机上不生效 */}
        {!IS_MOBILE && (
          <OptionRow
            label="阅读布局"
            value={prefs.spreadMode}
            options={[
              { value: "auto", label: "自动" },
              { value: "single", label: "单页" },
              { value: "double", label: "双页" },
            ]}
            onChange={(value) => set({ spreadMode: value })}
            hint="「自动」在窗口 ≥1440px 时用双页，手动选过之后锁定，可用 D 键切换。"
          />
        )}

        {!IS_MOBILE && (
          <OptionRow
            label="双页封面"
            value={prefs.spreadCover}
            options={[
              { value: "center", label: "居中" },
              { value: "edge", label: "靠边" },
            ]}
            onChange={(value) => set({ spreadCover: value })}
            hint="仅影响双页模式下的单张封面。居中更稳，靠边更接近纸书：日漫靠右、西漫靠左。"
          />
        )}

        <OptionRow
          label="阅读方向提示"
          value={prefs.comicDirHint ? "on" : "off"}
          options={[
            { value: "on", label: "开启" },
            { value: "off", label: "关闭" },
          ]}
          onChange={(value) => set({ comicDirHint: value === "on" })}
          hint="首次进入漫画时提示阅读方向（如「日漫模式：← 下一页」），只提示一次。"
        />
      </Group>

      <Group
        title="PDF"
        canReset={pdfChanged}
        onReset={() => set({ pdfMode: DEFAULT_PREFS.pdfMode })}
      >
        <OptionRow
          label="阅读模式"
          value={prefs.pdfMode}
          options={[
            { value: "auto", label: "自动" },
            { value: "paged", label: "翻页" },
            { value: "scroll", label: "连续滚动" },
          ]}
          onChange={(value) => set({ pdfMode: value })}
          hint="「自动」时放大到 110% 以上切连续滚动、缩到 95% 以下切回翻页。手动选择即锁定。"
        />
      </Group>
    </>
  );
}
