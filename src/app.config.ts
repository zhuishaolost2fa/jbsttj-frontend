export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/scripts/index',
    'pages/profile/index',
    'pages/profile/edit/index',
    'pages/profile/security/index',
    'pages/scriptDetail/index',
    'pages/login/index',
    'pages/myScripts/index'
  ],
  // 底部主菜单：导入 · 剧本库（全量浏览+筛选） · 我的。
  // 「我的剧本」不再独占 tab，收纳到「我的」页面入口下，通过 navigateTo 进入。
  // 刻意不配 iconPath —— 小程序端图标是可选的，纯文字 tab 省掉一套图片资源，
  // 也避免 H5 与小程序两端图标路径解析差异带来的空白图标问题。
  tabBar: {
    position: 'bottom',
    color: '#9aa0ae',
    selectedColor: '#5b7cfa',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      { pagePath: 'pages/index/index', text: '导入' },
      { pagePath: 'pages/scripts/index', text: '剧本' },
      { pagePath: 'pages/profile/index', text: '我的' }
    ]
  },
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fff',
    navigationBarTitleText: '剧本杀复盘助手',
    navigationBarTextStyle: 'black'
  }
})
