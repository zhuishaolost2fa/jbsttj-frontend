/**
 * IndexNow 即时索引推送。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 百度对未备案站点的 sitemap / API 配额基本是 0，提交了也只是挂着等爬虫自然来。
 * IndexNow 是 Bing / Yandex / Seznam / Naver 共同支持的开放协议，ChatGPT 搜索与
 * Copilot 也消费 Bing 索引，所以推 IndexNow = 同时打通「搜索引擎 + AI 引用」两条路。
 * 没有每日配额限制，提交后搜索引擎几秒内就会回源抓取。
 *
 * 工作原理：
 *   1. 你生成一个 key，把 {key}.txt（内容即 key 本身）放在站点根目录
 *      —— 这一步由 scripts/gen-seo-pages.mjs 在构建期完成；
 *   2. POST 一组 URL 给 IndexNow，带上 key 与 keyLocation；
 *   3. 搜索引擎回源校验 https://{host}/{key}.txt 内容匹配，确认所有权后入队抓取。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   node scripts/submit-indexnow.mjs              # 只推上次以来新增/变化的 URL
 *   node scripts/submit-indexnow.mjs --all        # 全量重推（换 key 或首次上线时用）
 *   node scripts/submit-indexnow.mjs --dry-run    # 只看会推哪些，不真发请求
 *   node scripts/submit-indexnow.mjs --url=https://.../s/xxx/
 *   node scripts/submit-indexnow.mjs --force      # 跳过协议一致性守卫（见下）
 *
 * ── 协议一致性守卫（2026-09-08 加） ──────────────────────────────────────
 * sitemap 里写的 URL 是 https，但站点备案 / 证书没就绪时 https 可能完全不通。
 * 这种情况下推送链路是通的（IndexNow 收得到），抓取链路却是断的（搜索引擎回源
 * 抓不到）→ 等于主动给搜索引擎喂一批死链，比不推更糟。
 * 所以脚本会在提交前比对「sitemap URL 的协议」与「站点实际可用的协议」，
 * 不一致就中止，等 https 就绪后自动放行。确要强推加 --force。
 *
 * 环境变量：
 *   SEO_SITE_ORIGIN      站点域名（默认 https://www.jbs-ttj.store）
 *   SEO_INDEXNOW_KEY     IndexNow key（需与构建期写入 dist 的 {key}.txt 一致）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const SITEMAP = path.join(DIST, "sitemap.xml");
/** 已提交过的 URL 缓存，避免重复推送（IndexNow 官方建议只推变化过的 URL） */
const CACHE = path.join(ROOT, ".indexnow-cache.json");

const SITE = (process.env.SEO_SITE_ORIGIN || "https://www.jbs-ttj.store").replace(/\/$/, "");
const KEY = process.env.SEO_INDEXNOW_KEY || "a974c0bdda0bce480a92cb9de8a65197";
/** 每次请求最多 10000 条（IndexNow 规范上限），这里保守分批 */
const BATCH = 500;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const log = (...a) => console.log("[indexnow]", ...a);

/* ── 站点 origin 探测（备案期 https 可能不通） ─────────────────────────── */

/** 探测到的可用 origin（带协议），null = 还没探测 */
let resolvedOrigin = null;
/** key 文件是否能在站点根目录正常访问到（内容等于 KEY 本身） */
let keyFileOnline = false;

/**
 * 站点真正可用的 origin。
 *
 * 备案 / 证书没就绪时 https 可能完全不通（curl 直接返回 000），而 SITE 默认写的是
 * https。IndexNow 的 `keyLocation` 若指向不通的协议，搜索引擎回源校验 key 必然
 * 失败（403），整批推送等于白做。所以启动后先探测一次：能取到内容等于 KEY 的
 * key 文件才算这个 origin 通，https 不通就降级 http。
 */
