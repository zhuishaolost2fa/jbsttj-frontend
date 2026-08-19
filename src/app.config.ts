export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/scripts/index',
    'pages/profile/index',
    'pages/profile/edit/index',
    'pages/profile/security/index',
    'pages/scriptDetail/index',
    'pages/login/index'
  ],
  // 底部主菜单：导入只是其中一个模块，剧本管理与个人中心各占一个入口。
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
      { pagePath: 'pages/scripts/index', text: '我的剧本' },
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
