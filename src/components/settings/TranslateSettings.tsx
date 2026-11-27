import { useState } from "react";

import type { Prefs } from "../../lib/prefs";
import { translateBatch, type TranslateConfig } from "../../lib/translate";
import { SectionHead } from "./Controls";
import type { SectionProps } from "./shared";

/**
 * 翻译服务。
 *
 * 只有一张表单，因为这里不该出现「选厂商」这种事：本地推理服务（koboldcpp、
 * Ollama、LM Studio）与云端 OpenAI 兼容接口用的是同一套协议，填地址就能用。
 * 目标是「不填也能跑」——默认值指向本机 5001，起过推理服务的人不用改任何东西。
 */
export const TRANSLATE_RESET: Partial<Prefs> = {
  translateEndpoint: "http://127.0.0.1:5001/v1/chat/completions",
  translateModel: "local",
  translateTarget: "简体中文",
  translateApiKey: "",
};

/** 常见目标语言。写死几个比让人自由输入更省事，也不至于打错字 */
const TARGETS = ["简体中文", "繁體中文", "English", "日本語"];

export default function TranslateSettings({ prefs, onPrefs }: SectionProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const isDefault =
    prefs.translateEndpoint === TRANSLATE_RESET.translateEndpoint &&
    prefs.translateModel === TRANSLATE_RESET.translateModel &&
    prefs.translateTarget === TRANSLATE_RESET.translateTarget &&
    (prefs.translateApiKey ?? "") === "";

  /** 拿一句最普通的英文去试：能通就说明地址、模型、鉴权三样都对 */
  const test = async () => {
    if (testing) return;
    setTesting(true);
    setResult(null);
    const cfg: TranslateConfig = {
      endpoint: prefs.translateEndpoint,
      model: prefs.translateModel,
      target: prefs.translateTarget,
      apiKey: prefs.translateApiKey ?? "",
    };
    try {
      const out = await translateBatch(["hello"], cfg);
      const text = out.texts[0]?.trim();
      setResult(
        text
          ? { ok: true, msg: `连接正常：hello → ${text}` }
          : { ok: false, msg: "服务有响应，但没给出译文（检查模型是否在跑）" },
      );
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="drawer-section">
      <SectionHead
        title="翻译服务"
        canReset={!isDefault}
        onReset={() => {
          onPrefs(TRANSLATE_RESET);
          setResult(null);
        }}
      />

      <div className="backup-form translate-form">
        <label className="field-label" htmlFor="tr-endpoint">
          服务地址
        </label>
        <input
          id="tr-endpoint"
          className="input"
          spellCheck={false}
          autoComplete="off"
          placeholder="http://127.0.0.1:5001/v1/chat/completions"
          value={prefs.translateEndpoint}
          onChange={(e) => onPrefs({ translateEndpoint: e.target.value })}
        />
        <div className="field-hint">
          任何兼容 OpenAI 的服务都行：koboldcpp 默认 <code>5001</code>，Ollama 是{" "}
          <code>11434</code>。手机上填电脑的局域网地址即可。
        </div>

        <div className="backup-pair">
          <div>
            <label className="field-label" htmlFor="tr-model">
              模型名
            </label>
            <input
              id="tr-model"
              className="input"
              spellCheck={false}
              autoComplete="off"
              value={prefs.translateModel}
              onChange={(e) => onPrefs({ translateModel: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="tr-target">
              译文语言
            </label>
            <select
              id="tr-target"
              className="input"
              value={prefs.translateTarget}
              onChange={(e) => onPrefs({ translateTarget: e.target.value })}
            >
              {TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="field-label" htmlFor="tr-key">
          API Key
        </label>
        <input
          id="tr-key"
          className="input"
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder="本地服务留空"
          value={prefs.translateApiKey ?? ""}
          onChange={(e) => onPrefs({ translateApiKey: e.target.value })}
        />

        <div className="backup-actions">
          <button className="btn btn-secondary" onClick={() => void test()} disabled={testing}>
            {testing ? "正在测试…" : "测试连接"}
          </button>
        </div>

        {result && (
          <div className="field-hint" data-tone={result.ok ? "ok" : "danger"}>
            {result.msg}
          </div>
        )}
      </div>
    </section>
  );
}
