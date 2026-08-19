/**
 * 后端服务地址统一出口。
 *
 * 后端为 FastAPI（jbsttj-backend），所有业务接口挂在 API_PREFIX 之下，
 * 且**不使用** { code, message, data } 包装：成功直接返回业务模型，
 * 失败返回 { error: { code, message, details? } }。
 *
 * 后端域名通过环境变量 `TARO_APP_API_ORIGIN` 注入（Taro 会自动把
 * 以 TARO_APP_ 开头的环境变量打进产物）：
 *   - 本地开发：在项目根目录 `.env` 里写 `TARO_APP_API_ORIGIN=http://localhost:8000`
 *   - Vercel 部署：Project Settings → Environment Variables 新增
 *     `TARO_APP_API_ORIGIN` = 你的 Railway 后端域名（如 https://xxx.up.railway.app）
 *     注意这是构建期注入，需重新触发一次部署才生效。
 * 未设置时回退到下面的默认地址。
 */

/** 后端服务根地址（不含 /api/v1） */
export const API_ORIGIN =
  process.env.TARO_APP_API_ORIGIN ||
  "https://jbsttj-backend-production.up.railway.app";

/** 后端 settings.api_prefix，与 .env 中的 API_PREFIX 保持一致 */
export const API_PREFIX = "/api/v1";

/** 带版本前缀的接口基址 */
export const API_BASE_URL = `${API_ORIGIN}${API_PREFIX}`;

/** 拼接完整接口地址 */
export function buildApiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
