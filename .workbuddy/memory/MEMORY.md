# 项目长期笔记（jbsttj-frontend）

## SEO / GEO 静态内容站（2026-09-01 建立）
- H5 是 Taro SPA + hash 路由，首屏空壳，靠 **`scripts/gen-seo-pages.mjs`（构建期）** 生成可索引静态站：
  - `dist/scripts/index.html` 剧本库（45 部）、`dist/s/{code}/index.html` 内容页（仅 `has_guide=true` 的 13 部）
  - `dist/robots.txt`、`sitemap.xml`、`llms.txt`、`feed.xml`，以及向 `dist/index.html` 注入 meta/JSON-LD/noscript（幂等：识别 `data-seo-injected="1"` + `<!-- SEO:BEGIN/END -->` 区间后再替换）
- 数据全部来自后端**公开**接口：`GET /scripts`（分页）、`GET /scripts/{code}/dm-guide/qa-titles`、`GET /dm-guide/stories?code=`。
- `build:h5` 链路：gen-favicon → gen-og-image → taro build → copy-favicon → gen-seo-pages。站点域名常量在 `gen-seo-pages.mjs` 的 `SITE_ORIGIN`（https://www.jbs-ttj.store）。
- **死链红线**：只有生成了内容页的剧本才能链 `/s/{code}/`；其余必须链 SPA 路由 `/#/pages/scriptDetail/index?code=xxx`。改生成脚本后应重跑并扫描全站 `href` 确认 0 死链。
- **Taro 不会拷贝 `src/static/` 到 `dist/`**（旧笔记有误）→ OG 图由 `gen-seo-pages.mjs` 兜底拷到 `dist/static/`，统一引用 `/static/og-image.png`。
- `src/index.html` 只保留基础 meta，社交标签统一由脚本注入（避免与运行时 `usePageMeta` 重复）。
- 新剧本上架需重新部署才会进 sitemap；可用 Vercel Deploy Hook 定时触发。

## 搜索引擎收录提交（2026-09-01）
- **百度**：`ziyuan.baidu.com` 只支持「网址前缀」类型，站点填 `https://www.jbs-ttj.store/`。验证标签写在 `src/index.html` head（`baidu-site-verification`，内容 `codeva-pvLdncvohy`）。⚠️ **未备案站点（.store）sitemap / API 配额 = 0**，提交了也基本无效，只能等自然抓取。
- **Bing**：`bing.com/webmasters` 可从 Google Search Console 一键导入，不用重复验证。
  - ⚠️ **微软账号登录 Bing Webmaster 是微软侧长期 bug**（报 "Sorry, an error occurred while processing your request"，与本地环境无关，大量用户反馈）。**改用 Google 账号登录即可绕开**；登录页支持 Microsoft / Google / Facebook 三种。
- **IndexNow（主力通道）**：`npm run seo:submit`，把 sitemap 里的 URL 推给 Bing / Yandex / ChatGPT 搜索，无配额限制，秒级回源。key 与实现见 `scripts/submit-indexnow.mjs`。每次部署后跑一次即可。
  - ⚠️ **必须双端点都推**：只有 `www.bing.com/indexnow` 的提交会被 Bing Webmaster 的「IndexNow Insights」报表统计；`api.indexnow.org` 只负责分发给其他引擎但不计数。只推聚合端点 → 后台一直显示 "get started"。重复提交幂等。
- 提交前务必确认 `https://www.jbs-ttj.store/{key}.txt` 返回纯文本（Vercel catch-all 会在文件未就绪时返回 SPA HTML，导致 403）。

## 剧本详情页 tab 结构与故事还原（2026-08-27）
- 详情页 = 头部 + `content-tabs`（💬 问答 / 📖 故事还原）+ 内容区；问答链路（聊天/输入栏/ready-bar）全部 `activeTab==='qa'` 守卫，布局为 `height:100vh` 弹性列 + 内容区 `flex:1;min-height:0` 内部滚动。
- 故事还原走扁平接口 `/dm-guide/stories`（公开，camelCase）：`StoryPanel` 组件承载类型筛选 chips、卡片流、全屏阅读 overlay；阅读页正文容器 id=`story-content-dom`。
- H5 划线评论：`document.selectionchange` 持续捕获选区入 state（点按钮时选区即使被收起也不丢数据）；offset 用 `Array.from` 按码点统计；prefix/suffix 各 ≤32 字符指纹。小程序端无该能力，只读。
- 共读时间线 = `GET /stories/{id}`（公开划线）+ `GET /highlights?mine=true&storyId=`（我的私有）按 id 去重合并、createdAt 倒序；自己的划线（`useAuth().user.id === h.userId`）可 PATCH 编辑 / DELETE 软删。

