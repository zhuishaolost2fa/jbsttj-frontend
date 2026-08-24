/**
 * 阿里云 ARMS 前端监控接入。
 *
 * 平台分流说明（重要）：
 * Taro 不支持 #ifdef 条件编译注释，本模块对两个平台的 SDK 都保持静态 import，
 * 由构建配置（config/index.ts 的 armsPlatformAlias 插件）按 TARO_ENV 把
 * "非当前构建平台"的 SDK 包 alias 到 no-op stub（./arms-stub.ts）：
 *  - H5 产物：只包含 @arms/rum-browser（页面性能 / WebVitals / Ajax / 静态资源 / JS 错误 / 用户行为）
 *  - 小程序产物：只包含 @arms/rum-miniapp（Ajax / JS 错误 / 控制台错误 / 用户行为）
 *
 * 环境标识：参考值 'prod' | 'gray' | 'pre' | 'daily' | 'local'，
 * 默认 'prod'，可用构建期环境变量 TARO_APP_ARMS_ENV 覆盖
 * （本地 .env 或 Vercel 构建环境变量，与 TARO_APP_API_ORIGIN 同机制）。
 */

import armsRumH5 from '@arms/rum-browser'
import armsRumMini from '@arms/rum-miniapp'

/** ARMS 环境标识，参考值：'prod' | 'gray' | 'pre' | 'daily' | 'local' */
type ArmsEnv = 'prod' | 'gray' | 'pre' | 'daily' | 'local'

/** 上报环境，默认生产；可用构建期环境变量 TARO_APP_ARMS_ENV 覆盖 */
const ARMS_ENV: ArmsEnv = (process.env.TARO_APP_ARMS_ENV as ArmsEnv) || 'prod'

let initialized = false

/**
 * 初始化 ARMS 监控。幂等：重复调用只生效一次。
 * 应在应用入口最早处调用，以便捕获启动期的 JS 错误与首屏性能数据。
 *
 * 当前平台的 SDK 会真正初始化；另一平台的 SDK 在构建期已被 alias 成
 * no-op stub，对应的 init 调用不产生任何副作用。
 */
export function initArms(): void {
  if (initialized) return
  initialized = true

  // H5：Web SDK
  armsRumH5.init({
    endpoint:
      'https://proj-xtrace-1fbfc75a846af9309993bfc2f1fcd87-cn-hangzhou.cn-hangzhou.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1167188680072123-cn-hangzhou&service_id=bhqf2s72d7@27e892203bc2e1b38d11d',
    // 设置环境信息，参考值：'prod' | 'gray' | 'pre' | 'daily' | 'local'
    env: ARMS_ENV,
    // 设置路由模式，参考值：'history' | 'hash'
    spaMode: 'history',
    collectors: {
      // 页面性能指标监听开关，默认开启
      perf: true,
      // WebVitals指标监听开关，默认开启
      webVitals: true,
      // Ajax监听开关，默认开启
      api: true,
      // 静态资源开关，默认开启
      staticResource: true,
      // JS错误监听开关，默认开启
      jsError: true,
      // 控制台错误监听开关，默认开启
      consoleError: true,
      // 用户行为监听开关，默认开启
      action: true,
    },
    // 链路追踪配置开关，默认关闭
    tracing: false,
  })

  // 小程序：小程序 SDK
  armsRumMini.init({
    endpoint:
      'https://proj-xtrace-1fbfc75a846af9309993bfc2f1fcd87-cn-hangzhou.cn-hangzhou.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1167188680072123-cn-hangzhou&service_id=bhqf2s72d7@74cadec449be6dcce6313',
    // 设置环境信息，参考值：'prod' | 'gray' | 'pre' | 'daily' | 'local'
    env: ARMS_ENV,
    collectors: {
      // Ajax监听开关，默认开启
      api: true,
      // JS错误监听开关，默认开启
      jsError: true,
      // 控制台错误监听开关，默认开启
      consoleError: true,
      // 用户行为监听开关，默认关闭
      action: false,
    },
    // 链路追踪配置开关，默认关闭
    tracing: false,
  })
}
