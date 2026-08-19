# DM 指南上传 · 前后端对接说明

> 本文档描述的契约已用真实后端（`http://127.0.0.1:8000`）**完整跑通验证**，
> 不是设计稿。文末附验证结论。

## 一、链路总览

前端 `src/utils/ossMultipartUpload.ts` 按下面五步走。数据不经过业务后端，
直传 OSS。

> **支持格式（2026-08-10 更新）**：前端白名单仅接受 Word 文档
> （`.doc` `.docx`），由 `constants/upload.ts` 的 `DM_GUIDE_ACCEPT` 统一控制。
> PDF 不再支持。上传引擎按文件扩展名推导正确的 `Content-Type`
> （`.doc` 在部分浏览器没有 MIME，必须兜底映射）。**后端若存在 `content_type`
> 白名单，需同步放开为接受 Word 类型，否则 `init` 会被 400 拒绝。**
>

```
1. 算文件指纹（本地，抽样 SHA-256）
        ↓
2. POST /api/v1/uploads/temp/init
        ├─ instant = true  → 秒传命中，直接跳到第 5 步
        ├─ resumed = true  → 断点续传，跳过 uploaded_parts 里的分片
        └─ 都为 false      → 全新任务，传满 total_parts 片
        ↓
3. POST /api/v1/uploads/{task_id}/presign      批量换预签名 URL（每批 50 片）
   PUT  https://<bucket>.oss-...aliyuncs.com/  浏览器直传，并发 4
   POST /api/v1/uploads/{task_id}/parts/callback  批量上报（仅审计）
        ↓
4. POST /api/v1/uploads/{task_id}/complete     服务端重新列举 OSS 分片校验后合并
        ↓
5. GET  /api/v1/files/{file_id}/download-url   换取带签名的临时访问链接
```

取消：`DELETE /api/v1/uploads/{task_id}`（204），服务端同步清理 OSS 碎片。

---

## 二、三条铁律

### ① 切片大小必须用服务端返回的 `chunk_size`

`init` 请求里的 `chunk_size` 只是**期望值**。服务端 `resolve_chunk_size()` 会在
分片数超过 OSS 上限 10000 时自动上调，并向上取整到 1MB。

用本地常量切片 → 分片边界与服务端不一致 → 合并出来的文件直接损坏。

前端已固定使用 `init.chunk_size`，`constants/upload.ts` 里的 `CHUNK_SIZE`
仅作为期望值发给服务端。

### ② PUT 分片时绝对不能带 `Content-Type`

后端 `presign_part()` 调 OSS SDK 时构造的是 `UploadPartRequest`，**没有传
content_type**，所以签名里不包含该头。请求一旦带上这个头（哪怕是浏览器自动加的），
OSS 立刻返回 403。

实测对照：

| 请求 | 结果 |
| --- | --- |
| `PUT` 带 `Content-Type: application/octet-stream` | **403 SignatureDoesNotMatch** |
| `PUT` 不带任何 Content-Type | **200**，响应头含 ETag |

> ⚠️ `init` / `presign` 响应里都有一个 `part_content_type: "application/octet-stream"`
> 字段，后端 schema 把它注释成"上传分片时必须设置的 Content-Type"——**这个描述是错的**，
> 按它做必然 403。该字段仅供参考，前端刻意忽略它。
>
> 前端用 `file.slice(start, end)` 且不传第三个参数，产出的 Blob 的 `type` 为空串，
> `xhr.send(blob)` 时浏览器不会附加 Content-Type。这是刻意为之，**不要"顺手"补上**。

### ③ 断点续传由服务端负责，前端不要存 uploadId

OSS 才是进度的唯一可信来源。前端只要在 `init` 时带上 `file_hash`，
服务端就会自动匹配未完成的任务、调 `list_parts` 拿到 OSS 实际落盘的分片并返回。

之前那套 localStorage 断点记录已**全部移除**——本地记录会和 OSS 实际状态漂移，
是净负担。

---

## 三、文件指纹（`src/utils/fileHash.ts`）

秒传和断点续传都依赖 `file_hash`。400MB 全量 SHA-256 太慢，采用抽样：

- 文件 ≤ 6MB：全量哈希
- 文件 > 6MB：取 **头 2MB + 中间 2MB + 尾 2MB**，再把文件总大小混入摘要

碰撞需要同时满足：同一用户 + 文件大小完全相同 + 这三段 6MB 字节完全一致。
后端 `find_by_hash` 还会再校验一次 `file_size` 且限定 `user_id`，实际风险可忽略。