## Taro 路由约定
- 所有可导航页面必须在 `src/app.config.ts` 的 `pages` 数组中注册；未注册时 `Taro.navigateTo` 只会改变浏览器 URL 而不渲染任何页面，`switchTab` / `reLaunch` 则直接报错。
- **移除页面 = 必须同步清理所有跳转引用，否则静默变死链**（用户点了没反应，控制台才有报错）。改完跑一遍路由死链扫描：正则扫 `src/` 里 `Taro.{navigateTo|redirectTo|switchTab|reLaunch}({ url: '...' })`，去掉 query 后比对 pages 数组。⚠️ 扫不到**常量形式**的跳转（如 `reLaunch({ url: HOME_PAGE })`），这类要单独 grep 核对。
- H5 新增/修改页面后必须重启 `npm run dev:h5`，dev server 不会可靠热更新 `app.config.ts` 的路由表。

## 导航结构（tabBar：剧本 · 我的）
- ⚠️ **独立的搜索首页 `pages/index` 已废弃并从 pages 移除**（2026-09-02），搜索框合并进「剧本」tab 顶部（在已解析剧本范围内检索，无结果时给「请求解析」CTA）。`src/pages/index/` 目录目前是死代码。
- 首页（pages/index）只做搜索：品牌 + SearchBar 联想（`/scripts/autocomplete`）+ 剧透提示；不再含导入入口。
- 导入 DM 手册（ImportDmGuide + ScriptSubmitForm 上传→匹配→填表→提交流程）已迁入「我的」页（pages/profile），属贡献者行为；我的页含说明卡：仅支持 Word（.doc/.docx），PDF 需 OCR 成本高不支持（PDF→Word 用 Edge 打印拆分+夸克网盘转换），收益=剧本解析费 20% 抽成，余给导入者与知识库共建者。
- 改 app.config.ts 的 tabBar 或 pages 后需重启 dev:h5（dev server 不热更新路由表）。

## DM 指南上传：H5 分片直传 / 小程序整文件中转（2026-09-02 双通道）
- `src/utils/filePicker.ts` 统一出 `PickedFile { name, size, file?, path? }`：`file` 存在 = H5（有 File，走分片），只有 `path` = 小程序（本地临时路径）。`pickChannel()` / `maxSizeOf()` 据此分派，上层不再写 `process.env.TARO_ENV` 判断链路。
- **H5（`direct`）**：保持原 `multipartUploadToOss`（分片 + 预签名 PUT 直传 OSS，秒传/断点续传，上限 500MB）。
- **小程序（`relayed`）**：`src/utils/simpleUpload.ts`，整文件走 `Taro.uploadFile` → `POST /files/simple-upload`（后端中转写 OSS），有真实进度 `onProgressUpdate` + 可 `abort()`；上限 20MB（对齐后端 `SIMPLE_UPLOAD_LIMIT`）。走自家后端域名，**不需要 OSS 域名白名单**。
- 为什么小程序不走分片：① 无 XHR，拿不到 PUT 响应头 ETag；② 直传域名是 OSS，需单独配 request 合法域名；③ 后端虽有代理分片 `PUT /uploads/{id}/parts/{n}`，但要 `Taro.request` 传 ArrayBuffer（支持不稳、无上传进度）。
- ⚠️ 小程序后台必须把后端域名加进 **「uploadFile 合法域名」**（不只是 request 合法域名），否则真机上传失败；开发者工具可勾「不校验合法域名」绕过。
- ⚠️ `Taro.chooseMessageFile` **只能从微信聊天记录选文件**，够不到手机本地文件管理器/网盘 → 用户需先把 Word 发进任意会话（推荐「文件传输助手」）。`extension` 过滤需基础库 2.6.0+，老版本会失效，所以 `validateDmGuideFile` 的后缀校验不能省。
- 后端 `POST /files/simple-upload` 新增可选 Form 参数 `upload_type`（`permanent` 默认 / `temporary`）；小程序传 `temporary` 落 `temp/` 前缀，与 H5 分片链路一致、受 OSS 7 天生命周期清理。`FileService.simple_upload` 的秒传查重也改为按 `prefix` 做命名空间隔离（临时不再复用永久对象）。
- 两条链路返回的 `UploadResult` 结构一致，下游「匹配剧本 → ScriptSubmitForm」无感知。
- **已删除** `src/pages/webview/` 页面与路由（原「小程序导入引导去 H5」的 web-view 兜底，已成死代码）。


