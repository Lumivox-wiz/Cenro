import { Check } from "lucide-react";
import { DEFAULT_PREFS } from "../../lib/prefs";
import { READER_THEME_OPTIONS, THEME_OPTIONS, type SectionProps } from "./shared";
import { OptionRow } from "./Controls";
import { IS_MOBILE } from "../../lib/platform";
import type { Prefs, ReaderTheme, ThemePref } from "../../lib/prefs";

/**
 * 每个主题给一块真实的小色板。
 * 纯文字按钮只能靠想象「护眼」是什么颜色——色板比任何形容词都直接。
 */
const APP_SWATCH: Record<ThemePref, { bg: string; card: string; ink: string }> = {
  system: { bg: "linear-gradient(90deg,#f7f7f5 50%,#131416 50%)", card: "#ffffff", ink: "#1f2328" },
  light: { bg: "#f7f7f5", card: "#ffffff", ink: "#1f2328" },
  dark: { bg: "#131416", card: "#23262b", ink: "#e6e7e9" },
};

const READER_SWATCH: Record<ReaderTheme, { paper: string; ink: string }> = {
  follow: { paper: "transparent", ink: "currentColor" },
  light: { paper: "#faf9f6", ink: "#2b2b2b" },
  dark: { paper: "#1a1b1e", ink: "#d4d6da" },
  sepia: { paper: "#f3e6cf", ink: "#5a4a35" },
  oled: { paper: "#000000", ink: "#e8e8e8" },
};

/** 主题页的全部可回退项。材质与主题正交，但它确实在这一页里，所以必须一起回退。 */
export const THEME_RESET: Partial<Prefs> = {
  theme: DEFAULT_PREFS.theme,
  readerTheme: DEFAULT_PREFS.readerTheme,
  material: DEFAULT_PREFS.material,
};

/** 主题子页：应用主题与阅读主题解耦，可混搭（UI §3.2） */
export default function ThemeSettings({ prefs, onPrefs }: SectionProps) {
  return (
    <>
      <section className="drawer-section">
        <div className="section-title">应用</div>
        <div className="setting-block">
          <span className="field-label">应用主题</span>
          <div className="theme-grid">
            {THEME_OPTIONS.map((opt) => {
              const swatch = APP_SWATCH[opt.value];
              const active = prefs.theme === opt.value;
              return (
                <button
                  key={opt.value}
                  className="theme-card"
                  aria-pressed={active}
                  onClick={() => onPrefs({ theme: opt.value })}
                >
                  <span
                    className="theme-card-preview"
                    style={{ background: swatch.bg }}
                    aria-hidden="true"
                  >
                    <span className="theme-card-line" style={{ background: swatch.ink }} />
                    <span
                      className="theme-card-line short"
                      style={{ background: swatch.ink }}
                    />
                  </span>
                  <span className="theme-card-label">
                    {opt.label}
                    {active && <Check size={13} strokeWidth={2.5} />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="field-hint">书架与设置界面的明暗。跟随系统时随系统切换即时变化。</div>
        </div>
        {/*
         * 材质（v1.13）：与上面的主题是**两个维度**，不是第三个主题。
         * 「液态玻璃」既可以是亮玻璃也可以是暗玻璃，做进主题下拉就再也组合不出来。
         */}
        <OptionRow
          label="材质"
          value={prefs.material}
          options={[
            { value: "flat", label: "标准" },
            { value: "liquid", label: "液态玻璃" },
          ]}
          onChange={(value) => onPrefs({ material: value })}
        />
      </section>

      <section className="drawer-section">
        <div className="section-title">阅读</div>
        <div className="setting-block">
          <span className="field-label">阅读主题</span>
          <div className="theme-grid">
            {READER_THEME_OPTIONS.map((opt) => {
              const swatch = READER_SWATCH[opt.value];
              const active = prefs.readerTheme === opt.value;
              const paper = swatch.paper === "transparent" ? "var(--c-bg-surface)" : swatch.paper;
              return (
                <button
                  key={opt.value}
                  className="theme-card"
                  aria-pressed={active}
                  onClick={() => onPrefs({ readerTheme: opt.value })}
                >
                  <span
                    className="theme-card-preview"
                    style={{ background: paper }}
                    aria-hidden="true"
                  >
                    <span
                      className="theme-card-paper"
                      style={{ color: swatch.ink, background: paper }}
                    >
                      Aa 书
                    </span>
                  </span>
                  <span className="theme-card-label">
                    {opt.label}
                    {active && <Check size={13} strokeWidth={2.5} />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="field-hint">只影响阅读页的纸面配色，与应用主题解耦，可混搭。</div>
        </div>
      </section>

      {/* 只有手机才有刘海/挖孔；桌面端这一项没有意义 */}
      {IS_MOBILE && (
        <section className="drawer-section">
          <div className="section-title">手机布局</div>
          <div className="setting-block">
            <OptionRow
              label="顶部安全区"
              value={String(prefs.safeTopExtra ?? 0)}
              options={[
                { value: "0", label: "自动" },
                { value: "8", label: "+8" },
                { value: "16", label: "+16" },
                { value: "24", label: "+24" },
                { value: "32", label: "+32" },
              ]}
              onChange={(value) => onPrefs({ safeTopExtra: Number(value) })}
              hint="顶栏被刘海或挖孔压住时，在这里往上补几像素。选「自动」只依赖系统上报的安全区，某些机型报得偏小。"
            />
          </div>
        </section>
      )}
    </>
  );
}
