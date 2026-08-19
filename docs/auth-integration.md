# 用户注册登录 — 前端实现与联调说明

前端对接 `jbsttj-backend` 的 `/api/v1/auth/*`（底层为 Supabase GoTrue）。

---

## 一、联调前必须先修的两处后端配置

> 这两项不改，前端调用**必然失败**，与前端代码无关。

### 1. `SUPABASE_ANON_KEY` 被截断（阻塞级）

后端 `.env` 中该值只有 **20 个字符**，而正常的 anon key 是 200+ 字符的 JWT。

实测结果：

```
POST /api/v1/auth/login   → 401 {"error":{"code":"unauthorized","message":"Invalid API key"}}
POST /api/v1/auth/register → 401 同上
```

直接向 Supabase GoTrue 验证也是同样的结果：

```
用 .env 的 ANON_KEY   → 401 Invalid API key
用 SERVICE_ROLE_KEY   → 200 连通正常
```

说明 `SUPABASE_SERVICE_ROLE_KEY` 是好的，**只有 anon key 残缺**。

修复：Supabase 控制台 → Project Settings → API → 复制完整的 `anon` `public` key，
覆盖 `.env` 的 `SUPABASE_ANON_KEY`，重启后端。

`app/services/supabase.py` 的 `SupabaseAuth._headers()` 用的就是这个 key，
所以它一坏，注册/登录/刷新三个接口全挂。

### 2. CORS 未放行 Taro H5 的开发端口

当前配置：

```
CORS_ORIGINS=http://localhost:5173,http://localhost:3000,http://127.0.0.1:8000,http://localhost:8000
```

Taro H5 dev server 默认跑在 **10086**，不在白名单内，浏览器会拦截请求。

修改为：

```
CORS_ORIGINS=http://localhost:5173,http://localhost:3000,http://127.0.0.1:8000,http://localhost:8000,http://localhost:10086,http://127.0.0.1:10086
```

---

## 二、Supabase 已开启邮箱验证

实测 `/auth/v1/signup` 的返回：

```json
{ "id": "...", "aud": "authenticated", "email": "...", "confirmation_sent_at": "..." }
```

**没有 `access_token`** —— 即注册后不会直接登录，用户必须先去邮箱点验证链接。

前端已按此行为实现：

- 注册返回的 `access_token` 为空 → 不写入登录态，提示「注册成功，请前往邮箱完成验证后再登录」，并自动切回登录 Tab
- 若后续在 Supabase 后台关掉 "Confirm email"，注册会直接返回 token，前端会自动走「注册即登录」分支

**两种配置都不需要改前端代码。**

另外注意：`scripts/make_user_token.py` 里用的 `verify@jbsttj.local` 走不了 `/auth/login`，
因为 pydantic 的 `EmailStr` 会拒绝 `.local` 这类保留域名（实测返回 422）。
该账号只能通过 Admin API 创建 + 手工签发 token 使用。

---

## 三、前端实现结构

| 文件 | 职责 |
| --- | --- |
| `src/constants/api.ts` | 服务地址统一出口（`API_ORIGIN` + `/api/v1`） |
| `src/constants/auth.ts` | 接口路径、存储 key、续签阈值、密码规则 |
| `src/utils/authStorage.ts` | 会话持久化（Taro Storage，三端通用） |
| `src/utils/jwt.ts` | 轻量 JWT 解码（跨端手写 base64url+UTF-8，取 exp / claims） |
| `src/services/tokenManager.ts` | 会话真相源：内存态 + 自动续签 + 单飞 + 订阅 |
| `src/services/request.ts` | 请求封装：注入 token、401 刷新重放、错误解析 |
| `src/services/auth.ts` | register / login / fetchMe / logout + 错误中文化 |
| `src/store/auth.tsx` | `AuthProvider` / `useAuth()` / `goLogin()` |
| `src/pages/login/` | 登录注册二合一页面 |

### 三个关键设计

**1. 刷新 token 用裸 `Taro.request`，不走 `request.ts`**

否则 `request → tokenManager → request` 形成循环依赖，且刷新请求自身返回 401 时会递归刷新。

**2. 并发刷新单飞**

Supabase 的 `refresh_token` 是**滚动失效**的：一旦用掉，旧的立即作废。
若 4 个请求同时 401 并各自发起刷新，只有第一个成功，其余全部失败并把用户踢下线。
`tokenManager.refresh()` 通过共享同一个 Promise 保证全局只发一次。

