/**
 * 开发期假后端：浏览器里没有 Tauri 运行时，`npm run dev` 直接打开是一片空白，
 * 任何视觉自查（截图、配色核对、unslop 审计）都做不了。
 *
 * 这里给 `window.__TAURI_INTERNALS__.invoke` 装一张命令表，让现有的 api 层
 * （api.ts / textApi / privacyApi …）一行不改就能拿到数据。
 *
 * 三条硬约束：
 * 1. 只在 `import.meta.env.DEV` 下安装，生产构建里这段代码被整段消除；
 * 2. 真 Tauri 里 `__TAURI_INTERNALS__` 已存在，直接跳过，不会盖掉真后端；
 * 3. 不 mock 写操作的结果一致性 —— 书架增删只为了看得见，不为验证逻辑。
 *
 * 额外用法：`?theme=light` / `?theme=dark`、`?material=flat` / `?material=liquid`
 * 写进 localStorage，方便一次跑出两套主题 × 两种材质的截图（可同时传）。
 */
import type { Book, LibraryRoot, Progress, TextBook } from "../types";
import type { Annotation } from "../api";

const PREFS_KEY = "reader.prefs.v1";

/** 十几本书，覆盖三种书架配色来源：真封面（无）、文字封面、异常态 */
function makeBooks(): Book[] {
  const base = Date.UTC(2026, 10, 16, 3, 0, 0) / 1000;
  const seed: Array<[string, Book["type"], Book["format"], string | null, number, Progress | null]> = [
    ["长夜将尽", "novel", "epub", "沈砚", 62, { kind: "epub", cfi: null, href: "ch3.xhtml", progression: 0.42 }],
    ["雪国列车上的十二封信", "novel", "txt", "伊藤一葉", 38, { kind: "text", offset: 18400, chapter: 7, total: 41 }],
    ["山海食记", "novel", "mobi", null, 91, { kind: "text", offset: 62000, chapter: 3, total: 12 }],
    ["夜航船·校注本", "doc", "docx", "张岱", 12, null],
    ["読切短編集 2019", "comic", "cbz", "なつめ", 88, { kind: "paged", page: 61, total: 208, zoom: 1, spread: "double" }],
    ["银翼的证词", "comic", "folder", null, 15, { kind: "paged", page: 4, total: 96, zoom: 1, spread: "single" }],
    ["建筑十书", "pdf", "pdf", "维特鲁威", 44, { kind: "paged", page: 0, total: 1, zoom: 1, spread: "single" }],
    ["公文格式规范 GB/T 9704", "doc", "ofd", null, 6, { kind: "paged", page: 2, total: 9, zoom: 1, spread: "single" }],
    ["季度数据汇总", "doc", "xlsx", null, 3, null],
    ["无名手记", "novel", "md", null, 71, { kind: "text", offset: 300, chapter: 1, total: 1 }],
    ["旧书店的猫", "novel", "fb2", "高橋みどり", 55, { kind: "text", offset: 9000, chapter: 2, total: 6 }],
    ["未命名的第七本", "novel", "txt", null, 0, null],
  ];

  return seed.map(([title, type, format, author, sizeMb, progress], i): Book => ({
    id: `dev-${i}`,
    type,
    format,
    path: `C:\\Books\\${title}.${format}`,
    size: sizeMb * 1024 * 1024,
    mtime: base - i * 86_400,
    title,
    author,
    cover_path: null,
    cover_state: "placeholder",
    meta_locked: false,
    // 倒数第二本演示「待恢复」，最后一本演示「文件已丢失」
    status: i === 10 ? "pending" : "ok",
    private: false,
    missing: i === 11,
    progress,
    metadata: null,
    added_at: base - i * 3600,
    last_read_at: progress ? base - i * 5400 : null,
  })).map((book): Book =>
    // 浏览器里没有真实文件：PDF 指向内联的最小文档，否则 pdf.js 只会拿到一个不存在的路径
    book.format === "pdf" ? { ...book, path: PDF_FIXTURE } : book,
  );
}

const CHAPTERS = ["第一章 雨落在旧站台", "第二章 借来的名字", "第三章 灯下的地图"];

function textBook(): TextBook {
  return {
    encoding: "utf-8",
    total_bytes: 48_000,
    chapters: CHAPTERS.map((title, i) => ({ title, start: i * 16_000, end: (i + 1) * 16_000 })),
  };
}

/**
 * 假正文的段落池。
 *
 * 之前是四句话轮流 + 一行「这段文字用来量行高与版心宽度」的占位符：
 * 截图自查时那行占位符会明晃晃地出现在每一屏里，README 用的图根本没法看。
 * 现在换成一串能连起来读的叙述，按起点错开取用，翻页与换章都不会重复同一段。
 */
