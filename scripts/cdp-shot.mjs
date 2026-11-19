/**
 * 开发期视觉自查：用 CDP 驱动 Edge 打开 dev server，
 * 跑一段页面脚本、截图。只为核对划词高亮这类需要交互的效果。
 *
 * 用法：node scripts/cdp-shot.mjs <url> <outfile> [jsFile]
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const [, , url, out, jsFile] = process.argv;
const profile = mkdtempSync(join(tmpdir(), "cenro-cdp-"));
const port = 9333;

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${process.env.SHOT_W ?? 1440},${process.env.SHOT_H ?? 900}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("Edge 没起来");
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  const id = (seq += 1);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.result?.exceptionDetails) {
    console.error("页面异常：", JSON.stringify(res.result.exceptionDetails.exception?.description));
  }
  return res.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.bringToFront");
// 无头窗口默认不是「活动窗口」，键盘/输入事件会被丢掉
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
const width = Number(process.env.SHOT_W ?? 1440);
const height = Number(process.env.SHOT_H ?? 900);
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: width < 600,
});
await send("Page.navigate", { url });
await sleep(2500);

if (jsFile) {
  const script = readFileSync(jsFile, "utf8");
  const value = await evaluate(`(async () => { ${script} })()`);
  if (value !== undefined) console.log("脚本返回：", JSON.stringify(value));
  await sleep(600);
}

/*
 * 真实输入：React 的受控输入框只认真实输入事件，
 * 用 JS 改 value 再派发 input 有时不生效（合成事件被 value tracker 吃掉）。
 * 需要打字时设 SHOT_TYPE_TEXT，需要回车时再加 SHOT_TYPE_ENTER=1。
 */
if (process.env.SHOT_TYPE_TEXT) {
  // 逐字发 char 事件：这条路径走的是浏览器的文本输入管线，
  // 受控输入框才会像真人打字那样更新 React state
  await send("Input.insertText", { text: process.env.SHOT_TYPE_TEXT });
  await sleep(300);
  const probe = await send("Runtime.evaluate", {
    expression:
      "(() => { const el = document.activeElement; return el ? el.tagName + '|' + (el.value ?? '') : 'none'; })()",
    returnByValue: true,
  });
  console.log("输入探测：", probe.result?.result?.value);
  if (process.env.SHOT_PROBE) {
    const t = await send("Runtime.evaluate", {
      expression: "document.querySelector('.toc-list')?.innerText?.slice(0,200) ?? ''",
      returnByValue: true,
    });
    console.log("面板（输入后）：", JSON.stringify(t.result?.result?.value));
  }
  // 强制出一帧：无头窗口有时拿不到输入后的新帧，截图会是打字前的样子
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
  await sleep(600);
}
if (process.env.SHOT_TYPE_ENTER) {
  for (const type of ["rawKeyDown", "char", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: type === "char" ? "\r" : undefined,
    });
  }
  await sleep(2000);
  if (process.env.SHOT_PROBE) {
    const t = await send("Runtime.evaluate", {
      expression: "document.querySelector('.toc-list')?.innerText?.slice(0,300) ?? ''",
      returnByValue: true,
    });
    console.log("面板（回车后）：", JSON.stringify(t.result?.result?.value));
  }
}

// 无头窗口有时不会马上出一帧，截图会落后于 DOM 变化：先制造一次输入事件再等一帧
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 3, y: 3 });
await sleep(700);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("已保存", out);

ws.close();
edge.kill();
