/**
 * @arms/rum-miniapp 的 package.json 未暴露 types 入口（类型实际在包内 es/index.d.ts），
 * 这里补充最小声明，仅覆盖本项目用到的 API（init），避免模块被推断为 any。
 */
declare module '@arms/rum-miniapp' {
  interface RumMiniCollectors {
    /** Ajax 监听开关 */
    api?: boolean
    /** JS 错误监听开关 */
    jsError?: boolean
    /** 控制台错误监听开关 */
    consoleError?: boolean
    /** 用户行为监听开关 */
    action?: boolean
    [key: string]: boolean | undefined
  }

  interface RumMiniInitOptions {
    /** 上报端点 */
    endpoint: string
    /** 环境信息，参考值：'prod' | 'gray' | 'pre' | 'daily' | 'local' */
    env?: string
    /** 采集器开关 */
    collectors?: RumMiniCollectors
    /** 链路追踪配置开关，默认关闭 */
    tracing?: boolean
    [key: string]: unknown
  }

  interface RumMini {
    init(options: RumMiniInitOptions): void
  }

  const armsRum: RumMini
  export default armsRum
}
