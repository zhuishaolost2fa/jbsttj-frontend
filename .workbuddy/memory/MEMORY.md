# 项目长期笔记（jbsttj-frontend）

Taro 4.2.1 + React 18，同时构建 H5（Vercel，www.jbs-ttj.store）与微信小程序。后端 jbsttj-backend（FastAPI + Supabase + OSS + Celery），剧本杀 DM 手册 RAG。

## 零、设计体系（2026-09-09 全站改版，改色只看这一节）

- **三色**：`@ink #181818` · `@paper #FFFFFF` · `@accent #FFD342`。其余全是派生（中性灰五档 / 线条 / 填充 / 黄 tint），**唯一额外语义色是 `@danger #C0392B`**（删除、失败）。禁止再引入第四种色相、禁止同色渐变。
- **唯一色源**：`src/styles/tokens.less`（less 变量，编译期替换——小程序端拿不到 CSS 变量，所以不用 `:root`）+ `src/styles/tokens.ts`（tsx 内联样式用）。每个 `.less` 顶部 `@import` tokens（相对路径按目录深度）。
- **主 CTA 唯一形态**：黄底 + 墨字 + 8px 圆角 + 无彩色投影（AppButton primary / 登录提交 / 发消息 / 表单确认 / 空态按钮）。次级 = 白底 + 细描边；禁用 = 灰底灰字。
- **间距**：一律 `@sp-1~12`（4 的倍数），禁止 5/7/9/15。卡片间距 12、内边距 16、区块 16、菜单项行高 56、按钮高 48/36。
- **图标统一走 `AppIcon`**（2026-09-09 晚）：`src/components/AppIcon`，`<AppIcon name tone size className>`。图标源 `scripts/icon-src/*.svg`（lucide-static，ISC License），构建期 `scripts/gen-icons.mjs`（唯一依赖 sharp，可用 `ICON_TOOLS` 指向已有 node_modules）光栅化成**多色 PNG（96×96）**并自动生成 `AppIcon/icons.ts` 静态 import 映射 + tabBar PNG（81×81）。**为什么 PNG 而非 SVG**：小程序端只认 `<image>`，不支持内联 `<svg>`/图标字体；PNG <4KB 会被 Vite 内联成 base64 进 `common.js`，两端 `<image src=data:image/png;base64>` 都可用。色调五档 `ink/mute/white/yellow/danger`（见 `gen-icons.mjs` 的 `TONES`）。**不用 emoji**（各端字形不一、掺杂色）。新增图标：往 `scripts/icon-src/` 放 svg 重跑 `gen-icons.mjs` 即可，勿手改 `icons.ts`。
- 页面底 `@canvas #F7F7F7`，卡片白底 + `@line` 细描边（不再是灰色卡片 + 彩色投影）。
- 校验命令：`grep -rio "5b7cfa\|8b5cf6\|9aa0ae" dist --include='*.css' --include='*.wxss'` 必须为空。

## 一、小程序端 UI 红线

**nutui 已彻底移除**，内部渲染原生 HTML 标签的组件在小程序端一律变空节点。

