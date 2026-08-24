/**
 * 原生 tabBar 选中图标「每次切入都重播 SMIL 描边动画」。
 *
 * 背景：Taro H5 原生 tabBar 用 <img> 渲染图标，选中态切换只是复用同一 img 元素改 src。
 * 浏览器对已加载过的 SVG 会走缓存，同一 URL 不会重跑 SMIL，因此切回同一 tab 时动画不重播。
 *
 * 做法：给当前选中项（.weui-bar__item_on）的图标 URL 追加 ?t= 时间戳，
 * 使浏览器把它当作一个「新资源」重新请求 -> 重新解析 SVG -> 重新触发
 * stroke-dasharray / stroke-dashoffset 的描边出现动画。
 *
 * 关键实现点：
 *  - 图标的 <img> 元素自身带 class `weui-tabbar__icon`，并非包在容器里，
 *    所以选择器要用 `.weui-bar__item_on img`（或 `.weui-tabbar__item.weui-bar__item_on img`）。
 *  - 必须用官方 API `Taro.setTabBarItem` 改写 `selectedIconPath`，让它进入 tabBar 组件
 *    state；重渲染时 img 的 src 绑定到该 state，动画才会稳定重播。
 *    直接改 img.src 会被组件下次重渲染覆盖（src 绑定到 state），存在竞态、不可靠。
 *  - <img> 内嵌的 SVG 无法用 JS 调 beginElement()，只能靠「重新加载」重播，
 *    所以 SVG 里 begin 必须保留自动触发（begin="0s"），不能改成 indefinite。
 *  - 非 H5（小程序原生 tabBar 无 document）直接跳过。
 */
import Taro from "@tarojs/taro";

export function replayActiveTabIcon(): void {
  if (typeof document === "undefined") return; // 仅 H5 生效

  const apply = () => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(".weui-tabbar__item")
    );
    const selectedIdx = items.findIndex((el) =>
      el.classList.contains("weui-bar__item_on")
    );
    if (selectedIdx < 0) return;

    const img = items[selectedIdx].querySelector<HTMLImageElement>("img");
    if (!img) return;

    // 取当前真实渲染的 URL，去掉上一次追加的 ?t=，得到干净 base
    const base = img.src.split("?")[0];
    const next = `${base}?t=${Date.now()}`;
    if (img.src === next) return;

    // 走官方 API 改写 selectedIconPath（进入组件 state，重渲染后 img.src = next）
    Taro.setTabBarItem({ index: selectedIdx, selectedIconPath: next });
  };

  // 双 rAF：等原生 tabBar 把选中态（.weui-bar__item_on）渲染到 DOM 后再操作，
  // 确保命中的是「刚切到的这个 tab」的图标。
  window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
}
