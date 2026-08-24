# 项目长期笔记（jbsttj-frontend）

## Taro 路由约定
- 所有可导航页面必须在 `src/app.config.ts` 的 `pages` 数组中注册；未注册时 `Taro.navigateTo` 只会改变浏览器 URL 而不渲染任何页面。
- H5 新增/修改页面后必须重启 `npm run dev:h5`，dev server 不会可靠热更新 `app.config.ts` 的路由表。

## 导航结构（tabBar：首页 · 剧本 · 我的）
- 首页（pages/index）只做搜索：品牌 + SearchBar 联想（`/scripts/autocomplete`）+ 剧透提示；不再含导入入口。
- 导入 DM 手册（ImportDmGuide + ScriptSubmitForm 上传→匹配→填表→提交流程）已迁入「我的」页（pages/profile），属贡献者行为；我的页含说明卡：仅支持 Word（.doc/.docx），PDF 需 OCR 成本高不支持（PDF→Word 用 Edge 打印拆分+夸克网盘转换），收益=剧本解析费 20% 抽成，余给导入者与知识库共建者。
- 改 app.config.ts 的 tabBar 或 pages 后需重启 dev:h5（dev server 不热更新路由表）。


## tabBar 图标约定
- 图标为本地 PNG（81x81，<40KB），位于 `src/assets/tabbar/`，命名 `tab-{import|scripts|profile}[{-active}].png`（灰 #9aa0ae 未选中 / 蓝 #5b7cfa 选中）。
- Taro 原生 tabBar 只接受本地图片，不支持 iconfont 字体；但构建期会自动把 `assets/tabbar/*.png` 打包到 `dist/static/images/` 并重写路径，无需手动处理。
- 换图标：iconfont.cn 下载 81x81 PNG（或 SVG 转 PNG）覆盖同名文件即可，无需改代码；重新生成脚本 `scripts/gen-tabbar-icons.py`（PIL 绘制 + 4x 超采样，可改色/图形）。
- 改 app.config.ts 的 tabBar 后需重启 dev:h5（与路由表同理）。

## 后端地址 / 环境变量（Vercel 部署）
- 后端域名由 `src/constants/api.ts` 的 `API_ORIGIN = process.env.TARO_APP_API_ORIGIN || 默认值` 决定，默认 https://jbsttj-backend-production.up.railway.app。
- **坑**：Taro 4.x Vite 模式下 `TARO_APP_*` 变量只从 `.env` **文件**注入（`@tarojs/helper` 的 `dotenvParse` 不读 shell env），所以 Vercel/CI 的 shell 环境变量默认不会进产物。
- 解决：`config/index.ts` 的 `defineConstants` 在 `process.env.TARO_APP_API_ORIGIN` 有值时显式 `JSON.stringify` 注入；无值时不定义以让 .env/默认值兜底。优先级 shell(CI) > .env > 默认值。
- Vercel 改后端地址：Project Settings → Environment Variables 加 `TARO_APP_API_ORIGIN`=<域名>，重新触发部署（构建期注入）。
- `vercel.json`：framework=null，build=`npm run build:h5`，output=`dist`，SPA catch-all rewrite，`/js/ /css/` immutable 一年缓存。`.vercelignore` 排除 node_modules/dist/.git/.workbuddy/docs。
- 本地构建：`rm -rf dist` 会被沙箱 safe-delete 拦截报错，但目录实际常已被删除；失败后直接 `npm run build:h5` 即可（Taro 不清空 dist 时 build 自身不会触发拦截）。

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
