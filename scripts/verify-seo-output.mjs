/**
 * SEO 产物体检 —— 构建后跑一次，确认 dist 没被注入逻辑弄坏。
 *
 * 为什么需要它：2026-09-05 出过一次线上白屏 —— 首页注入的清除逻辑用了
 * 范围通杀，把 Taro 的 <script src> 一起清了，SPA 拿不到 JS 整页空白。
 * 当时只检查了自己注入的 meta / JSON-LD，唯独没检查「被改动文件的完整性」。
 *
 * 所以这个脚本的判据分两类，缺一不可：
 *   1. 注入项在不在（meta / JSON-LD / 验证标签）
 *   2. **宿主文件完不完整**（JS 入口 / CSS / #app 挂载点）—— 这条才是命门
 *
 * 用法：node scripts/verify-seo-output.mjs [--strict]
 *       --strict 时警告也按失败处理（CI 用），退出码 1。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STRICT = process.argv.includes("--strict");

let failed = 0;
let warned = 0;

function check(ok, label, detail = "") {
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

function warn(ok, label, detail = "") {
  if (ok) {
    console.log(`[  ok  ] ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`[ warn ] ${label}${detail ? ` — ${detail}` : ""}`);
    warned += 1;
  }
}

function readIndex() {
  const p = path.join(DIST, "index.html");
  if (!fs.existsSync(p)) {
    console.error(`找不到 ${p}，请先执行 npm run build:h5`);
    process.exit(1);
  }
  return fs.readFileSync(p, "utf8");
}

console.log("── SEO 产物体检 ──────────────────────────────");

/* ── 一、宿主文件完整性（命门，出问题就是白屏） ───────────────────── */

const html = readIndex();

const jsEntry = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check(
  jsEntry.length > 0,
  "SPA JS 入口存在",
  jsEntry.length ? jsEntry.join(", ") : "一个都没有 —— 页面会白屏！"
);

// JS 入口指向的文件必须真的在 dist 里，否则同样是白屏
for (const src of jsEntry) {
  const rel = src.replace(/^\//, "").split("?")[0];
  const abs = path.join(DIST, rel);
  const exists = fs.existsSync(abs) && fs.statSync(abs).size > 0;
  check(exists, `JS 资源存在且非空`, `${rel}`);
}

const cssCount = [...html.matchAll(/<link[^>]+stylesheet[^>]*>/g)].length;
check(cssCount > 0, "CSS link 存在", `${cssCount} 个`);

check(/<div id="app"><\/div>/.test(html), "#app 挂载点存在");

/* ── 二、注入项 ──────────────────────────────────────────────────── */

const ldCount = [...html.matchAll(/<script type="application\/ld\+json">/g)].length;
check(ldCount === 3, "JSON-LD 为 3 块（多了说明重复执行时累积了）", `实际 ${ldCount} 块`);

check(/<title>[^<]+<\/title>/.test(html), "title 已注入");
check(/<link rel="canonical"[^>]*>/.test(html), "canonical 已注入");
check(/<meta property="og:title"[^>]*>/.test(html), "og:title 已注入");
check(/<noscript>[\s\S]*?<\/noscript>/i.test(html), "noscript 兜底已注入");

/* ── 三、站点验证标签（都必须在 SEO:HOOK 之前，否则会被清掉） ──────── */

const HOOK = "<!-- SEO:HOOK -->";
const hookIdx = html.indexOf(HOOK);
const verifications = [
  ["百度", "baidu-site-verification"],
  ["Google", "google-site-verification"],
  ["Bing", "msvalidate.01"],
];

for (const [name, metaName] of verifications) {
  const re = new RegExp(`<meta name="${metaName.replace(".", "\\.")}"[^>]*>`);
  const hit = html.match(re);
  const ok = Boolean(hit);
  const beforeHook = ok && hookIdx > -1 && html.indexOf(hit[0]) < hookIdx;
  check(ok && beforeHook, `${name} 验证标签存在且在 SEO:HOOK 之前`, ok ? "" : "缺失");
}

/* ── 四、静态资源 ────────────────────────────────────────────────── */

const files = [
  ["robots.txt", true],
  ["sitemap.xml", true],
  ["llms.txt", true],
  ["llms-full.txt", true],
  ["feed.xml", true],
  ["scripts/index.html", true],
];

for (const [rel, required] of files) {
  const abs = path.join(DIST, rel);
  const ok = fs.existsSync(abs) && fs.statSync(abs).size > 0;
  if (required) check(ok, `${rel} 存在且非空`);
  else warn(ok, `${rel} 存在且非空`);
}

// IndexNow key 文件必须与脚本里的 key 常量一致，否则提交会被拒
const keyMatch = fs
  .readFileSync(path.join(__dirname, "gen-seo-pages.mjs"), "utf8")
  .match(/const INDEXNOW_KEY\s*=\s*[^"']*["']([a-f0-9]{32})["']/i);
if (keyMatch) {
  const keyFile = path.join(DIST, `${keyMatch[1]}.txt`);
  const ok = fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8").trim() === keyMatch[1];
  check(ok, `IndexNow key 文件一致（${keyMatch[1]}.txt）`);
}

/* ── 五、sitemap 抽查 ────────────────────────────────────────────── */

const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
const locs = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
check(locs.length > 0, "sitemap 含 URL", `${locs.length} 条`);

const badLastmod = [...sitemap.matchAll(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/g)]
  .map((m) => m[1])
  .filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
check(badLastmod.length === 0, "sitemap lastmod 格式合法", badLastmod.join(", "));

// 内容页目录要真的存在，否则 sitemap 里就是死链
const contentPages = locs.filter((u) => /\/s\/[^/]+\/$/.test(u));
const missing = contentPages.filter((u) => {
  const slug = u.replace(/\/$/, "").split("/").pop();
  return !fs.existsSync(path.join(DIST, "s", slug, "index.html"));
});
check(missing.length === 0, "sitemap 内容页无死链", missing.join(", ") || `${contentPages.length} 个内容页全部有产物`);

/* ── 汇总 ────────────────────────────────────────────────────────── */

console.log("─────────────────────────────────────────────");
if (failed === 0 && warned === 0) {
  console.log("全部通过。");
  process.exit(0);
}
if (failed === 0) {
  console.log(`通过，但有 ${warned} 条警告。`);
  process.exit(STRICT ? 1 : 0);
}
console.log(`失败 ${failed} 项${warned ? `，警告 ${warned} 项` : ""}。`);
process.exit(1);
