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

      {/*
       * 这段说明是给「不知道端点是什么」的人写的。
       * 翻译在这款应用里必须外接一个模型服务——不能装作不需要，
       * 也不能只丢一个输入框让人猜。先说清楚要准备什么，再谈填哪里。
       */}
      <div className="field-hint translate-howto">
        <p>
          翻译需要一个「模型服务」，本应用自带的是识别不是翻译。两种来源，选一种：
        </p>
        <ul>
          <li>
            <b>电脑上的本地服务</b>（不联网、文字不出本机）：装 koboldcpp 或 Ollama 并启动。
            koboldcpp 启动后什么都不用改；Ollama 需要把地址改成{" "}
            <code>http://127.0.0.1:11434/v1/chat/completions</code>，模型名填{" "}
            <code>qwen2.5:7b</code> 这类真实名字。
          </li>
          <li>
            <b>云端兼容接口</b>：填服务商给的地址与 API Key。注意选中的文字会离开本机。
          </li>
        </ul>
        <p>
          手机上没有本地服务可连，请填<b>电脑的局域网地址</b>（例如{" "}
          <code>http://192.168.1.5:5001/v1/chat/completions</code>），并让电脑防火墙放行。
        </p>
      </div>

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
