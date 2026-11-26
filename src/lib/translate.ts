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

export type TranslateConfig = {
  endpoint: string;
  model: string;
  target: string;
  apiKey: string;
};

const KEY = "cenro.translate";

/** 默认指向 koboldcpp 的默认端口：本机起过推理服务的人不用填任何东西 */
export const DEFAULT_CONFIG: TranslateConfig = {
  endpoint: "http://127.0.0.1:5001/v1/chat/completions",
  model: "local",
  target: "简体中文",
  apiKey: "",
};

export function loadConfig(): TranslateConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<TranslateConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: TranslateConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export type TranslateOutcome = { texts: string[]; batches: number };

/** 一批译文。返回与输入等长，空字符串表示模型没给这一行（前端退回原文）。 */
export async function translateBatch(texts: string[]): Promise<TranslateOutcome> {
  const cfg = loadConfig();
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