async function resolveOrigin() {
  if (resolvedOrigin) return resolvedOrigin;
  const candidates = [...new Set([SITE, SITE.replace(/^https:\/\//, "http://")])];
  for (const origin of candidates) {
    try {
      const res = await fetch(`${origin}/${KEY}.txt`, {
        signal: AbortSignal.timeout(8000),
      });
      const text = (await res.text().catch(() => "")).trim();
      if (res.ok && text === KEY) {
        resolvedOrigin = origin;
        keyFileOnline = true;
        if (origin !== SITE) log(`https 不可用，已降级为 ${origin}`);
        return origin;
      }
      log(`origin 探测未通过：${origin}（HTTP ${res.status}，内容不匹配）`);
    } catch (err) {
      log(`origin 探测失败：${origin} → ${err.message}`);
    }
  }
  // 都失败就沿用配置值，让后面的提交把真实错误暴露出来
  resolvedOrigin = SITE;
  return SITE;
}

/* ── 从 sitemap 里抽出所有 URL ─────────────────────────────────────────── */

/** 从 sitemap XML 抽 <loc>，去重 */
function parseLocs(xml) {
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
  return [...new Set(urls)];
}

/**
 * 取待推送的 URL 全集。
 *
 * 优先读本地 `dist/sitemap.xml`；**本地没有（比如最后一次构建是 build:weapp）时
 * 直接拉线上 sitemap**。这么做有三个好处：
 *   1. 不必为了推送而专门跑一次 H5 构建 —— 构建会清空重建 dist/，把小程序产物覆盖掉；
 *   2. 推的一定是线上真实存在的 URL。本地构建过但还没部署的 URL 推给搜索引擎
 *      只会收获一批 404，反而伤收录；
 *   3. 定时任务（每天 02:00）因此不再依赖本地产物状态。
 */
async function readSitemapUrls() {
  if (fs.existsSync(SITEMAP)) {
    const urls = parseLocs(fs.readFileSync(SITEMAP, "utf8"));
    log(`使用本地 sitemap：dist/sitemap.xml（${urls.length} 条）`);
    return urls;
  }
  const origin = await resolveOrigin();
  const url = `${origin}/sitemap.xml`;
  log(`本地 dist/sitemap.xml 不存在，改为拉取线上 ${url}`);
  let xml = "";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    throw new Error(`拉取线上 sitemap 失败：${err.message}（也可本地执行 npm run build:h5 生成 dist/sitemap.xml）`);
  }
  if (!/<urlset|<sitemapindex/i.test(xml)) {
    throw new Error(`${url} 返回的不是 sitemap（多半是 SPA 兜底页）`);
  }
  const urls = parseLocs(xml);
  if (!urls.length) throw new Error(`${url} 里没有解析到任何 <loc>`);
  return urls;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return { key: null, urls: [] };
  }
}

function writeCache(key, urls) {
  fs.writeFileSync(CACHE, `${JSON.stringify({ key, urls, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

/**
 * 协议一致性守卫：确认待推的 URL 协议是站点当前真能访问的那个。
 *
 * 场景：sitemap 提前写好了 https（备案后不用改），但站点 https 还没通。此时
 * 推送能成功、抓取必失败，搜索引擎收到的是一批 404 —— 这个信号比不推更负面。
 * 所以协议对不上就中止，https 一通就自动放行，不用回头改代码。`--force` 可覆盖。
 */
async function assertProtocolReachable(urls) {
  if (has("--force")) {
    log("已指定 --force：跳过协议一致性守卫");
    return;
  }
  const origin = await resolveOrigin();
  const okProto = new URL(origin).protocol;
  const mismatch = urls.filter((u) => {
    try {
      return new URL(u).protocol !== okProto;
    } catch {
      return false; // 解析不了的不拦，交给后续真实请求暴露
    }
  });
  if (!mismatch.length) return;

  throw new Error(
    [
      `已中止推送：站点当前只有 ${okProto.replace(":", "")} 可用，但待推 URL 中有 ${mismatch.length}/${urls.length} 条是另一种协议（例：${mismatch[0]}）。`,
      `  这些 URL 搜索引擎回源抓不到，推过去只是喂死链。`,
      `  等 https（备案 + 证书）就绪后重跑本脚本即可自动放行；确需强推加 --force。`,
    ].join("\n")
  );
}

/* ── 提交 ──────────────────────────────────────────────────────────────── */

async function submitBatch(urlList, { dryRun }) {
  const host = new URL(SITE).host;
  // keyLocation 必须是搜索引擎真能访问到的地址 —— 备案期 https 不通时要用探测到的 http
  const origin = await resolveOrigin();
  const body = {
    host,
    key: KEY,
    keyLocation: `${origin}/${KEY}.txt`,
    urlList,
  };

  if (dryRun) {
    log(`[dry-run] 将提交 ${urlList.length} 条 → ${host}`);
    urlList.slice(0, 5).forEach((u) => log(`  ${u}`));
    if (urlList.length > 5) log(`  … 其余 ${urlList.length - 5} 条`);
    return { ok: true, status: "dry-run" };
  }

  // 两个端点都要提交，而不是「成功即停」：
  // 1) www.bing.com/indexnow —— 只有走 Bing 自己的端点，Bing Webmaster 后台的
  //    「IndexNow Insights」报表才会记录这次提交（api.indexnow.org 的不计数）；
  // 2) api.indexnow.org —— 协议聚合端点，会把 URL 再分发给 Yandex / Seznam / Naver 等。
  // 重复提交是幂等的，搜索引擎侧只当作同一次通知。
  const endpoints = ["https://www.bing.com/indexnow", "https://api.indexnow.org/IndexNow"];
  let lastErr = null;
  let anyOk = false;
  let okStatus = null;
  let okEndpoint = null;

  for (const endpoint of endpoints) {
    let endpointDone = false;
    for (let attempt = 1; attempt <= 3 && !endpointDone; attempt += 1) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        });
        // 200 已入队 / 202 已接收待校验
        if (res.status === 200 || res.status === 202) {
          log(`  ✓ ${endpoint} → HTTP ${res.status}`);
          anyOk = true;
          okStatus = okStatus ?? res.status;
          okEndpoint = okEndpoint ?? endpoint;
          endpointDone = true;
          break;
        }
        if (res.status === 429) {
          // 限流：退避后重试
          const wait = attempt * 3000;
          log(`  ${endpoint} 限流，${wait}ms 后重试（第 ${attempt} 次）`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const text = await res.text().catch(() => "");
        lastErr = new Error(`${endpoint} → HTTP ${res.status} ${text.slice(0, 200)}`);
        // 4xx 里 403 = key 校验失败，换端点也没用，直接抛出给人看
        if (res.status === 403) throw lastErr;
        endpointDone = true; // 其他错误换下一个端点
      } catch (err) {
        lastErr = err;
        if (String(err.message).includes("HTTP 403")) throw err;
        if (attempt >= 3) endpointDone = true;
        else await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }

  if (anyOk) {
    return { ok: true, status: okStatus, endpoint: `${okEndpoint}（+ 聚合端点）` };
  }
  throw lastErr ?? new Error("所有端点均提交失败");
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

async function main() {
  const dryRun = has("--dry-run") || has("-n");
  const forceAll = has("--all");
  const single = argVal("url");

  let targets;
  /** sitemap 全集，末尾写缓存时复用，避免重复解析/拉取 */
  let all = [];
  if (single) {
    targets = [single];
  } else {
    all = await readSitemapUrls();
    log(`sitemap 中共 ${all.length} 条 URL`);
    if (forceAll) {
      targets = all;
      log("指定 --all：全量重推");
    } else {
      const cache = readCache();
      // key 变了说明重建过身份，必须全量重推
      const keyChanged = cache.key !== KEY;
      const seen = new Set(keyChanged ? [] : cache.urls);
      targets = all.filter((u) => !seen.has(u));
      if (keyChanged && cache.urls?.length) log("IndexNow key 已变更，全量重推");
      log(`其中 ${targets.length} 条尚未提交过`);
    }
  }

  await assertProtocolReachable(targets);

  if (!targets.length) {
    log("没有需要推送的新 URL，跳过。（想强制重推加 --all）");
    return;
  }

  const keyFile = path.join(DIST, `${KEY}.txt`);
  if (!fs.existsSync(keyFile) && !dryRun) {
    // 本地没构建过就没这个文件，但只要线上能访问到，搜索引擎校验照样过
    const origin = await resolveOrigin();
    if (keyFileOnline) {
      log(`本地 dist/${KEY}.txt 缺失，但线上 ${origin}/${KEY}.txt 可正常访问，校验不受影响`);
    } else {
      log(`⚠ key 文件不可用：本地 dist/${KEY}.txt 不存在，线上 ${origin}/${KEY}.txt 也访问不到 —— 搜索引擎会校验失败（403）`);
    }
  }

  let okCount = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    log(`提交批次 ${Math.floor(i / BATCH) + 1}/${Math.ceil(targets.length / BATCH)}（${batch.length} 条）`);
    const r = await submitBatch(batch, { dryRun });
    if (r.ok) {
      okCount += batch.length;
      log(`  ✓ 成功${r.status === "dry-run" ? "（dry-run）" : ` HTTP ${r.status} @ ${r.endpoint}`}`);
    } else {
      log(`  ✗ 失败：${r.error}`);
    }
  }

  if (dryRun) {
    log("dry-run 结束，未真正提交。去掉 --dry-run 即可实际推送。");
    return;
  }

  if (okCount > 0) {
    // 记录成功提交的 URL（全量模式下以 sitemap 全集为准）
    const nextUrls = forceAll || !single ? all : [...new Set([...(readCache().urls || []), ...targets])];
    writeCache(KEY, nextUrls);
    log(`✓ 已推送 ${okCount} 条 URL，缓存已更新（.indexnow-cache.json）`);
    log("  搜索引擎通常几秒到几分钟内回源抓取，可在 Bing Webmaster → URL Inspection 查看状态。");
  }
}

main().catch((err) => {
  console.error("[indexnow] 失败：", err.message);
  process.exit(1);
});
