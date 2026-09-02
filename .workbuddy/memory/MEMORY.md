# 项目长期笔记（jbsttj-frontend）

## 一、小程序端 UI 红线（2026-09-02，最重要）

**nutui 已彻底移除**（依赖 + 构建配置全清）。原因：内部渲染原生 HTML 标签的组件在小程序端一律变空节点。

- 根因：Taro 小程序靠 `dist/base.wxml` 的 `tmpl_${depth}_${nn}` 模板渲染，`nn` 是组件数字别名（button=14，view 系 =0/1/3/6/8，text=7，input=33，textarea=79，canvas=16）。**模板不存在 → `<template is="">` 静默失败 → 整棵子树为空，不报错、不降级。**
- nutui `Button` 直接 `createElement("button")` + `createElement("div")` → `tmpl_0_14` / `tmpl_0_div` 都不存在。icons 全系渲染 `<i>`（非小程序组件）+ CSS `mask`+base64 SVG（wxss 不支持，`<image>` 也不支持 SVG）。
- `@tarojs/plugin-html` 救不了：映射与模板登记是**编译期**，触发点硬编码只扫 `/\.[jt]sx/` 的**项目源码**，node_modules 的 `.js` 不参与；runtime 只改属性/事件，不改写 nodeName。
- **替代方案（后续新增 UI 照抄，别再引 nutui）**：
  - `src/components/AppButton`（View+Text，props `block/type/size/fill/disabled/onClick`）
  - `src/components/AppSearchBar`（View+Input+Text，图标用文本字符 🔍 ✕）
  - 按下态：小程序 `hoverClass`（view 模板自带该属性）+ H5 `:active`，**两个都写**
  - `placeholderClass` 必须是**全局类名**；样式用平铺选择器，少用深层 `&` 嵌套
- 排查手法：① `grep -c "class名" dist/pages/x/index.js`（只证明进包，不证明能渲染）② `grep -rohE '(jsx|jsxs|createElement)\("(div|span|button|a|i|p|ul|li|img|input)"' dist/ --include='*.js'` ③ `grep -c 'name="tmpl_0_14"' dist/base.wxml` =0 即实锤。⚠️ 直接 grep `"button"` 会误报 `dist/taro.js` 里 Taro 自己的组件表。
- 允许残留的原生标签（均有 `typeof document === 'undefined'` 守卫）：`canvas`/`img`（AvatarEditor 离屏裁剪，小程序端降级提示）、`link`/`meta`（H5 专属 `app.ts` + `usePageMeta`）。
- 深度知识：`dist/utils.wxs::xs.a(l,n,s)` 中只有容器型编号才递增深度；input/textarea/image 等非容器**恒取 `tmpl_0_${nn}`**，嵌多深都不掉模板。

## 二、Taro 路由 & 构建约定

- 可导航页面必须在 `src/app.config.ts` 的 `pages` 注册，否则 `navigateTo` 只改 URL 不渲染、`switchTab`/`reLaunch` 报错。**删页面必须同步清所有跳转引用**；扫描正则 `Taro.(navigateTo|redirectTo|switchTab|reLaunch)({ url: '...' })`，⚠️ 扫不到常量形式（如 `reLaunch({ url: HOME_PAGE })`）。
- 改 `app.config.ts`（pages/tabBar）后必须重启 `dev:h5`，不热更新路由表。
- tabBar 图标必须是本地 PNG（81x81，<40KB，`src/assets/tabbar/tab-{scripts|profile}[-active].png`）；⚠️ 微信小程序不支持 SVG 图标。生成脚本 `scripts/gen-tabbar-icons.py`。
- **本地构建坑**：沙箱 `NODE_OPTIONS` 的删除 shim 会拦截 Taro 清空 dist（"Some operations were aborted"）→ 用 `NODE_OPTIONS= npm run build:weapp|build:h5`。
- ⚠️ weapp 与 h5 共用同一个 `dist/`，后建覆盖先建；开发者工具打开的就是 `dist/`，**weapp 必须最后跑**。
- ⚠️ 别用 `grep -c` 结果接 `&&`（0 匹配时退出码 1 会短路）。

## 三、导航结构（tabBar：剧本 · 我的）

- 独立搜索首页 `pages/index` 已删除（2026-09-02，`git checkout -- src/pages/index` 可还原）。搜索框合并进「剧本」tab 顶部，无结果给「请求解析」CTA。
- 「我的」页（`pages/profile`）：账号卡、导入 DM 手册、我的剧本、求解析、编辑资料、账号与安全、关于、退出。导入说明：仅支持 Word；PDF 需 OCR 成本高不支持（建议 Edge 打印拆分 + 夸克网盘转 Word）；收益 = 剧本解析费抽 20%，余下分给导入者与知识库共建者。
- 已删除死代码：`src/pages/index/`、`src/pages/webview/`。

## 四、后端地址 / 环境变量 / 部署

- `API_ORIGIN = process.env.TARO_APP_API_ORIGIN || 默认 https://jbsttj-backend-production.up.railway.app`（`src/constants/api.ts`）。
- Taro 4.x Vite 模式 `TARO_APP_*` 只从 `.env` 文件注入（不读 shell env）→ `config/index.ts` 的 `loadEnvFile()` 手动解析，优先级 **shell(CI) > .env > 代码默认值**，在 `defineConstants` 里**无条件**注入 `TARO_APP_API_ORIGIN` 与 `TARO_APP_ARMS_ENV`。
- ⚠️ 无条件注入的原因：小程序运行时无 `process` 全局对象，未定义会让 `process.env.*` 原样进产物并抛 `ReferenceError`（H5 无此问题）。
- `vercel.json`：framework=null，build=`npm run build:h5`，output=`dist`，SPA catch-all，`/js/ /css/` 一年强缓存；`.vercelignore` 排除 node_modules/dist/.git/.workbuddy/docs。
- ⚠️ `config/index.ts`、`package.json`、`package-lock.json` 长期有 2026-08-26 环境变量重构的未提交改动，**提交前先确认是不是自己的改动**。

