/**
 * 页面级 SEO 元信息：为每个页面设置浏览器标题、description、canonical、og / twitter。
 *
 * 为什么不用页面 config（navigationBarTitleText）一劳永逸？
 *   - config 只覆盖**静态**标题，剧本详情这类标题取决于路由参数的页面做不到；
 *   - H5 场景下 description 是 <meta name="description">，Taro 没有对应的
 *     页面配置项，必须运行时改 DOM；
 *   - 分享出去的链接卡片读的是 og:title / og:description / og:image / twitter:card，
 *     这些 SPA 启动后改 DOM 是没用的（社交平台和聊天机器人的爬虫不会执行 JS，
 *     只会看初始 HTML）。所以完整的 og/twitter/canonical 在 src/index.html 里
 *     已经写好一份「通用兜底」，这里是按页面**运行时覆盖**（仅对
 *     真人访客浏览器内打开的标签页有意义；真要分享给爬虫抓，
 *     请改用 scripts/gen-seo-pages.mjs 生成的 /s/{code}/ 静态页）。
 *
 * 用法：usePageMeta('标题', '描述')。
 *  - title 为空时沿用 src/index.html 的初始 <title>（不覆盖）；
 *  - 仅 H5 生效（小程序没有 document），其他端静默跳过。
 */

import { useEffect } from "react";
import Taro from "@tarojs/taro";

/* ========================================================================== */
/*                                  常量配置                                    */
/* ========================================================================== */

/** 站点正式域名：与 scripts/gen-seo-pages.mjs 的 SITE 保持一致。 */
const SITE_ORIGIN = "https://www.jbs-ttj.store";
const SITE_NAME = "剧本杀复盘助手";
/** 兜底 OG 分享图：构建期由 scripts/gen-og-image.js 产出（1200×630），位于 dist/static/ */
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/static/og-image.png`;

/* ========================================================================== */
/*                                  工具函数                                    */
/* ========================================================================== */

/** H5 环境才有 document；小程序/SSR 等环境下直接跳过 meta 操作 */
function isH5(): boolean {
  return Taro.getEnv() === Taro.ENV_TYPE.WEB && typeof document !== "undefined";
}

/** 新建或更新一个 <meta> 标签的 content */
function setMetaContent(attr: "name" | "property", key: string, content: string): void {
  if (!content) return;
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/** 新建或更新一个 <link> 标签的 href */
function setLinkHref(rel: string, href: string): void {
  if (!href) return;
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * 把当前页面的 hash URL 还原成「对应静态内容站」的干净 URL，
 * 作为 canonical 写入：避免「同一内容多入口」造成重复内容降权。
 *
 * 映射规则：
 *   /#/pages/scriptDetail/index?code=xxx  →  /s/xxx/
 *   /#/pages/scripts/index                 →  /scripts/
 *   其他                                    →  /（首页）
 */
function buildCanonical(): string {
  const hash = (typeof location !== "undefined" ? location.hash : "").replace(/^#/, "");
  if (!hash) return `${SITE_ORIGIN}/`;
  const queryIdx = hash.indexOf("?");
  const path = queryIdx === -1 ? hash : hash.slice(0, queryIdx);
  const query = queryIdx === -1 ? "" : hash.slice(queryIdx + 1);
  const params = new URLSearchParams(query);

  if (path === "/pages/scriptDetail/index" && params.get("code")) {
    return `${SITE_ORIGIN}/s/${encodeURIComponent(params.get("code") || "")}/`;
  }
  if (path === "/pages/scripts/index") return `${SITE_ORIGIN}/scripts/`;
  if (path === "/pages/index/index") return `${SITE_ORIGIN}/`;
  return `${SITE_ORIGIN}/`;
}

/* ========================================================================== */
/*                                  Hook 主体                                   */
/* ========================================================================== */

export interface PageMetaOptions {
  /** 覆盖默认 OG 分享图（绝对 URL 或站点相对路径均可） */
  ogImage?: string;
}

export function usePageMeta(title?: string, description?: string, options: PageMetaOptions = {}): void {
  useEffect(() => {
    if (!isH5()) return;

    if (title) {
      Taro.setNavigationBarTitle({ title }).catch(() => {});
      setMetaContent("property", "og:title", title);
      setMetaContent("name", "twitter:title", title);
    }
    if (description) {
      setMetaContent("name", "description", description);
      setMetaContent("property", "og:description", description);
      setMetaContent("name", "twitter:description", description);
    }

    /* 基础 og / twitter（每次都设置，幂等）：分享卡片必须的信息 */
    setMetaContent("property", "og:site_name", SITE_NAME);
    setMetaContent("property", "og:type", "website");
    setMetaContent("property", "og:locale", "zh_CN");
    setMetaContent("property", "og:url", buildCanonical());
    setMetaContent("name", "twitter:card", "summary_large_image");
    const ogImage = options.ogImage
      ? options.ogImage.startsWith("http")
        ? options.ogImage
        : `${SITE_ORIGIN}${options.ogImage}`
      : DEFAULT_OG_IMAGE;
    setMetaContent("property", "og:image", ogImage);
    setMetaContent("name", "twitter:image", ogImage);

    /* canonical：让搜索引擎把链接权重集中到内容站静态页（避免 SPA 多入口分权） */
    setLinkHref("canonical", buildCanonical());
  }, [title, description, options.ogImage]);
}
