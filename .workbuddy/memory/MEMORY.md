# jbsttj-frontend 长期笔记

Taro 4.2.1 + React 18，同时构建 H5（Vercel www.jbs-ttj.store）与微信小程序；后端 jbsttj-backend（FastAPI + Supabase + OSS + Celery），剧本杀 DM 手册 RAG。

## 设计体系（2026-09-09 全站改版，改色只看这节）

- 三色 `@ink #181818` / `@paper #FFF` / `@accent #FFD342`，唯一额外语义色 `@danger #C0392B`。禁第四色相、禁同色渐变。
- 唯一色源 `src/styles/tokens.less`（less 编译期替换，小程序拿不到 CSS 变量）+ `tokens.ts`（tsx 内联）。每个 .less 顶部按深度 `@import` tokens。
- 主 CTA：黄底+墨字+8px 圆角+无彩色投影；次级白底细描边；禁用灰底灰字。间距 `@sp-1~12`（4 倍数），禁 5/7/9/15。卡片距 12、内边距 16、菜单行高 56、按钮 48/36。
- 图标统一 `AppIcon`（`<AppIcon name tone size>`），源 `scripts/icon-src/*.svg`，`gen-icons.mjs`（依赖 sharp）光栅化多色 PNG（96×96）+ tabBar PNG（81×81）+ 生成 icons.ts。**PNG 而非 SVG**：小程序只认 `<image>`，PNG<4KB 被 Vite 内联 base64 进 common.js。色调 ink/mute/white/yellow/danger，不用 emoji。
- 页面底 `@canvas #F7F7F7`，卡片白底+`@line` 细描边。改色校验：`grep -rio "5b7cfa\|8b5cf6\|9aa0ae" dist --include='*.css' --include='*.wxss'` 必须空。

## 小程序端 UI 红线（nutui 已移除）

- nutui 组件内部渲染原生 HTML 标签，小程序端静默变空节点：`dist/base.wxml` 的 `tmpl_${depth}_${nn}` 模板缺失时 `<template is="">` 不报错。
- 替代：`AppButton`（View+Text，可选 icon）、`AppSearchBar`。按下态同时写 hoverClass（小程序）+ `:active`（H5）。
- 排查：`grep -rohE 'createElement\("(div|span|button|i|p|ul|li|img)"' dist/ --include='*.js'`；`grep -c 'name="tmpl_0_14"' dist/base.wxml`=0 实锤。允许残留原生标签（有 `typeof document==='undefined'` 守卫）：canvas/img、link/meta。

## 路由 & 构建约定

- 页面必须注册 `src/app.config.ts` 的 pages；删页面清跳转引用（正则扫不到常量 `HOME_PAGE`）。
- tabBar 图标墨底 #181818 + 选中黄 #FFD342 + 未选中灰 #B5B5B5，本地 PNG。
- ⚠️ weapp/h5 共用 dist/，**weapp 必须最后构建**。构建：`APPDATA="C:/Users/Administrator/AppData/Roaming" NODE_OPTIONS= npm run build:h5|build:weapp`。别 `grep -c` 接 `&&`（0 匹配退出码 1）。

## 导航结构

- 搜索首页 pages/index 已删（git checkout 可还原），搜索框并入「剧本」tab。tabBar：剧本/我的。「我的」含账号卡、导入 DM 手册（仅 Word，PDF 需 OCR 不支持）等。收益=解析费抽 20%。

## 环境变量 / 部署

- `API_ORIGIN = TARO_APP_API_ORIGIN || https://jbsttj-backend-production.up.railway.app`。
- Taro 4.x Vite `TARO_APP_*` 只从 .env 注入；`config/index.ts` loadEnvFile() 手动解析，优先级 shell(CI)>.env>默认，defineConstants 无条件注入（小程序无 process）。
- vercel.json：framework=null，build=`npm run build:h5`，output=dist，SPA catch-all。⚠️ config/index.ts、package.json、package-lock.json 有 2026-08-26 未提交改动，提交前确认。

## SEO / GEO 静态内容站

