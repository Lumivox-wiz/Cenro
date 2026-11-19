/**
 * Android 实体返回键接管。
 *
 * Tauri 在 Kotlin 侧的 AppPlugin 里注册了 OnBackPressedCallback：
 * - 没有任何 JS 监听时，它退化为 WebView 历史后退 / 结束 Activity，
 *   所以我们看到的是「直接回桌面」；
 * - 一旦 JS 注册了 `back-button` 监听，它就只发事件、不再自行退出，
 *   此时**必须**自己在栈底调用退出，否则返回键会彻底失效。
 *
 * 这里把返回键映射成统一的层级栈：抽屉 → 阅读页 → 搜索 → 退出应用。
 */

import { useEffect, useRef } from "react";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { IS_MOBILE } from "./platform";

/**
 * @param onBack 返回 true 表示这一层已经消费掉返回键；
 *               返回 false 表示已到栈底，交由系统退出。
 */
export function useAndroidBack(onBack: () => boolean) {
  const handler = useRef(onBack);
  handler.current = onBack;

  useEffect(() => {
    if (!IS_MOBILE) return;

    let disposed = false;
    let unregister: (() => void) | undefined;

    addPluginListener("app", "back-button", () => {
      if (handler.current()) return;
      // 栈底：主动结束应用，否则监听占用后返回键会什么都不做
      void invoke("quit_app").catch(() => {
        /* 命令不可用时保持静默，不弹技术错误 */
      });
    })
      .then((listener) => {
        if (disposed) void listener.unregister();
        else unregister = () => void listener.unregister();
      })
      .catch(() => {
        // 桌面端没有该插件，忽略即可
      });

    return () => {
      disposed = true;
      unregister?.();
    };
  }, []);
}
