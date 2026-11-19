import { IS_MOBILE } from "./platform";

/**
 * 安全区兜底。
 *
 * `env(safe-area-inset-*)` 在 Android WebView 上并不可靠，两种失败方式都见过：
 * 1. 某些机型恒为 0；
 * 2. **首帧还没拿到系统 insets**——脚本在 HTML 解析阶段就跑，这时 WebView
 *    往往还没收到窗口的 WindowInsets 分发，量出来是 0，等布局稳定后才有值。
 *
 * 所以这里量三次：启动时、页面 load 后、以及 600ms 后再校正一次。
 * 拿到正数就用真实值；三次都是 0 才落到保守下限（Android 36 / 其余 30）。
 * 下限只是「不至于贴到状态栏里」，精确值靠 env 或用户在设置里手动补差值。
 */
const FALLBACK_TOP_ANDROID = 36;
const FALLBACK_TOP = 30;
const FALLBACK_BOTTOM = 16;

/** 已经因为「量到 0」写过兜底值；拿到真实值后要能覆盖它 */
let usedFallbackTop = false;

function probe(key: "top" | "bottom"): number {
  const el = document.createElement("div");
  // 必须真实渲染一个盒子：`env()` 不能直接读 computed value
  el.style.cssText = [
    "position:fixed",
    "left:0",
    "width:0",
    `height:env(safe-area-inset-${key}, 0px)`,
    "visibility:hidden",
    "pointer-events:none",
    key === "top" ? "top:0" : "bottom:0",
  ].join(";");
  document.body.appendChild(el);
  const size = el.getBoundingClientRect().height;
  el.remove();
  return size;
}

/** 量一次顶部：有真实值就写真实值，没有就（仅首次）写下限 */
function syncTop() {
  const root = document.documentElement.style;
  const measured = probe("top");
  if (measured >= 1) {
    root.setProperty("--safe-top-base", `${measured}px`);
    usedFallbackTop = false;
    return;
  }
  if (usedFallbackTop) return;
  const isAndroid = /Android/i.test(navigator.userAgent);
  root.setProperty(
    "--safe-top-base",
    `${isAndroid ? FALLBACK_TOP_ANDROID : FALLBACK_TOP}px`,
  );
  usedFallbackTop = true;
}

export function applySafeAreaFallback() {
  if (!IS_MOBILE) return;
  try {
    syncTop();

    if (probe("bottom") < 1) {
      document.documentElement.style.setProperty("--safe-bottom", `${FALLBACK_BOTTOM}px`);
    }

    /*
     * 首帧之后系统 insets 才分发下来的情况很常见：
     * 布局稳定后再校正，同时兜住旋转屏幕（横屏刘海在侧边，顶部值会变）。
     */
    const again = () => {
      try {
        syncTop();
      } catch {
        /* 忽略 */
      }
    };
    if (document.readyState === "complete") {
      window.setTimeout(again, 300);
    } else {
      window.addEventListener("load", again, { once: true });
    }
    window.setTimeout(again, 600);
    window.addEventListener("orientationchange", again);
  } catch {
    /* 量不出来就算了，CSS 里的 env() 还在 */
  }
}
