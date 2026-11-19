import { invoke } from "@tauri-apps/api/core";

/**
 * 把前端错误转进后端那份日志。
 *
 * 前端看得到的东西（IPC 失败、渲染异常、被 catch 住但没外抛的错误）
 * 后端一无所知，两边写同一个文件，排查时按时间排一遍就够了。
 *
 * 这里刻意不抛错也不 await：日志失败绝不能影响主流程。
 */
export function logError(message: string) {
  void invoke("log_frontend", { level: "error", message }).catch(() => {});
}

export function logWarn(message: string) {
  void invoke("log_frontend", { level: "warn", message }).catch(() => {});
}

export function logInfo(message: string) {
  void invoke("log_frontend", { level: "info", message }).catch(() => {});
}

/**
 * 全局兜底：未捕获的异常与未处理的 Promise 拒绝。
 * 装一次即可，重复调用只会重复注册同一个处理函数，因此调用方自己保证只调一次。
 */
export function installGlobalErrorLogging() {
  window.addEventListener("error", (event) => {
    const where = event.filename ? `${event.filename}:${event.lineno}` : "未知位置";
    logError(`${event.message} @ ${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const text =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : typeof reason === "string"
          ? reason
          : JSON.stringify(reason);
    logError(`未处理的 Promise 拒绝：${text}`);
  });
}
