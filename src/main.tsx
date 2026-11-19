// 必须排在最前：老内核的全局兜底要在任何业务模块求值之前生效
import "./lib/polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppTheme, applyMaterial, applyReaderVars, loadPrefs } from "./lib/prefs";
import { applyMonet } from "./lib/monet";
import { applySafeAreaFallback } from "./lib/safeArea";
import { installDevMock } from "./lib/devMock";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/reader.css";

// 浏览器里 `npm run dev` 时补一个假后端，方便截图与视觉自查。
// 生产构建中 import.meta.env.DEV 为 false，整段被消除；真 Tauri 里内部已跳过。
if (import.meta.env.DEV) installDevMock();

// 首屏前应用主题，避免闪白
const initial = loadPrefs();
applyAppTheme(initial.theme);
// 材质紧跟主题：液态玻璃的变量覆盖按 [data-theme] 分亮暗，两者必须同在首帧前落定
applyMaterial(initial.material);
// 莫奈配色必须在主题之后：它按 data-theme 决定往哪边调明度
applyMonet(initial.monet, initial.background.path);
applyReaderVars(initial);
// 安全区兜底要赶在首屏之前：晚了会看到顶栏先贴到状态栏、再往下跳一下
applySafeAreaFallback();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
