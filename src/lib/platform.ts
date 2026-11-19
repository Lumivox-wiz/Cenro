/**
 * 运行平台判定。
 *
 * 注意：Tauri 的 `platform()` 是异步的，而组件在首帧就需要分支，
 * 因此用 UA 同步判定。Android WebView 与 iOS WebView 的 UA 都稳定包含关键字。
 */
export const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(
  navigator.userAgent,
);

/** 移动端不支持「选择文件夹」，导入走文件选择 + 复制到应用私有目录。 */
export const IS_DESKTOP = !IS_MOBILE;