- 根因：Taro 靠 `dist/base.wxml` 的 `tmpl_${depth}_${nn}` 模板渲染，`nn` 是组件数字别名（button=14，view 系=0/1/3/6/8，text=7，input=33，textarea=79）。**模板不存在 → `<template is="">` 静默失败，整棵子树空，不报错。**
- `@tarojs/plugin-html` 救不了：映射是编译期，只扫 `/\.[jt]sx/` 的**项目源码**，node_modules 的 `.js` 不参与。
- **替代组件（新增 UI 照抄）**：`src/components/AppButton`（View+Text，支持可选 `icon` 前置图标）、`AppSearchBar`（View+Input + AppIcon，左侧 search 图标、右侧清除 x 图标）。按下态要同时写 `hoverClass`（小程序）和 `:active`（H5）。`placeholderClass` 必须是全局类名，样式平铺少用 `&` 嵌套。
- 排查：① `grep -c "类名" dist/pages/x/index.js` 只证明进包 ② `grep -rohE 'createElement\("(div|span|button|i|p|ul|li|img)"' dist/ --include='*.js'` ③ `grep -c 'name="tmpl_0_14"' dist/base.wxml` =0 即实锤。⚠️ grep `"button"` 会误报 `dist/taro.js`。
- 允许的原生标签残留（均有 `typeof document === 'undefined'` 守卫）：`canvas`/`img`（AvatarEditor 离屏裁剪）、`link`/`meta`（H5 专属）。
- 深度知识：`dist/utils.wxs::xs.a(l,n,s)` 只有容器型编号才递增深度，input/textarea/image 恒取 `tmpl_0_${nn}`。

## 二、Taro 路由 & 构建约定

- 页面必须在 `src/app.config.ts` 的 `pages` 注册，否则 navigateTo 只改 URL 不渲染。**删页面要同步清所有跳转引用**；⚠️ 正则扫不到常量形式（`reLaunch({ url: HOME_PAGE })`）。改后必须重启 `dev:h5`。
- tabBar 已恢复图标（2026-09-09）：墨底 #181818 + 未选中灰 #7A7A7A + 选中品牌黄 #FFD342，PNG 由 `scripts/gen-icons.mjs` 从 `book.svg`/`user.svg` 生成（81×81）。小程序 tabBar 图标必须本地 PNG，不支持 SVG。
- ⚠️ **weapp 与 h5 共用 `dist/`，后建覆盖先建**，微信开发者工具打开的也是 `dist/` → **weapp 必须最后构建**。
- 构建命令：`APPDATA="C:/Users/Administrator/AppData/Roaming" NODE_OPTIONS= npm run build:h5|build:weapp`
- ⚠️ 别用 `grep -c` 接 `&&`（0 匹配退出码 1 会短路）。

## 三、导航结构（tabBar：剧本 · 我的）

- 搜索首页 `pages/index` 已删（`git checkout -- src/pages/index` 可还原），搜索框合并进「剧本」tab 顶部。
- 「我的」`pages/profile`：账号卡、导入 DM 手册、我的剧本、求解析、编辑资料、账号与安全、关于、退出。导入仅支持 Word（PDF 需 OCR 不支持）；收益 = 解析费抽 20% 给导入者与共建者。

## 四、环境变量 / 部署

- `API_ORIGIN = process.env.TARO_APP_API_ORIGIN || https://jbsttj-backend-production.up.railway.app`（`src/constants/api.ts`）。
- Taro 4.x Vite 模式 `TARO_APP_*` 只从 `.env` 注入（不读 shell env）→ `config/index.ts` 的 `loadEnvFile()` 手动解析，优先级 shell(CI) > .env > 默认值，在 `defineConstants` 里**无条件**注入（小程序无 `process` 全局，否则抛 ReferenceError）。
- `vercel.json`：framework=null，build=`npm run build:h5`，output=`dist`，SPA catch-all。
- ⚠️ `config/index.ts`、`package.json`、`package-lock.json` 长期有 2026-08-26 环境变量重构的未提交改动，提交前先确认是不是自己的。

## 五、SEO / GEO 静态内容站