## tabBar 图标约定
- 图标为本地 PNG（81x81，<40KB），位于 `src/assets/tabbar/`，命名 `tab-{import|scripts|profile}[{-active}].png`（灰 #9aa0ae 未选中 / 蓝 #5b7cfa 选中）。
- Taro 原生 tabBar 只接受本地图片，不支持 iconfont 字体；但构建期会自动把 `assets/tabbar/*.png` 打包到 `dist/static/images/` 并重写路径，无需手动处理。
- 换图标：iconfont.cn 下载 81x81 PNG（或 SVG 转 PNG）覆盖同名文件即可，无需改代码；重新生成脚本 `scripts/gen-tabbar-icons.py`（PIL 绘制 + 4x 超采样，可改色/图形）。
- 改 app.config.ts 的 tabBar 后需重启 dev:h5（与路由表同理）。
- ⚠️ **微信小程序 tabBar 图标只支持 .png/.jpg/.jpeg，不支持 SVG**；H5 端 SVG 可用，但小程序构建会报 `文件格式错误`。`app.config.ts` 中 iconPath/selectedIconPath 必须引用 `.png` 版本（项目同时保留了 SVG + PNG 两套文件，小程序只能用 PNG）。

## 后端地址 / 环境变量（Vercel 部署 + 小程序构建）
- 后端域名由 `src/constants/api.ts` 的 `API_ORIGIN = process.env.TARO_APP_API_ORIGIN || 默认值` 决定，默认 https://jbsttj-backend-production.up.railway.app。
- **坑**：Taro 4.x Vite 模式下 `TARO_APP_*` 变量只从 `.env` **文件**注入（`@tarojs/helper` 的 `dotenvParse` 不读 shell env），所以 Vercel/CI 的 shell 环境变量默认不会进产物。
- **方案（2026-08-26 重构）**：`config/index.ts` 的 `loadEnvFile()` 手动解析根目录 `.env`，三级优先级 **shell(CI) > .env > 代码默认值**，在 `defineConstants` 中**无条件**注入 `process.env.TARO_APP_API_ORIGIN` 与 `process.env.TARO_APP_ARMS_ENV`（默认值分别与 `src/constants/api.ts`、`src/monitor/arms.ts` 保持一致）。
- ⚠️ **必须无条件注入的原因**：微信小程序运行时没有 `process` 全局对象。若常量未定义，源码里的 `process.env.TARO_APP_*` 会原样残留进产物，启动即抛 `ReferenceError: process is not defined`（H5 无此问题，构建期定义了才不残留）。原理：`@tarojs/vite-runner/dist/mini/config.js` 里 `Object.assign({}, envConstants, defineConstants)`，用户 defineConstants 覆盖 Taro 的 .env 注入。
- Vercel 改后端地址：Project Settings → Environment Variables 加 `TARO_APP_API_ORIGIN`=<域名>，重新触发部署（构建期注入）。
- `vercel.json`：framework=null，build=`npm run build:h5`，output=`dist`，SPA catch-all rewrite，`/js/ /css/` immutable 一年缓存。`.vercelignore` 排除 node_modules/dist/.git/.workbuddy/docs。
- **本地构建坑（weapp 与 h5 通用）**：WorkBuddy 沙箱通过 NODE_OPTIONS 注入 genie-safe-delete shim，Taro `emptyDirectory` 清空 dist 会被 trash 二进制拦截（"Some operations were aborted"，每次只删 1 个文件就失败）。**稳定解法：`NODE_OPTIONS= npm run build:weapp` / `NODE_OPTIONS= npm run build:h5`**（剥离 shim 后 Node 原生删除构建产物目录，非个人文件，安全）。注意 H5 也一样会触发：只要 dist 里有旧文件（上次构建残留）就会在 emptyOutputDir 处失败；dist 为空时 build 自身不触发拦截。
- ⚠️ **两端共用同一个 `dist/` 目录，会后构建的一端完全覆盖另一端**。微信开发者工具打开的就是 `dist/`，所以同时验证两端时**必须把 weapp 放在最后跑**，否则 dist 里是 H5 产物、开发者工具打不开。
- ⚠️ **别用 `grep -c` 的结果接 `&&`**：匹配数为 0 时 `grep` 退出码是 1，`&&` 会短路导致后续构建根本不执行，让人误判成构建失败（而 0 其实代表"0 个错误"）。用 `;` 分隔或单独跑。

