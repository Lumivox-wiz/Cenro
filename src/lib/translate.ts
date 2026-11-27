/**
 * 译文入口。
 *
 * 有两条路，按可用性排序：
 * 1. **系统内置 `Translator` API**（Chrome 138+ / Edge 148+ 桌面）：零配置、可离线。
 *    实现在 `translate.ts` 的 `systemTranslator` 里——**但在 Tauri 的 WebView2 中实测
 *    所有语言对都报 `unavailable`**（Edge 浏览器里同一个语言对是 `downloadable`），
 *    所以它现在只是「探测 + 如实告知」，还不能真正干活。
 * 2. **OpenAI 兼容端点**（默认指向本机推理服务）：走后端 reqwest。
 *    前端直连会被 CSP 的 connect-src 拦掉，改 CSP 等于开一个任意出网的口子。
 */
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PREFS, loadPrefs } from "./prefs";

export type TranslateConfig = {
  endpoint: string;
  model: string;
  target: string;
  apiKey: string;
};

/**
 * 配置就住在 `Prefs` 里（和字号、主题同一套存储与「恢复默认」），
 * 不再单独开一个 localStorage 键——两处存同一件事，迟早对不上。
 */
export const DEFAULT_CONFIG: TranslateConfig = {
  endpoint: DEFAULT_PREFS.translateEndpoint,
  model: DEFAULT_PREFS.translateModel,
  target: DEFAULT_PREFS.translateTarget,
  apiKey: DEFAULT_PREFS.translateApiKey,
};

export function loadConfig(): TranslateConfig {
  const p = loadPrefs();
  return {
    endpoint: p.translateEndpoint || DEFAULT_CONFIG.endpoint,
    model: p.translateModel || DEFAULT_CONFIG.model,
    target: p.translateTarget || DEFAULT_CONFIG.target,
    apiKey: p.translateApiKey ?? "",
  };
}

export type TranslateOutcome = { texts: string[]; batches: number };

/** 一批译文。返回与输入等长，空字符串表示模型没给这一行（前端退回原文）。 */
export async function translateBatch(
  texts: string[],
  cfg: TranslateConfig = loadConfig(),
): Promise<TranslateOutcome> {
  return invoke<TranslateOutcome>("translate_texts", {
    texts,
    config: {
      endpoint: cfg.endpoint,
      model: cfg.model,
      target: cfg.target,
      api_key: cfg.apiKey,
    },
  });
}

export type SystemTranslatorState =
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready" };

/**
 * 探一下系统 Translator。
 *
 * 只做探测、不发起下载：`Translator.create()` 要求用户手势，
 * 在打开页面时静默初始化会直接抛 `NotAllowedError`。
 */
export async function probeSystemTranslator(
  source: string,
  target: string,
): Promise<SystemTranslatorState> {
  const api = (self as unknown as {
    Translator?: {
      availability?: (o: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
    };
  }).Translator;
  if (!api?.availability) return { kind: "absent" };
  try {
    const state = await api.availability({ sourceLanguage: source, targetLanguage: target });
    if (state === "available" || state === "downloadable" || state === "downloading") {
      return { kind: "ready" };
    }
    return { kind: "unavailable", reason: state };
  } catch (e) {
    return { kind: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }
}
