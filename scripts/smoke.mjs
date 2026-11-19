/**
 * 冒烟自检：用 dev server 的假后端把每个阅读器与主要交互跑一遍，缺一样就报红。
 *
 * 用法（先 `npm run dev`，另开一个终端）：
 *   node scripts/smoke.mjs               # 默认 http://localhost:1420/
 *   node scripts/smoke.mjs http://localhost:1420/
 *
 * 为什么要有它：devMock 补齐了 PDF / OFD / DOCX / XLSX / 漫画的假实现之后，
 * 这些阅读器才第一次能在浏览器里跑起来。此前它们只有真机验证，
 * 改一行公共代码就得手动点一遍；现在一条命令覆盖。
 *
 * 退出码：全部通过 0，有任何一项失败 1。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_BASE = process.argv[2] ?? "http://localhost:1420/";
const PORT = 9334;
const profile = mkdtempSync(join(tmpdir(), "cenro-smoke-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* Edge 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("Edge 没起来");
}

const page = await findPage();
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
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description ?? "页面脚本抛错");
  }
  return res.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.bringToFront");
await send("Page.navigate", { url: URL_BASE });
await sleep(2500);

/* 页面里跑的一段：全部断言都在这里，宿主只负责收发 */
const SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail ?? "" });

  const shelf = () => document.querySelectorAll(".book-card").length;
  const back = async () => {
    document.querySelector('.reader-topbar button[aria-label="返回书架"]')?.click();
    await sleep(700);
  };
  const open = async (title) => {
    const card = [...document.querySelectorAll(".book-card")].find((el) => (el.textContent || "").includes(title));
    if (!card) return null;
    card.querySelector(".card-target").click();
    await sleep(1500);
    const shell = document.querySelector(".reader-shell");
    return {
      shell,
      chars: document.querySelector(".reader-text")?.textContent?.length ?? 0,
      canvas: shell?.querySelectorAll("canvas").length ?? 0,
      svg: shell?.querySelectorAll("svg").length ?? 0,
      img: [...(shell?.querySelectorAll("img") ?? [])].filter((i) => i.naturalWidth > 0).length,
      indicator: document.querySelector(".reader-page-indicator")?.textContent ?? "",
      error: document.querySelector(".reader-error")?.textContent ?? "",
    };
  };

  // ---- 书架 ----
  check("书架渲染", shelf() > 0, shelf() + " 本");
  check(
    "分类计数",
    document.querySelectorAll(".side-panel[aria-label='按格式筛选'] .sidebar-item").length >= 5,
    "",
  );

  // ---- 六种阅读器 ----
  const cases = [
    ["TXT", "雪国列车", (r) => r.chars > 1000, "正文"],
    ["MD", "无名手记", (r) => r.chars > 20, "正文"],
    ["DOCX", "夜航船", (r) => r.chars > 20, "正文"],
    ["XLSX", "季度数据汇总", (r) => r.chars > 10, "正文"],
    ["EPUB", "长夜将尽", (r) => r.chars > 20, "正文"],
    ["PDF", "建筑十书", (r) => r.canvas > 0, "canvas 页"],
    ["OFD", "公文格式", (r) => r.svg > 0, "SVG 页"],
    ["漫画", "読切短編集", (r) => r.img > 0, "图片页"],
  ];
  for (const [label, title, judge, detail] of cases) {
    const r = await open(title);
    if (!r) { check(label, false, "书架里没找到" + title); continue; }
    check(label + " 阅读器", judge(r) && !r.error, detail + (r.error ? "｜" + r.error.slice(0, 30) : ""));
    await back();
  }

  // ---- 标注：书签 + 划词高亮 ----
  const pick = (root, from, to) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0, sn = null, so = 0, en = null, eo = 0;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const next = acc + n.length;
      if (!sn && from < next) { sn = n; so = from - acc; }
      if (!en && to <= next) { en = n; eo = to - acc; break; }
      acc = next;
    }
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo);
    return range;
  };

  await open("雪国列车");
  document.querySelector('.reader-topbar button[aria-label="标注"]')?.click();
  await sleep(500);
  document.querySelector(".extras-add")?.click();
  await sleep(700);
  const bookmarkRows = document.querySelectorAll(".annotation-row").length;

  document.querySelector('.toc .drawer-head button[aria-label="关闭"]')?.click();
  await sleep(400);
  const root = document.querySelector(".reader-text");
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(pick(root, 100, 160));
  document.dispatchEvent(new Event("selectionchange"));
  await sleep(400);
  [...document.querySelectorAll(".sel-bar .sel-btn")].find((b) => b.textContent.includes("高亮"))?.click();
  await sleep(900);

  document.querySelector('.reader-topbar button[aria-label="标注"]')?.click();
  await sleep(900);
  check("书签落库", bookmarkRows === 1, bookmarkRows + " 行");
  check("划词高亮", document.querySelectorAll("mark[data-hl]").length > 0, "页内标记");
  check("面板两类并存", document.querySelectorAll(".annotation-row").length === 2, "");
  check(
    "面板顶栏按钮",
    ["导入标注", "导出标注", "关闭"].every((l) =>
      document.querySelector('.toc .drawer-head button[aria-label="' + l + '"]'),
    ),
    "",
  );
  await back();

  // ---- PDF 标注：选中文本层的一段字，划一条线 ----
  await open("建筑十书");
  const pdfSpan = document.querySelector(".pdf-text-layer span");
  if (pdfSpan && pdfSpan.firstChild) {
    const range = document.createRange();
    range.setStart(pdfSpan.firstChild, 0);
    range.setEnd(pdfSpan.firstChild, Math.min(6, pdfSpan.firstChild.length));
    const s2 = window.getSelection();
    s2.removeAllRanges();
    s2.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await sleep(450);
    [...document.querySelectorAll(".sel-bar .sel-btn")].find((b) => b.textContent.includes("高亮"))?.click();
    await sleep(900);
  }
  check("PDF 文本层", !!pdfSpan, "可选中的文字层");
  check("PDF 划词落库", document.querySelectorAll(".pdf-hl").length > 0, "页内划线");

  // ---- PDF 点左右翻页 ----
  // 1.0 加的文本层盖在原来的透明热区之上，把翻页点没了；这里钉住它，别再回退。
  window.getSelection()?.removeAllRanges();
  await sleep(150);
  const pdfStage = document.querySelector(".pdf-stage");
  const pdfBox = pdfStage.getBoundingClientRect();
  const pageText = () =>
    document.querySelector(".reader-page-indicator")?.textContent?.trim() ?? "";
  const tapAt = async (ratio) => {
    const x = pdfBox.left + pdfBox.width * ratio;
    const y = pdfBox.top + pdfBox.height * 0.5;
    pdfStage.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 7 }),
    );
    await sleep(50);
    pdfStage.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 7 }),
    );
    pdfStage.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    await sleep(450);
    return pageText();
  };
  const pdfStart = pageText();
  const pdfRight = await tapAt(0.92);
  const pdfLeft = await tapAt(0.08);
  check("PDF 点右侧翻页", pdfRight !== pdfStart, pdfStart + " → " + pdfRight);
  check("PDF 点左侧回翻", pdfLeft === pdfStart, pdfRight + " → " + pdfLeft);
  await back();

  // ---- 标签 ----
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const card = document.querySelectorAll(".book-card")[0];
  const rect = card.querySelector(".card-target").getBoundingClientRect();
  card.querySelector(".card-target").dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 20 }),
  );
  await sleep(300);
  [...document.querySelectorAll(".book-menu button")].find((b) => b.textContent.includes("标签"))?.click();
  await sleep(400);
  const input = document.querySelector(".dialog input.input");
  input.focus();
  setter.call(input, "冒烟");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(250);
  [...document.querySelectorAll(".dialog button")].find((b) => b.textContent.trim() === "保存")?.click();
  await sleep(800);
  check(
    "标签保存与侧栏",
    [...document.querySelectorAll(".side-panel[aria-label='按标签筛选'] .sidebar-item")].some((b) =>
      b.textContent.includes("冒烟"),
    ),
    "",
  );

  // ---- 批量 ----
  document.querySelector('button[aria-label="多选"]')?.click();
  await sleep(300);
  document.querySelectorAll(".book-card .card-target")[0]?.click();
  await sleep(400);
  const bar = document.querySelector(".selection-bar")?.innerText ?? "";
  check("批量操作条", bar.includes("导出文件") && bar.includes("移入隐私书架"), bar.replace(/\n/g, " ").slice(0, 40));
  document.querySelector('.selection-bar button[aria-label="退出多选"]')?.click();
  await sleep(300);

  // ---- 设置八页 ----
  document.querySelector('button[aria-label="打开设置"]')?.click();
  await sleep(600);
  const labels = [...document.querySelectorAll(".settings-item .settings-item-label")].map((e) => e.textContent);
  let rendered = 0;
  for (const label of labels) {
    [...document.querySelectorAll(".settings-item")]
      .find((i) => i.querySelector(".settings-item-label")?.textContent === label)
      ?.click();
    await sleep(450);
    if ((document.querySelector(".drawer-body")?.innerText ?? "").length > 80) rendered += 1;
    document.querySelector(".drawer-crumb")?.click();
    await sleep(300);
  }
  check("设置八页", rendered === labels.length, rendered + "/" + labels.length);
  document.querySelector('button[aria-label="关闭设置"]')?.click();

  return out;
})()`;

let rows;
try {
  rows = await evaluate(SCRIPT);
} finally {
  ws.close();
  edge.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
}

let failed = 0;
for (const row of rows) {
  if (!row.ok) failed += 1;
  const mark = row.ok ? "✓" : "✗";
  const detail = row.detail ? `  ${row.detail}` : "";
  console.log(`${mark} ${row.name}${detail}`);
}
console.log(failed === 0 ? `\n全部通过（${rows.length} 项）` : `\n失败 ${failed} / ${rows.length} 项`);
process.exit(failed === 0 ? 0 : 1);