const PARAGRAPH = [
  "雨是从午后开始下的，到傍晚已经把站台的铁皮顶敲出一层密密的白噪。",
  "他把伞收起来，抖了两下水，随手靠在长椅上——那把伞的骨架上还留着上一趟旅程的泥点。",
  "广播里的女声第三次报错了站名，没有人纠正它，也没有人下车。",
  "书摊老板从抽屉里摸出一本旧书，封皮被翻得起了毛边，书脊上用铅笔写着一个不属于任何人的名字。",
  "候车室的长椅是木头的，坐久了会随着体温一点点变软，像有人在背后轻轻推你一把。",
  "他翻开第一页，纸上有一道旧水渍，形状像一只缩着脖子的鸟。",
  "列车进站时没有鸣笛，只是把灯光铺过来，把每个人的影子都压得更扁了一些。",
  "有人在他旁边坐下，身上带着洗过衣服的皂味，还有一点几乎闻不出的机油味。",
  "窗外的田野沉进黑暗里，只剩电线杆一根根掠过去，像在数什么东西。",
  "他忽然想起很多年前也坐过这一趟车，那时车厢里还有人抽烟，窗户是可以推开的。",
  "书里的故事讲到一个邮差，每天把信送到同一个地址，收信的人却早已搬走了。",
  "他把这句话读了两遍，觉得它像一句没说完的劝告。",
  "车厢尽头的门开着，风从那里进来，把每个人的衣角都吹得朝一个方向。",
  "一个孩子趴在窗玻璃上，用手指在雾气里写字，写完就抹掉，反复很多次。",
  "推车经过时叮当响了两声，卖的是热茶和一种很甜的饼干。",
  "他要了一杯，热气升上来，眼镜片上立刻起了白茫茫的一层。",
  "邻座的人在读报纸，读得很慢，像是每个字都要在心里过一遍。",
  "报纸的中缝有一则寻人启事，照片模糊得只剩下一个轮廓。",
  "他想起自己也曾把一封信投进邮筒，然后站在雨里等回音。",
  "回音没有来，雨倒是越下越大，最后连邮筒的红漆都看不清楚了。",
  "列车在一个没有名字的小站停了三十秒，没有人上车，也没有人下去。",
  "站台上的灯是坏的，只有远处一间屋子亮着，像有人忘了关。",
  "他合上书，把书签夹在这一页，书签是一张过期的车票。",
  "车票上的日期已经褪色，但那个终点站的名字还看得清。",
];

/**
 * 浏览器预览用的假内容。
 *
 * devMock 原先只做了文本与 EPUB，DOCX / PDF / OFD / XLSX / 漫画打开后是「壳起来了但正文空白」——
 * 这几个阅读器在浏览器里等于没法验证。这里给每种格式一份最小素材：
 * - PDF 是一份手写的 604 字节单页文档（base64 内联，pdf.js 直接吃 data URL）；
 * - 漫画页是 SVG data URL，`<img>` 能渲染；
 * - DOCX / XLSX / MD 走同一个 HTML 管道，各给一段有代表性的结构（标题、表格、列表）。
 */
const PDF_FIXTURE =
  "data:application/pdf;base64," +
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA0MjAgNTYwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDkxPj5zdHJlYW0KQlQgL0YxIDIyIFRmIDQ4IDQ2MCBUZCAoQ2Vucm8gZGV2IGZpeHR1cmUpIFRqIEVUCkJUIC9GMSAxMiBUZiA0OCA0MjAgVGQgKHBhZ2UgMSBvZiAxKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDYwIDAwMDAwIG4gCjAwMDAwMDAxMTEgMDAwMDAgbiAKMDAwMDAwMDIyMyAwMDAwMCBuIAowMDAwMDAwMzYxIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDI0CiUlRU9GCg==";

const MD_HTML = `<h2>第一章 起风</h2>
<p>写字的地方要安静，最好窗外有雨。<strong>手上的笔记</strong>与<em>心里的句子</em>不必一致。</p>
<h3>三条备忘</h3>
<ul><li>先写，再改。</li><li>删掉形容词。</li><li>读出声。</li></ul>
<pre><code>const patience = () =&gt; time + repeat;</code></pre>
<p>最后一段用来验证段落间距。</p>`;

