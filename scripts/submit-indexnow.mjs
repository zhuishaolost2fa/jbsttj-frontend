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

/* ── 从 sitemap 里抽出所有 URL ─────────────────────────────────────────── */

function readSitemapUrls() {
  if (!fs.existsSync(SITEMAP)) {
    throw new Error(`找不到 ${SITEMAP}，请先执行 npm run build:h5`);
  }
  const xml = fs.readFileSync(SITEMAP, "utf8");
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
  return [...new Set(urls)];
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

/* ── 提交 ──────────────────────────────────────────────────────────────── */

async function submitBatch(urlList, { dryRun }) {
  const host = new URL(SITE).host;
  const body = {
    host,
    key: KEY,
    keyLocation: `${SITE}/${KEY}.txt`,
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
  if (single) {
    targets = [single];
  } else {
    const all = readSitemapUrls();
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

  if (!targets.length) {
    log("没有需要推送的新 URL，跳过。（想强制重推加 --all）");
    return;
  }

  const keyFile = path.join(DIST, `${KEY}.txt`);
  if (!fs.existsSync(keyFile) && !dryRun) {
    log(`⚠ 未找到 dist/${KEY}.txt —— 请先 npm run build:h5 生成 key 文件，否则搜索引擎会校验失败（403）`);
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
    const all = single ? [] : readSitemapUrls();
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
