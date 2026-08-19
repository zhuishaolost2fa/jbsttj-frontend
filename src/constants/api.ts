/**
 * 后端服务地址统一出口。
 *
 * 后端为 FastAPI（jbsttj-backend），所有业务接口挂在 API_PREFIX 之下，
 * 且**不使用** { code, message, data } 包装：成功直接返回业务模型，
 * 失败返回 { error: { code, message, details? } }。
 */

/** 后端服务根地址（不含 /api/v1） */
export const API_ORIGIN =
  process.env.NODE_ENV === "production"
    ? "https://jbsttj-backend-production.up.railway.app"
    : "https://jbsttj-backend-production.up.railway.app";

/** 后端 settings.api_prefix，与 .env 中的 API_PREFIX 保持一致 */
export const API_PREFIX = "/api/v1";

/** 带版本前缀的接口基址 */
export const API_BASE_URL = `${API_ORIGIN}${API_PREFIX}`;

/** 拼接完整接口地址 */
export function buildApiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
