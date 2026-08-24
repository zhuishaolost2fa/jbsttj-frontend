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
  // 底部主菜单：首页（搜索剧本） · 剧本库（只展示已解析完成的剧本） · 我的。
  // 导入 DM 手册已从首页迁入「我的」页面，首页只保留搜索入口。
  // 「我的剧本」不再独占 tab，收纳到「我的」页面入口下，通过 navigateTo 进入。
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
        iconPath: "assets/tabbar/tab-scripts.svg",
        selectedIconPath: "assets/tabbar/tab-scripts-active.svg",
      },
      {
        pagePath: "pages/profile/index",
        text: "我的",
        iconPath: "assets/tabbar/tab-profile.svg",
        selectedIconPath: "assets/tabbar/tab-profile-active.svg",
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
