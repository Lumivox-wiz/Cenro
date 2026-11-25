/// <reference types="vite/client" />

/**
 * 构建期注入的应用版本号，来源是 package.json（见 vite.config.ts 的 define）。
 *
 * 只给浏览器预览用的 devMock 读：真 Tauri 里版本由 `getVersion()` 从
 * tauri.conf.json 取，那才是发布面的唯一真相。
 */
declare const __APP_VERSION__: string;