- 构建期 `gen-seo-pages.mjs` 生成 dist/scripts/index.html、dist/s/{code}/、robots/sitemap/llms/feed，向 dist/index.html 注入 meta/JSON-LD/noscript。SITE_ORIGIN=https://www.jbs-ttj.store。
- 首页注入锚点 `<!-- SEO:HOOK -->`，注入内容 `<!-- SEO:BEGIN/END -->` 包裹，靠标记精确清除。连跑 gen:seo，`grep -c 'application/ld+json' dist/index.html` 恒为 3。
- ⚠️ 清除逻辑禁范围通杀（2026-09-05 白屏：HOOK 清到 </head> 把 Taro 的 script/CSS 一起清了）。改 enhanceSpaIndex() 必验 `grep -o '<script[^>]*src=' dist/index.html`。
- `npm run seo:verify`（22 项，接 build:h5 末尾）判注入项+宿主文件完整性。死链红线：仅生成了内容页的剧本链 /s/{code}/，其余链 /#/pages/scriptDetail/index?code=xxx。
- lastmod 稳定：内容指纹 sha256 前16位 + 缓存 .seo-lastmod-cache.json。MAX_QA_PER_SCRIPT=200，totalQa 才是总量。详情页 URL 只有 code 参数（title 参数 2026-09-09 已移除）。

## 沙箱 Bash 坑

- APPDATA 为空→npm-conf 崩（伪装「找不到 config/index」），显式给 APPDATA。NODE_OPTIONS= 绕删除 shim。Edit 工具会「假成功」，改完必 grep 复核。只跑 SEO：`npm run gen:seo`。

## 搜索引擎收录

- 百度仅网址前缀，未备案 .store 配额 0。Bing Webmaster 用 Google 账号登录。
- IndexNow 主力 `seo:submit`/`seo:submit:all`，必须双端点（www.bing.com/indexnow 才被统计）。BWT 无「绑定 key」动作，所有权靠根目录 key 文件+推送带 key。别在 BWT 点 Generate 换 key。
- https 尚未就绪（2026-09-08），sitemap 全写 https→死链，用户决定暂停推送等 https。submit-indexnow.mjs 已加协议守卫，--force 覆盖。

## DM 手册上传

- filePicker→PickedFile{name,size,file?,path?}：file=H5（分片预签名直传，500MB）；只有 path=小程序（simple-upload POST /files/simple-upload 中转，20MB）。
- 小程序后台加后端域名到 uploadFile 合法域名；chooseMessageFile 后缀校验不能省。后端 upload_type permanent/temporary，小程序传 temporary，秒传查重按 prefix 隔离。

## 业务模块速查

- 详情页 content-tabs（问答/故事还原），?tab=story 深链。故事还原 /dm-guide/stories，hasSynthesis 要求 overview 至少一节非空（空 overview 会标 ready）。
- H5 划线评论 document.selectionchange，offset 按码点，prefix/suffix ≤32 字符。小程序只读。
- 页面元信息 usePageMeta。QuestionPanel /dm-guide/questions 需登录，未登录不发请求（防 401 死循环）。
- 用户资料 /auth/me（PATCH If-Match 乐观并发 409 stale_profile）、/change-password、/change-email、头像 /auth/me/avatar 中转（key avatars/{uid}/{date}/{uuid}.ext）。
- 轮询 usePolling({active,visible,interval,task})，visible 由 useDidShow/Hide 驱动。

## 依赖与自动化

- 54 漏洞（7 critical/24 high）几乎全在 @tarojs/* 链，唯一修复路径是降 Taro 3.6.x → 绝不能 npm audit fix --force。audit 需 --registry=https://registry.npmjs.org。
- 过期依赖只有 less/postcss/terser 可安全升，react19/ts7/vite8/eslint10 别动。报告 docs/dependency-audit.md。
- 部署 .github/workflows/deploy-h5.yml（push main→GitHub Actions npm ci+build+scp），本地 dist 不参与。自动化：周一 03:00 依赖审计；每天 02:00 SEO 巡检+https 探测；IndexNow 已暂停。