- H5 是 SPA + hash 路由，首屏空壳，靠构建期 `scripts/gen-seo-pages.mjs` 生成 `dist/scripts/index.html`、`dist/s/{code}/index.html`、`robots.txt`、`sitemap.xml`、`llms.txt`、`llms-full.txt`、`feed.xml`，并向 `dist/index.html` 注入 meta/JSON-LD/noscript。域名常量 `SITE_ORIGIN` = https://www.jbs-ttj.store（可用 env `SEO_SITE_ORIGIN` 覆盖，脚本**不读 .env**）。
- **首页注入幂等**：锚点是 `src/index.html` 的 `<!-- SEO:HOOK -->`，注入内容用 `<!-- SEO:BEGIN/END -->` 包裹，靠这对标记精确清除。验证：连跑几次 `gen:seo`，`grep -c 'application/ld+json' dist/index.html` 必须恒为 3。
- ⚠️⚠️ **清除逻辑绝不许按范围通杀**。2026-09-05 白屏事故：兜底改成「HOOK 清到 `</head>`」把 Taro 的 `<script src>` 和 CSS link 一起清了。**凡是改 `enhanceSpaIndex()`，验证必须含 `grep -o '<script[^>]*src=' dist/index.html`**。兜底只能逐类精确匹配自己注入过的标签。
- 验证标签写在 `src/index.html` head 且**必须在 `SEO:HOOK` 之前**：百度 `codeva-pvLdncvohy`、Google `lBCdvWp1IfNYCu1d5Md-mlksTEnF_TRKBB9xaKgrPfU`、Bing `016128BC8397E2FFFBF0F1EAC7DD828C`。
- **`npm run seo:verify`（`scripts/verify-seo-output.mjs`）**：22 项判据，接在 `build:h5` 末尾，体检不过构建失败；`--strict` 连警告也判失败。判据两类：注入项在不在 + **宿主文件完不完整**（JS 入口/CSS/#app，这才是命门）。
- **死链红线**：只有生成了内容页的剧本才能链 `/s/{code}/`，其余链 `/#/pages/scriptDetail/index?code=xxx`。
- Taro 不拷贝 `src/static/` → OG 图由脚本拷到 `dist/static/og-image.png`。
- `dist/llms-full.txt`（513KB）**故意不进 sitemap**（IndexNow 的 URL 来源就是 sitemap 的 `<loc>`）。
- **lastmod 必须稳定**：内容指纹 sha256 前 16 位 + 缓存 `.seo-lastmod-cache.json`，指纹未变复用旧日期；内容页用 `script.updatedAt`。
- ⚠️ `MAX_QA_PER_SCRIPT = 200`，`details.qa` 是截断数组，`totalQa` 才是真实总量。

## 五之二、沙箱 Bash 专属环境坑

- **`APPDATA` 为空** → `npm-conf` 崩，伪装成「找不到 config/index」。必须显式给 `APPDATA="C:/Users/Administrator/AppData/Roaming"`。用户自己终端正常。
- `NODE_OPTIONS=` 是为了绕开删除 shim 拦截 Taro 清空 dist。
- **Edit 工具会「假成功」**（返回 success 未落盘）。验证必须 grep / 读文件核对，判断依据是 dist 产物不是日志。
- 只跑 SEO 生成：`npm run gen:seo`（约 7s，要求 dist 已是 H5 产物）。

## 六、搜索引擎收录

- 百度只支持「网址前缀」；未备案 .store 配额 0，只能等自然抓取。
- Bing Webmaster 用 **Google 账号登录**（微软账号登录报错是微软侧长期 bug）。
- **IndexNow 主力**：`npm run seo:submit`（增量）/ `seo:submit:all`（全量）。⚠️ **必须双端点都推** —— 只有 `www.bing.com/indexnow` 被 Insights 统计，`api.indexnow.org` 只分发不计数。
- ⚠️ **修正 2026-09-05 的错误结论**：此前记「必须在 BWT 后台绑定 IndexNow key」是**错的**。BWT 没有「绑定 key」这个动作，所有权校验完全靠站点根目录 key 文件 + 推送时带 `key`/`keyLocation`，协议层与后台账号解耦。报表在「站点已验证 + key 可访问 + 有推送」后自动出数，新站 2-3 天延迟。
- ⚠️ **千万别在 BWT 点 Generate 重新生成 key** —— 换 key 要同步改 `gen-seo-pages.mjs` 与 `submit-indexnow.mjs` 的 `INDEXNOW_KEY`、重新部署 key 文件、`--all` 全量重推。
- **站点 https 尚未就绪**（2026-09-08 实测 curl/webfetch/node fetch 全超时，仅 http 可访问）。sitemap 里却全写 https → 推给 Bing 的是死链。用户决定：**暂停推送等 https 就绪**（不切 http、不提前改 sitemap）。`submit-indexnow.mjs` 已加协议守卫：sitemap URL 协议与可用 origin 不一致时中止，`--force` 可覆盖。

