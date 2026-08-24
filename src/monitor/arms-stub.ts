/**
 * ARMS SDK 平台占位模块。
 *
 * 本项目是 Taro 多端工程，同一份源码会分别构建 H5 与小程序产物：
 *  - H5 构建只应包含 @arms/rum-browser
 *  - 小程序构建只应包含 @arms/rum-miniapp
 *
 * 构建期由 config/index.ts 中的 vite 插件按 TARO_ENV 把"非当前平台"的
 * ARMS SDK 包 alias 到本模块，避免把错误平台的 SDK（及其平台专属全局变量）
 * 打进产物。init 为 no-op，调用无副作用。
 */
export default {
  init: (_options: unknown): void => undefined,
}