const DOCX_HTML = `<h2>夜航船·校注本</h2>
<p>卷一　天文部。凡例：此书为笺注本，正文与注文以字号区分。</p>
<table><thead><tr><th>卷</th><th>部</th><th>条数</th></tr></thead>
<tbody><tr><td>一</td><td>天文</td><td>一百零七</td></tr>
<tr><td>二</td><td>地理</td><td>九十三</td></tr></tbody></table>
<p>注：条目按原书次序排列，未作分类重排。</p>`;

const XLSX_HTML = `<h2>季度数据汇总</h2>
<table><thead><tr><th>季度</th><th>新增</th><th>在读</th><th>完成率</th></tr></thead>
<tbody><tr><td>Q1</td><td>12</td><td>9</td><td>62%</td></tr>
<tr><td>Q2</td><td>18</td><td>14</td><td>78%</td></tr>
<tr><td>Q3</td><td>21</td><td>17</td><td>81%</td></tr></tbody></table>`;

/** OFD 页：真实现场是后端把页面转成 SVG，这里给一份能看出页码的 */
function ofdPageSvg(index: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842">
  <rect width="595" height="842" fill="#ffffff"/>
  <rect x="56" y="56" width="483" height="730" fill="none" stroke="#c8102e" stroke-width="2"/>
  <text x="297" y="120" font-size="28" text-anchor="middle" fill="#222">公文格式规范 GB/T 9704</text>
  <text x="297" y="170" font-size="16" text-anchor="middle" fill="#666">第 ${index + 1} 页</text>
  <line x1="56" y1="200" x2="539" y2="200" stroke="#c8102e" stroke-width="1"/>
</svg>`;
}

/** 漫画页：SVG data URL，`<img>` 直接能画 */
function comicPage(index: number): string {
  const hue = (index * 37) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1200">
  <rect width="800" height="1200" fill="hsl(${hue} 42% 82%)"/>
  <rect x="60" y="60" width="680" height="1080" fill="none" stroke="hsl(${hue} 30% 45%)" stroke-width="6"/>
  <text x="400" y="580" font-size="96" text-anchor="middle" fill="hsl(${hue} 35% 32%)">${index + 1}</text>
  <text x="400" y="680" font-size="28" text-anchor="middle" fill="hsl(${hue} 25% 40%)">dev fixture</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function textRange(start: number, end: number): string {
  const target = Math.max(240, end - start);
  const out: string[] = [];
  let size = 0;
  // 起点决定从哪一句开始：不同章节（间隔 16000 字节）打开时不会总是同一段
  let i = Math.floor(start / 37);
  while (size < target) {
    const paragraph = PARAGRAPH[i % PARAGRAPH.length];
    out.push(`　　${paragraph}`);
    size += paragraph.length + 3;
    i += 1;
  }
  return out.join("\n");
}

/**
 * 浏览器预览用的假背景图（dev only）。
 *
 * 真 Tauri 里 convertFileSrc 走 asset 协议能直接读本地文件；
 * 浏览器没有那条协议，`<img src="C://...">` 只会 onError。
 * 这里给一个内联 SVG，专门用来验证图层顺序、模糊半径与遮罩强度——
 * 它是一张"有明确色相"的图，所以顺带能把莫奈取色的 UI 跑通。
 */
const DEV_BACKGROUND =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2b5f8f"/>
          <stop offset="0.55" stop-color="#7fb2c9"/>
          <stop offset="1" stop-color="#e8d9b8"/>
        </linearGradient>
        <radialGradient id="sun" cx="0.72" cy="0.3" r="0.38">
          <stop offset="0" stop-color="#f6d9a0" stop-opacity="0.95"/>
          <stop offset="1" stop-color="#f6d9a0" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#sky)"/>
      <circle cx="1150" cy="300" r="260" fill="url(#sun)"/>
      <path d="M0 760 L420 520 L760 720 L1120 470 L1600 780 L1600 1000 L0 1000 Z" fill="#2f4a52" opacity="0.85"/>
      <path d="M0 860 L360 700 L820 860 L1240 690 L1600 880 L1600 1000 L0 1000 Z" fill="#1d3038" opacity="0.9"/>
    </svg>`,
  );