## 五、SEO / GEO 静态内容站

- H5 是 Taro SPA + hash 路由，首屏空壳，靠 **`scripts/gen-seo-pages.mjs`（构建期）** 生成：`dist/scripts/index.html`、`dist/s/{code}/index.html`、`robots.txt`、`sitemap.xml`、`llms.txt`、`feed.xml`，并向 `dist/index.html` 注入 meta/JSON-LD/noscript（幂等：识别 `data-seo-injected="1"` + `<!-- SEO:BEGIN/END -->`）。
- 数据源（后端公开接口）：`GET /scripts`、`/scripts/{code}/dm-guide/qa-titles`、`/dm-guide/stories?code=`。
- `build:h5` 链路：gen-favicon → gen-og-image → taro build → copy-favicon → gen-seo-pages。域名常量 `SITE_ORIGIN` = https://www.jbs-ttj.store。
- **死链红线**：只有生成了内容页的剧本才能链 `/s/{code}/`，其余必须链 SPA 路由 `/#/pages/scriptDetail/index?code=xxx`。
- Taro 不拷贝 `src/static/` → OG 图由脚本兜底拷到 `dist/static/og-image.png`。新剧本需重新部署才进 sitemap。

## 六、搜索引擎收录

- 百度：只支持「网址前缀」；验证标签在 `src/index.html`（`baidu-site-verification` = `codeva-pvLdncvohy`）。⚠️ 未备案（.store）配额为 0，只能等自然抓取。
- Bing Webmaster 可从 Google Search Console 导入。⚠️ 微软账号登录会报 "Sorry, an error occurred..."（微软侧长期 bug），**改用 Google 账号登录**。
- IndexNow 是主力：`npm run seo:submit`。⚠️ **必须双端点都推** —— 只有 `www.bing.com/indexnow` 才被 Insights 统计，`api.indexnow.org` 只分发不计数。提交前确认 `https://www.jbs-ttj.store/{key}.txt` 返回纯文本（未就绪时 Vercel catch-all 返回 HTML → 403）。

## 七、DM 手册上传：H5 分片直传 / 小程序整文件中转

- `src/utils/filePicker.ts` 出 `PickedFile { name, size, file?, path? }`：`file` 存在 = H5，只有 `path` = 小程序；`pickChannel()` / `maxSizeOf()` 分派。
- H5 `direct`：`multipartUploadToOss`（分片 + 预签名 PUT 直传，秒传/断点续传，上限 500MB）。
- 小程序 `relayed`：`src/utils/simpleUpload.ts`，`Taro.uploadFile` → `POST /files/simple-upload`（后端中转写 OSS），有进度 + 可 abort，上限 20MB。不走分片的原因：无 XHR 拿不到 ETag、直传需配 OSS 域名、代理分片要传 ArrayBuffer 且无进度。
- ⚠️ 小程序后台必须把后端域名加进 **uploadFile 合法域名**（不只是 request）；⚠️ `Taro.chooseMessageFile` 只能从微信聊天记录选文件（推荐「文件传输助手」），`extension` 过滤需基础库 2.6.0+，所以 `validateDmGuideFile` 后缀校验不能省。
- 后端 Form 参数 `upload_type`（`permanent` / `temporary`），小程序传 `temporary` 落 `temp/` 前缀（OSS 7 天清理）；秒传查重按 `prefix` 隔离。两链路 `UploadResult` 结构一致。

## 八、业务模块速查

- **剧本详情页**：头部 + `content-tabs`（💬 问答 / 📖 故事还原）；问答链路全 `activeTab==='qa'` 守卫；布局 `height:100vh` 弹性列 + 内容区 `flex:1;min-height:0`。
- **故事还原**：走 `/dm-guide/stories`（公开，camelCase）；`StoryPanel` 承载筛选 chips、卡片流、全屏 overlay，正文容器 id=`story-content-dom`。
- **H5 划线评论**：`document.selectionchange` 捕获选区；offset 用 `Array.from` 按码点；prefix/suffix 各 ≤32 字符指纹。小程序端只读。共读时间线 = `GET /stories/{id}` + `GET /highlights?mine=true&storyId=` 去重倒序，自己的可 PATCH/DELETE。
- **页面元信息**：统一走 `src/hooks/usePageMeta.ts`。问答冷启动引导 `fetchGuideQuestions(code)`（静默失败回退硬编码）。QuestionPanel 的 `/dm-guide/questions` 需登录，**未登录必须不发请求**（否则 401→refresh 失败→死循环），`loadFirst` 与 effect 都要 `isAuthenticated` 守卫。
- **用户资料**：后端 `app/api/v1/auth.py` 有 `GET/PATCH /auth/me`（PATCH 支持 `If-Match: <updated_at>` 乐观并发，冲突 409 `stale_profile`）、`POST /auth/change-password`、`POST /auth/change-email`。`profiles` 扩展列 `avatar_color/gender/birthday/region/avatar_object_key`。头像：后端中转 `POST /auth/me/avatar`（multipart 字段 `file`）→ OSS，key = `avatars/{user_id}/{date}/{uuid}.ext`。
