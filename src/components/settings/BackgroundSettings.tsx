import { useState } from "react";
import { Image as ImageIcon, Loader2, Sparkles, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorText, monetApi } from "../../api";
import { MONET_MIN_COVERAGE, previewPalette } from "../../lib/monet";
import { DEFAULT_PREFS, type BgFit, type Prefs } from "../../lib/prefs";
import { OptionRow, SliderRow } from "./Controls";
import type { SectionProps } from "./shared";

interface Props extends SectionProps {
  onToast: (text: string, tone?: "info" | "danger") => void;
}

const FIT_OPTIONS: { value: BgFit; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "cover", label: "裁切填满" },
  { value: "contain", label: "等比适应" },
  { value: "fill", label: "拉伸" },
];

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"];

/**
 * 背景子页（v1.9）：书架背景图 + 莫奈取色。
 *
 * 两件事放在同一页是因为它们耦合：换图之后配色就该跟着换，
 * 分成两页会让用户换完图却忘了回来重新取色。
 */
export default function BackgroundSettings({ prefs, onPrefs, onToast }: Props) {
  const bg = prefs.background;
  const monet = prefs.monet;

  const [sampling, setSampling] = useState(false);

  const setBg = (patch: Partial<Prefs["background"]>) =>
    onPrefs({ background: { ...bg, ...patch } });

  const fileName = bg.path ? (bg.path.split(/[\\/]/).pop() ?? bg.path) : "";

  /** 取色并写回偏好。失败不抛给上层：配色只是装饰，不该挡住背景图本身 */
  const sample = async (path: string) => {
    setSampling(true);
    try {
      const swatch = await monetApi.extract(path);
      if (swatch.coverage < MONET_MIN_COVERAGE) {
        // 灰阶图没有色相可用：直接关掉开关，而不是给一套谁也不像的灰
        onPrefs({
          monet: {
            enabled: false,
            source: path,
            hue: 0,
            saturation: 0,
            lightness: 0,
            coverage: swatch.coverage,
          },
        });
        onToast("这张图几乎没有色调，取色已关闭");
        return;
      }
      onPrefs({
        monet: {
          enabled: true,
          source: path,
          hue: swatch.hue,
          saturation: swatch.saturation,
          lightness: swatch.lightness,
          coverage: swatch.coverage,
        },
      });
    } catch (e) {
      onToast(errorText(e), "danger");
    } finally {
      setSampling(false);
    }
  };

  const choose = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }],
      });
      if (typeof picked !== "string") return;
      setBg({ path: picked });
      /*
       * 已经开着取色时必须立刻重算：
       * 色板缓存是按 source 判断过期的，但用户不会等——他看到的是「换了图，配色还是一年前的蓝」。
       */
      if (monet.enabled) await sample(picked);
    } catch (e) {
      onToast(errorText(e), "danger");
    }
  };

  const clear = () => {
    onPrefs({
      background: { ...DEFAULT_PREFS.background },
      // 图没了，配色也该跟着走——保留一套没有来源的色板就是脏数据
      monet: { ...DEFAULT_PREFS.monet },
    });
  };

  const toggleMonet = async (next: boolean) => {
    if (!next) {
      onPrefs({ monet: { ...monet, enabled: false } });
      return;
    }
    if (!bg.path) {
      onToast("先选一张背景图，取色要有个来源");
      return;
    }
    if (monet.source === bg.path && monet.coverage >= MONET_MIN_COVERAGE) {
      onPrefs({ monet: { ...monet, enabled: true } });
      return;
    }
    await sample(bg.path);
  };

  const stale = !!bg.path && !!monet.source && monet.source !== bg.path;
  const palette = monet.coverage >= MONET_MIN_COVERAGE ? previewPalette(monet) : null;

  return (
    <>
      <section className="drawer-section">
        <div className="section-title">背景图</div>

        <div className="setting-block">
          <div className="setting-head">
            <span className="field-label">图片</span>
          </div>
          {bg.path ? (
            <div className="bg-path" title={bg.path}>
              <ImageIcon size={14} strokeWidth={2} aria-hidden="true" />
              <span className="bg-path-name">{fileName}</span>
            </div>
          ) : (
            <div className="field-hint">只影响书架，阅读页的纸面始终是纯色。</div>
          )}

          <div className="option-group">
            <button className="btn btn-secondary" onClick={() => void choose()}>
              <ImageIcon size={15} strokeWidth={2} />
              {bg.path ? "更换图片" : "选择图片…"}
            </button>
            {bg.path && (
              <button className="btn btn-ghost" onClick={clear}>
                <X size={15} strokeWidth={2} />
                清除
              </button>
            )}
          </div>
        </div>

        {/*
         * 没有图片时这一整组没有意义：滑杆拖了不会发生任何事，
         * 比禁用更容易让人以为是坏了。fieldset + disabled 是唯一能
         * 一次性收掉 range / button / checkbox 三种控件的原生办法。
         */}
        <fieldset className="bg-controls" disabled={!bg.path}>
          <OptionRow
            label="填充方式"
            value={bg.fit}
            options={FIT_OPTIONS}
            onChange={(fit) => setBg({ fit })}
            hint="自动与裁切填满同义：背景图默认应当铺满窗口，留白反而不像壁纸。想完整看到整张图时选等比适应。"
          />

          <SliderRow
            label="不透明度"
            min={10}
            max={100}
            step={5}
            unit="%"
            value={bg.opacity}
            defaultValue={DEFAULT_PREFS.background.opacity}
            onChange={(opacity) => setBg({ opacity })}
            hint="太高会压过卡片，太低等于没设。配合下面的遮罩使用，比单靠降不透明度更容易保住文字。"
          />

          <SliderRow
            label="模糊半径"
            min={0}
            max={40}
            step={1}
            unit="px"
            value={bg.blur}
            defaultValue={DEFAULT_PREFS.background.blur}
            onChange={(blur) => setBg({ blur })}
            hint="模糊盖掉图片细节，遮罩压住亮度——两者解决的不是同一件事，可以叠用。"
          />

          <label className="setting-check">
            <input
              type="checkbox"
              checked={bg.scrim}
              onChange={(e) => setBg({ scrim: e.target.checked })}
            />
            叠加纸色遮罩
          </label>

          <div className="field-hint">
            在图片与内容之间压一层当前主题的纸色。关掉后书名与卡片会直接落在图上，
            浅色图片配深色文字很可能读不清。
          </div>
        </fieldset>
      </section>

      <section className="drawer-section">
        <div className="section-title">莫奈取色</div>

        <label className="setting-check">
          <input
            type="checkbox"
            checked={monet.enabled}
            disabled={!bg.path || sampling}
            onChange={(e) => void toggleMonet(e.target.checked)}
          />
          {sampling ? (
            <span className="monet-busy">
              <Loader2 size={13} strokeWidth={2} className="spin" aria-hidden="true" />
              正在从图片取色…
            </span>
          ) : (
            "从背景图提取主色，生成强调色与选中色"
          )}
        </label>

        {!bg.path && <div className="field-hint">先选一张背景图。</div>}

        {stale && (
          <div className="field-hint">
            色板还是上一张图的。点下面的「重新取色」，或重新勾选一次开关。
          </div>
        )}

        {palette && (
          <div className="monet-swatches">
            <div className="monet-swatch-row">
              <span className="monet-swatch-label">浅色主题</span>
              <span className="monet-swatch" style={{ background: palette.light.accent }} />
              <span className="monet-swatch" style={{ background: palette.light.accentText }} />
              <span className="monet-swatch" style={{ background: palette.light.bgSelected }} />
              <code className="monet-hex">{palette.light.accent}</code>
            </div>
            <div className="monet-swatch-row">
              <span className="monet-swatch-label">深色主题</span>
              <span className="monet-swatch" style={{ background: palette.dark.accent }} />
              <span className="monet-swatch" style={{ background: palette.dark.accentText }} />
              <span className="monet-swatch" style={{ background: palette.dark.bgSelected }} />
              <code className="monet-hex">{palette.dark.accent}</code>
            </div>
          </div>
        )}

        {bg.path && (
          <div className="option-group">
            <button
              className="btn btn-ghost"
              onClick={() => void sample(bg.path as string)}
              disabled={sampling}
            >
              <Sparkles size={15} strokeWidth={2} />
              重新取色
            </button>
          </div>
        )}

        <div className="field-hint">
          取色只接管强调色一族与背景光晕；纸面、文字与卡片颜色不动——
          那些是正文可读性的地基，跟着图走会把整套对比度一起带翻。
          同一张图在浅色与深色下会派生出不同的色值，这是对比度实算的结果，不是没生效。
        </div>
      </section>
    </>
  );
}
