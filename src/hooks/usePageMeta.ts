/**
 * 页面级 SEO 元信息：为每个页面设置浏览器标题与 description。
 *
 * 为什么不用页面 config（navigationBarTitleText）一劳永逸？
 *   - config 只覆盖**静态**标题，剧本详情这类标题取决于路由参数的页面做不到；
 *   - H5 场景下 description 是 <meta name="description">，Taro 没有对应的
 *     页面配置项，必须运行时改 DOM；
 *   - 分享出去的链接卡片读的是 og:title / og:description，也需要同步更新。
 *
 * 用法：页面组件顶部 `usePageMeta('剧本库 · 剧本杀复盘助手', '浏览已完成解析的剧本…')`。
 * title 为空时沿用 app.config.ts 的 window.navigationBarTitleText（不覆盖）。
 * 仅 H5 生效（小程序没有 document），其他端静默跳过。
 */

import { useEffect } from "react";
import Taro from "@tarojs/taro";

/** H5 环境才有 document；小程序/SSR 等环境下直接跳过 meta 操作 */
function isH5(): boolean {
  return Taro.getEnv() === Taro.ENV_TYPE.WEB && typeof document !== "undefined";
}

/** 新建或更新一个 <meta> 标签的 content */
function setMetaContent(attr: "name" | "property", key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function usePageMeta(title?: string, description?: string): void {
  useEffect(() => {
    if (!isH5()) return;

    if (title) {
      // H5 下即 document.title；失败（如页面尚未挂载）静默忽略
      Taro.setNavigationBarTitle({ title }).catch(() => {});
      setMetaContent("property", "og:title", title);
    }
    if (description) {
      setMetaContent("name", "description", description);
      setMetaContent("property", "og:description", description);
    }
  }, [title, description]);
}
