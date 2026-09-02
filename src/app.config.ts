export default defineAppConfig({
  pages: [
    "pages/scripts/index",
    "pages/profile/index",
    "pages/profile/edit/index",
    "pages/profile/security/index",
    "pages/scriptDetail/index",
    "pages/login/index",
    "pages/myScripts/index",
    "pages/scriptRequests/index",
  ],
  // 底部主菜单只有两项：剧本 · 我的。
  //
  // 独立的搜索首页 `pages/index` 已废弃：搜索框合并进了「剧本」tab 顶部
  // （在已解析剧本范围内检索，无结果时给「请求剧本解析」CTA）。
  // 该页已从 pages 移除，**不要再往 `/pages/index/index` 跳转**——
  // 未注册的页面 navigateTo 只改 URL 不渲染、switchTab/reLaunch 直接报错。
  // src/pages/index/ 目录目前是死代码，待确认后删除。
  //
  // 导入 DM 手册在「我的」页面；「我的剧本」不再独占 tab，收纳到「我的」页入口下。
  // tabBar 图标为本地 PNG（81x81，<40KB），存放在 src/assets/tabbar/。
  // 如需换成 iconfont.cn 的图标：下载对应图标的 81x81 PNG（或 SVG 转 PNG），
  // 覆盖 src/assets/tabbar/ 下同名文件（灰=未选中，-active=选中色 #5b7cfa）即可，无需改代码。
  tabBar: {
    position: "bottom",
    color: "#9aa0ae",
    selectedColor: "#5b7cfa",
    backgroundColor: "#ffffff",
    borderStyle: "white",
    list: [
      {
        pagePath: "pages/scripts/index",
        text: "剧本",
        iconPath: "assets/tabbar/tab-scripts.png",
        selectedIconPath: "assets/tabbar/tab-scripts-active.png",
      },
      {
        pagePath: "pages/profile/index",
        text: "我的",
        iconPath: "assets/tabbar/tab-profile.png",
        selectedIconPath: "assets/tabbar/tab-profile-active.png",
      },
    ],
  },
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#fff",
    navigationBarTitleText: "剧本杀复盘助手",
    navigationBarTextStyle: "black",
  },
});