## 七、DM 手册上传

- `src/utils/filePicker.ts` → `PickedFile { name, size, file?, path? }`：`file` 存在 = H5（分片预签名直传，上限 500MB）；只有 `path` = 小程序（`simpleUpload.ts` → `POST /files/simple-upload` 后端中转，上限 20MB）。
- 小程序不走分片的原因：无 XHR 拿不到 ETag、直传需配 OSS 域名、代理分片无进度。
- ⚠️ 小程序后台要把后端域名加进 **uploadFile 合法域名**（不只是 request）；`chooseMessageFile` 只能从聊天记录选文件，后缀校验不能省。
- 后端 Form 参数 `upload_type`（permanent/temporary），小程序传 `temporary`；秒传查重按 `prefix` 隔离。

## 八、业务模块速查

- **剧本详情页**：`content-tabs`（💬 问答 / 📖 故事还原），布局 `height:100vh` 弹性列 + 内容区 `flex:1;min-height:0`。支持 URL 参数 `?tab=story` 深链。
- **故事还原**：`/dm-guide/stories`（公开）；`StoryPanel` 承载 chips、卡片流、全屏 overlay。⚠️ `hasSynthesis` 必须要求 overview 至少一节非空 —— 后端会把空 overview 标成 `ready`（documentId=null），只看 `!!overview` 会渲染空白文章。
- **H5 划线评论**：`document.selectionchange` 捕获选区，offset 按码点，prefix/suffix ≤32 字符指纹。小程序端只读。
- **页面元信息**统一走 `src/hooks/usePageMeta.ts`。QuestionPanel 的 `/dm-guide/questions` 需登录，**未登录必须不发请求**（否则 401→refresh 失败→死循环）。
- **用户资料**：`GET/PATCH /auth/me`（PATCH 支持 `If-Match: <updated_at>` 乐观并发，409 `stale_profile`）、`POST /auth/change-password`、`/change-email`。头像走后端中转 `POST /auth/me/avatar`（multipart 字段 `file`），key = `avatars/{user_id}/{date}/{uuid}.ext`。
- **轮询**统一用 `usePolling({ active, visible, interval, task })` —— `visible` 由 `useDidShow`/`useDidHide` 驱动，页面离开即停表。

## 九、依赖与自动化

- **54 个漏洞（7 critical / 24 high）几乎全在 `@tarojs/*` 依赖链**（esbuild / glob / serialize-javascript 偏旧）。npm 给的唯一修复路径是把 Taro 4.2.1 降到 3.6.x → **`npm audit fix --force` 绝对不能跑**。实际风险低（构建期工具链不进运行时产物），标记已知不修。
- ⚠️ 项目 registry 是淘宝镜像，不实现 `/npm/v1/security/audits` → 必须 `npm audit --registry=https://registry.npmjs.org`。
- 过期依赖 19 个，只有 less / postcss / terser 可安全升；react 19、typescript 7、vite 8、eslint 10 全是 major 跨越，别动。报告 `docs/dependency-audit.md`。
- 部署走 `.github/workflows/deploy-h5.yml`（push main → GitHub Actions 里 npm ci + taro build + scp），**本地 `dist/` 不参与部署**，所以不需要夜间预构建。
- 自动化三个（详见 automation list）：每周一 03:00 依赖审计；每天 02:00 SEO 巡检 + https 就绪探测；IndexNow 推送已暂停等 https。