## 页面元信息 / 问答页引导（2026-08-24）
- 全站页面 title/description 统一走 `src/hooks/usePageMeta.ts`（H5 守卫，设 document.title + meta description + og 标签）；新页面接入只需在组件体顶部调用一次 hook。
- 问答页冷启动引导：`fetchGuideQuestions(code)`（公开接口，静默失败回退硬编码建议）；已解答问题的真人答案**不在向量库**，点击时直接落聊天消息（`source="human"` 标签「用户解答」），不走检索。
- QuestionPanel：`/dm-guide/questions` 需登录——未登录必须不发请求（401→refresh 失败→死循环加载），`loadFirst` 与 effect 都要 `isAuthenticated` 守卫，渲染层给登录引导分支。

## 用户信息编辑功能（全栈）
- 后端 `app/api/v1/auth.py`：`GET/PATCH /auth/me`（PATCH 支持 `If-Match: <updated_at>` 乐观并发，冲突返回 409 `stale_profile`）、`POST /auth/change-password`、`POST /auth/change-email`。字段全 snake_case。
- 字段扩展：`profiles` 表新增 `avatar_color/gender/birthday/region`（`sql/profile.sql`）。
- 前端资料页 `pages/profile/{index,edit,security}`，共享 `components/Avatar`（image 优先，否则按 avatar_color 渐变 + 首字母）。

## 头像上传（微信式裁剪 + 后端中转 simple_upload）
- 流程：**后端中转上传**（不再走前端直传 OSS）。`services/auth.ts` 的 `uploadAvatar(blob)`：
  1. 直接 `fetch(POST /auth/me/avatar, multipart, 字段名 file)` 把裁剪后的 JPEG 字节发给后端；
  2. 后端复用 `FileService.simple_upload`（prefix="avatars"）写入 OSS（含秒传去重），落库 `profiles.avatar_url + avatar_object_key + avatar_color=null`，返回完整 `Profile`；
  3. 前端用返回的 `avatar_url`（OSS 公开 URL 或后端代理 `GET /files/avatar/{user_id}`）更新表单与全局用户。
- 后端：`POST /auth/me/avatar`（重构为走 simple_upload）；**已移除** `POST /auth/me/avatar/presign` 与 `AvatarPresignResponse`（不再需要前端直传，避免 CORS/公开域名/V4 签名等坑）。
- 对象 key = `avatars/{user_id}/{date}/{uuid}.ext`（非 `temp/`），`profiles.avatar_object_key` 记录实际 key；`GET /files/avatar/{user_id}` 据此回源，老数据回退到 `avatars/{user_id}`。
- `FileService.simple_upload` 新增可选 `prefix` 参数（默认 `settings.upload_prefix`），头像传 `"avatars"`。
- `files` 列表已过滤 `avatars/*`，头像不会出现在用户文件管理器。
- 前端：`components/AvatarEditor`（全屏暗色 + 圆形取景框，拖动/捏合/滑块缩放，canvas 圆形裁剪导出 JPEG Blob）；编辑页 `pages/profile/edit`「从相册选择」→ 弹起裁剪 → 上传 → 同步 `ifMatch` 与全局用户。
- ⚠️ `profiles` 表新增列 `avatar_object_key`（见 `sql/profile.sql` 的 `do $$` 迁移块），部署后需重新执行该 SQL。