`crypto.subtle` 只在安全上下文（HTTPS / localhost）可用，局域网 HTTP 调试时
会降级为 JS 实现的双种子 FNV-1a。降级只影响"秒传能否命中"，不影响数据正确性。

---

## 四、缺片自愈

`complete` 时服务端会重新列举 OSS 分片做完整性校验，缺片返回：

```json
HTTP 409
{
  "error": {
    "code": "incomplete_parts",
    "message": "还有 2 个分片未上传完成",
    "details": { "missing_parts": [2, 3], "missing_count": 2 }
  }
}
```

前端捕获这个错误码后会自动补传 `missing_parts` 再重新合并，最多 2 轮
（`MAX_COMPLETE_REPAIR_ROUNDS`）。这种情况通常是分片 PUT 返回了 2xx 但 OSS 侧
最终没落盘——少见但确实会发生。

注意 `missing_parts` 服务端只返回前 50 个，缺片超过 50 说明有系统性问题，
自愈轮次用尽后会直接报错，不再无限重试。

---

## 五、运维必须配置的两项

### 1. OSS 跨域规则（CORS）—— **必须把 ETag 加进 ExposeHeaders**

| 项 | 值 |
| --- | --- |
| 来源 Origin | `http://localhost:10086`、以及正式域名 |
| 允许 Methods | `PUT`、`GET`、`HEAD`、`POST` |
| 允许 Headers | `*` |
| **暴露 Headers** | **`ETag`**（必填）、`x-oss-request-id` |
| 缓存时间 | 600 |

不配 `ExposeHeaders: ETag`，浏览器 JS 就读不到响应头里的 ETag。虽然合并时
后端以 OSS 列举结果为准、不依赖前端上报的 ETag，但前端会因为读不到 ETag 而
判定分片失败。前端对这种情况有专门的报错文案，不会让人对着 `undefined` 猜。

### 2. 生命周期规则 —— 7 天自动清理

DM 指南走 `POST /uploads/temp/init`，对象写入 **`temp/` 前缀**
（后端 `temp_upload_prefix`）。在 Bucket 上配：

| 规则 | 配置 |
| --- | --- |
| 匹配前缀 | `temp/` |
| 过期删除 | 7 天 |
| **清理未完成的分片上传** | **7 天（务必开启）** |

第二项经常被漏掉。用户传到一半直接关浏览器时 `abort` 接口不会被调用，
那些碎片**不显示在文件列表里但会一直计费**。

---

## 六、已验证的行为

用真实后端 + 真实 OSS 跑完整链路（12MB / 3 片）的结论：

| 验证项 | 结果 |
| --- | --- |
| `init` 返回字段与前端 TS 类型一致 | ✅ |
| `chunk_size` 实际返回 5242880（5MB），`total_parts=3` | ✅ |
| PUT 带 Content-Type | ❌ 403 SignatureDoesNotMatch（符合预期） |
| PUT 不带 Content-Type | ✅ 200，响应头含 `ETag`（带双引号，前端已剥） |
| `parts/callback` 批量上报 | ✅ `{"success":true,"message":"已记录 3 个分片"}` |
| `complete` 不传 parts | ✅ 200，返回完整 FileInfo |
| `download-url` 换链接后实际访问 | ✅ 200（`inline` / `attachment` 都正常） |
| 同 hash 二次 init → 秒传 | ✅ `instant=true`、`total_parts=0`、直接返回 file |
| 传一片后再 init → 断点续传 | ✅ `resumed=true`、`uploaded_parts=[1]` |
| 缺片时 complete | ✅ 409 + `details.missing_parts=[2,3]` |
| `DELETE /uploads/{id}` | ✅ 204 |

### 一个容易踩的坑

**签名 URL 绑定 HTTP 方法。** `download-url` 签的是 GET，用 HEAD 去访问会得到
403 SignatureDoesNotMatch。想探测文件是否可访问，必须用 GET（可配 Range 头只取
前几个字节），不能图省事用 HEAD。

---

## 七、前端文件职责

| 文件 | 职责 |
| --- | --- |
| `src/constants/upload.ts` | 接口路径、并发/重试/分批参数、大小限制 |
| `src/services/upload.ts` | 接口层，类型一比一映射后端 pydantic 模型（保持 snake_case） |
| `src/utils/fileHash.ts` | 抽样指纹 |
| `src/utils/ossMultipartUpload.ts` | 上传引擎：分片、并发池、重试、进度、自愈、取消 |
| `src/components/ImportDmGuide/` | 按钮 + 进度浮层 |

联调时只需改 `src/constants/api.ts` 里的服务地址。所有上传接口都需要登录态，
`services/request.ts` 会自动注入 `Authorization: Bearer`。