**3. 网络错误不清会话**

`refreshUser()` 只在 `ApiError.isAuthError`（401 或后端 token 类错误码）时登出。
后端没启动或断网时保留 `refresh_token`，网络恢复后仍是登录态——
否则用户每次断网都会被强制退出。

---

## 四、后端响应格式（已按实测对齐）

后端 **不使用** `{code, message, data}` 包装。前端原有的 `request.ts` 假设是错的，已重写。

成功：直接返回业务模型

```json
{ "access_token": "...", "refresh_token": "...", "expires_in": 3600, "user": {...} }
```

失败：

```json
{ "error": { "code": "validation_error", "message": "参数校验失败", "details": [...] } }
```

### 登录响应如何被消费（`tokenManager.toSession`）

一条完整的 Supabase 登录响应，各字段落地如下：

| 响应字段 | 处理方式 |
| --- | --- |
| `access_token` | 存入会话；同时解码其 JWT payload，**用其中的 `exp` 作为过期基准** |
| `refresh_token` | 存入会话，作为续命唯一凭据（Supabase 滚动失效，见下文单飞） |
| `expires_in` | 仅当 JWT 无 `exp` 时才用它 `Date.now()+expires_in*1000` 兜底 |
| `token_type` | 忽略（统一按 `Bearer` 注入） |
| `user.id` / `user.sub` | → `user.id`（缺失时回退到 JWT 的 `sub`） |
| `user.email` / `user_metadata.email` | → `user.email`（再回退 JWT `email` claim） |
| `user.role` | → `user.role` **占位**（Supabase 恒为 `authenticated`），由 `/auth/me` 覆盖为真实业务角色 |
| `user_metadata.email_verified` / `user.email_confirmed_at` | → `user.emailVerified` |
| 其余（identities / app_metadata / *_at 时间戳等） | 不落地，需要时按需扩展 |

**为什么过期时间优先取 JWT 的 `exp`**：`expires_in` 是「相对当前」的秒数，折算成绝对过期时间时依赖客户端收到响应的时刻，会被网络耗时和本机时钟漂移影响；而 JWT 的 `exp` 是服务端真正校验的绝对时间，用它续签时机更准。解码失败时自动回退 `expires_in`，不影响可用性。

**刷新时不覆盖用户信息**：`/auth/refresh` 的响应里 JWT 的 `role` 同样是占位的 `authenticated`。若用它覆盖，会把 `/auth/me` 拿到的真实角色冲掉，因此 `doRefresh` 只更新 token，用户信息以现有会话为准。

---

## 五、联调步骤

1. 补全后端 `.env` 的 `SUPABASE_ANON_KEY`，追加 CORS 的 10086 端口，重启后端
2. 前端 `src/constants/api.ts` 中 `API_ORIGIN` 开发环境已指向 `http://127.0.0.1:8000`
3. `npm run dev:h5`，访问首页 → 右上角「登录 / 注册」
4. 注册后到邮箱点验证链接，再回来登录

---

## 六、遗留项：上传接口路径尚未对齐

`src/constants/upload.ts` 中的路径是早期按约定设计的，与后端实际接口**不一致**：

| 前端当前 | 后端实际 |
| --- | --- |
| `/dm-guide/upload/multipart/init` | `POST /uploads/init`（或 `/uploads/temp/init`） |
| `/dm-guide/upload/multipart/part-urls` | `POST /uploads/{task_id}/presign` |
| （无） | `POST /uploads/{task_id}/parts/callback` |
| `/dm-guide/upload/multipart/complete` | `POST /uploads/{task_id}/complete` |
| `/dm-guide/upload/multipart/abort` | `DELETE /uploads/{task_id}` |

后端是 `task_id` 驱动的流程，且多了一步「批量回报 ETag」，
与前端 `ossMultipartUpload.ts` 现有的 `uploadId + objectKey` 模型不同，需要专门重构一次。

另外后端已内置秒传（`instant`）与断点续传（`resumed`）能力，重构时应改为复用后端的，
移除前端 localStorage 里那套自己实现的断点记录。

7 天生命周期对应后端的 `POST /uploads/temp/init`（对象落在 `temp/` 前缀）。
