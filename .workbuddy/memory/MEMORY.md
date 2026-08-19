# 项目长期笔记（jbsttj-frontend）

## Taro 路由约定
- 所有可导航页面必须在 `src/app.config.ts` 的 `pages` 数组中注册；未注册时 `Taro.navigateTo` 只会改变浏览器 URL 而不渲染任何页面。
- H5 新增/修改页面后必须重启 `npm run dev:h5`，dev server 不会可靠热更新 `app.config.ts` 的路由表。

## 后端地址 / 环境变量（Vercel 部署）
- 后端域名由 `src/constants/api.ts` 的 `API_ORIGIN = process.env.TARO_APP_API_ORIGIN || 默认值` 决定，默认 https://jbsttj-backend-production.up.railway.app。
- **坑**：Taro 4.x Vite 模式下 `TARO_APP_*` 变量只从 `.env` **文件**注入（`@tarojs/helper` 的 `dotenvParse` 不读 shell env），所以 Vercel/CI 的 shell 环境变量默认不会进产物。
- 解决：`config/index.ts` 的 `defineConstants` 在 `process.env.TARO_APP_API_ORIGIN` 有值时显式 `JSON.stringify` 注入；无值时不定义以让 .env/默认值兜底。优先级 shell(CI) > .env > 默认值。
- Vercel 改后端地址：Project Settings → Environment Variables 加 `TARO_APP_API_ORIGIN`=<域名>，重新触发部署（构建期注入）。
- `vercel.json`：framework=null，build=`npm run build:h5`，output=`dist`，SPA catch-all rewrite，`/js/ /css/` immutable 一年缓存。`.vercelignore` 排除 node_modules/dist/.git/.workbuddy/docs。
- 本地构建前需手动 `rm -rf dist`（Taro 清空 dist 会触发沙箱 safe-delete 拦截）。

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