export function installDevMock(): void {
  const w = window as unknown as Record<string, unknown>;
  if (!import.meta.env.DEV || "__TAURI_INTERNALS__" in w) return;

  // 主题：截图时用 ?theme=light 免去手点设置
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "light" || theme === "dark") {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...raw, theme }));
    } catch {
      /* 存不进去就按默认主题走 */
    }
  }

  // 材质：?material=liquid 同上。与 theme 分开读写，两个参数可同时传
  const material = new URLSearchParams(location.search).get("material");
  if (material === "flat" || material === "liquid") {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...raw, material }));
    } catch {
      /* 同上 */
    }
  }

  const books = makeBooks();
  const roots: LibraryRoot[] = [{ id: 1, path: "C:\\Books", added_at: books[0].added_at }];

  // 标签：内存里一份 Map，够侧栏与编辑弹窗走通
  const bookTags = new Map<string, string[]>();
  const tagList = () => {
    const counts = new Map<string, number>();
    bookTags.forEach((tags) => tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  // 标注：内存里存一份，浏览器里也能试划词、看列表
  const annotations: Annotation[] = [];
  let annotationSeq = 0;

  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_roots: () => roots,
    list_books: (a) => {
      const q = (a.query as string | null)?.trim().toLowerCase();
      const kind = a.kind as string | null;
      return books
        .filter((b) => !kind || kind === "all" || b.type === kind)
        .filter((b) => !q || b.title.toLowerCase().includes(q) || (b.author ?? "").toLowerCase().includes(q));
    },
    library_stats: () => books.length,
    get_book: (a) => books.find((b) => b.id === a.id) ?? null,
    book_kind: (a) => books.find((b) => b.id === a.id)?.type ?? "novel",
    save_progress: () => null,
    update_book_meta: (a) => {
      const b = books.find((x) => x.id === a.id);
      if (b) {
        b.title = a.title as string;
        b.author = a.author as string | null;
        b.meta_locked = true;
      }
      return null;
    },
    remove_book: () => ({ file_trashed: false, pending: false }),
    relocate_book: (a) => books.find((b) => b.id === a.id) ?? null,
    scan_library: () => ({
      scanned: books.length,
      added: 0,
      updated: 0,
      skipped: books.length,
      removed: 0,
      failed: 0,
      failures: [],
      elapsed_ms: 42,
    }),
    open_text_book: () => textBook(),
    read_text_range: (a) => textRange(a.start as number, a.end as number),
    privacy_status: () => ({ enabled: false, unlocked: true, lock_after_minutes: 0, private_books: 0 }),
    cache_report: () => ({ comic: 128 * 1024 * 1024, epub: 64 * 1024 * 1024, covers: 9 * 1024 * 1024 }),
    backup_config: () => ({
      webdav: { url: "", username: "", password: "", dir: "cenro", keep: 5 },
      include_covers: true,
      last_local_at: null,
      last_webdav_at: null,
    }),
    backup_list_local: () => [],
    // EPUB：给两章能看的假正文，方便核对划线在 innerHTML 上的表现
    open_epub: () => ({
      title: "长夜将尽",
      author: "沈砚",
      chapters: [
        { href: "ch1.xhtml", title: "第一章 夜车" },
        { href: "ch2.xhtml", title: "第二章 站台" },
      ],
    }),
    read_epub_chapter: (a) =>
      `<h2>${a.href === "ch2.xhtml" ? "第二章 站台" : "第一章 夜车"}</h2>` +
      `<p>雨从午后开始下，到傍晚已经把站台的铁皮顶敲出一层密密的白噪。他把伞收起来，抖了两下水，随手靠在长椅上——那把伞的骨架上还留着上一趟旅程的泥点。</p>` +
      `<p>广播里的女声第三次报错了站名<sup><a href="#fn1" id="fnref1">1</a></sup>，没有人纠正它，也没有人下车。` +
      `书摊老板从抽屉里摸出一本旧书，封皮被翻得起了毛边，书脊上用铅笔写着一个不属于任何人的名字。</p>` +
      `<aside class="footnotes"><p id="fn1">1 这趟列车的时刻表在 1978 年改过一次，站名却沿用旧称，于是每年都有人下错站。` +
      `<a href="#fnref1">返回</a></p></aside>`,
    read_epub_resource: () => "",
    export_books: (a) => ({
      copied: (a.ids as string[]).length,
      renamed: 0,
      missing: [],
      failed: [],
      blocked: 0,
      total: (a.ids as string[]).length,
    }),
    // ---- 其余格式的假实现：让每个阅读器都能在浏览器里跑通 ----
    open_md_book: () => ({
      encoding: "utf-8",
      total_bytes: MD_HTML.length,
      chapters: [{ title: "无名手记", start: 0, end: MD_HTML.length }],
    }),
    read_md_chapter: () => MD_HTML,

    open_docx_book: () => ({
      encoding: "utf-8",
      total_bytes: DOCX_HTML.length,
      chapters: [{ title: "夜航船·校注本", start: 0, end: DOCX_HTML.length }],
    }),
    read_docx_chapter: () => DOCX_HTML,

    open_xlsx_book: () => ({
      encoding: "utf-8",
      total_bytes: XLSX_HTML.length,
      chapters: [{ title: "季度数据汇总", start: 0, end: XLSX_HTML.length }],
    }),
    read_xlsx_chapter: () => XLSX_HTML,

    open_ofd: () => ({
      title: "公文格式规范 GB/T 9704",
      pages: 9,
      width: 595,
      height: 842,
    }),
    ofd_page_svg: (a) => ofdPageSvg(Number(a.index ?? 0)),

    list_comic_pages: () => Array.from({ length: 24 }, (_, i) => `page-${i + 1}.jpg`),
    comic_page_path: (a) => comicPage(Number(a.index ?? 0)),

    // 关于页要显示版本号；浏览器里没有 Tauri 的 app 插件
    "plugin:app|version": () => "0.21.0",

    list_tags: () => tagList(),
    list_tag_assignments: () => [...bookTags.entries()].flatMap(([id, tags]) => tags.map((t) => [id, t])),
    set_book_tags: (a) => {
      const tags = [...new Set((a.tags as string[]).map((t) => t.trim()).filter(Boolean))].slice(0, 20);
      bookTags.set(a.id as string, tags);
      return tags;
    },
    delete_tag: (a) => {
      bookTags.forEach((tags, id) => bookTags.set(id, tags.filter((t) => t !== a.name)));
      return null;
    },
    list_annotations: (a) =>
      annotations.filter(
        (x) => x.book_id === a.id && (!a.kind || x.kind === (a.kind as string)),
      ),
    add_annotation: (a) => {
      const now = Math.floor(Date.now() / 1000);
      const item: Annotation = {
        id: `dev-a-${(annotationSeq += 1)}`,
        book_id: a.id as string,
        kind: a.kind as Annotation["kind"],
        locator: a.locator as Annotation["locator"],
        label: (a.label as string | null) ?? null,
        excerpt: (a.excerpt as string | null) ?? null,
        anchor: (a.anchor as Annotation["anchor"]) ?? null,
        created_at: now,
        updated_at: now,
      };
      annotations.push(item);
      return item;
    },
    update_annotation_label: (a) => {
      const item = annotations.find((x) => x.id === a.annotationId);
      if (item) item.label = (a.label as string | null) ?? null;
      return null;
    },
    delete_annotation: (a) => {
      const index = annotations.findIndex((x) => x.id === a.annotationId);
      if (index >= 0) annotations.splice(index, 1);
      return null;
    },
    export_annotations: () => annotations.length,
    // 浏览器里没有文件选择器，导入不会真的触发；给一条空结果免得报「命令未实现」
    import_annotations: () => ({ imported: 0, skipped: 0, total: 0, source_title: "（浏览器预览）" }),
    search_book: () => [],
    // 桌面端启动会挂拖拽监听，给个能吞掉的 id
    "plugin:event|listen": () => 1,
    "plugin:event|unlisten": () => null,
    // 莫奈取色：dev 下给一组固定值，对应上面那张假背景图的海蓝
    monet_palette: () => ({
      hue: 205,
      saturation: 0.46,
      lightness: 0.44,
      mean_lightness: 0.52,
      coverage: 0.61,
    }),
    "plugin:dialog|open": () => null,
    // 许可全文编在二进制里，浏览器拿不到：给够长的占位，专门核对滚动与折行
    license_texts: () => [
      {
        name: "岑序 · GNU GPL v3.0 or later（浏览器预览为占位文本）",
        body: Array.from(
          { length: 40 },
          (_, i) => `第 ${i + 1} 行：真实正文是 GPL-3.0 全文，这里只用来核对弹窗的滚动高度与窄屏折行。`,
        ).join("\n"),
      },
      {
        name: "unrar-rs · Apache-2.0 + UnRAR 附加条款（占位）",
        body: "unrar-rs is licensed under the Apache License, Version 2.0, with one further condition on its RAR engine.",
      },
    ],
  };

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback: (cb: (payload: unknown) => void) => {
      const id = Math.floor(Math.random() * 1e9);
      (w[`_${id}`] as unknown) = cb;
      return id;
    },
    // 只有 dev: 前缀的路径有真图可加载；其余返回原路径，让 <img> 自然 onError
    convertFileSrc: (p: string) => (p.startsWith("dev:") ? DEV_BACKGROUND : p),
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = commands[cmd];
      if (!handler) return Promise.reject(new Error(`[devMock] 未实现的命令：${cmd}`));
      return Promise.resolve(handler(args));
    },
  };
}
