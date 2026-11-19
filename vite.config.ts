import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  /*
   * 构建目标钉死 chrome100。
   *
   * Windows 上 Tauri 用的是系统里的 WebView2，用户那台只有 109（2023-01），
   * Vite 默认按「广泛可用基线」编译，给的语法/内置假设可能已经超出它的能力。
   * 钉到 100 之后至少语法层面是保守的；真缺运行时 API 会由 index.html 的兜底层报出来。
   */
  build: {
    target: ["chrome100", "edge100"],
    /*
     * 不清空 outDir。
     *
     * `public/pdfjs/` 有 200 多个文件（中文 CMap、标准 14 字体、JBIG2/JPEG2000 解码器），
     * 每次构建都让 vite 整目录删一遍既慢、又会在「批量删除」受限制的环境里直接失败
     * （沙箱、某些企业策略、以及 WorkBuddy 的 safe-delete shim 都会拦）。
     * 改成由 `prebuild` 精确清理 `dist/index.html` 与 `dist/assets/`，
     * pdf.js 那堆静态资源原地覆盖即可 —— 它们的文件名不带指纹，不会被缓存骗。
     */
    emptyOutDir: false,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
