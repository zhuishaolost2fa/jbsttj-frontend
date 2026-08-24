import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import type { Plugin } from 'vite'
import * as path from 'node:path'
import devConfig from './dev'
import prodConfig from './prod'
import vitePluginImp from 'vite-plugin-imp'

/**
 * ARMS 监控 SDK 平台分流（构建期裁剪）：
 * Taro 不支持 #ifdef 条件编译注释，因此用 vite alias 把"非当前构建平台"的
 * ARMS SDK 包替换为 no-op stub（src/monitor/arms-stub.ts）：
 *  - H5 构建：@arms/rum-miniapp → stub（产物只含 @arms/rum-browser）
 *  - 小程序构建：@arms/rum-browser → stub（产物只含 @arms/rum-miniapp）
 */
function armsPlatformAlias(): Plugin {
  const isH5 = process.env.TARO_ENV === 'h5'
  const stubPath = path.resolve(__dirname, '../src/monitor/arms-stub.ts')
  return {
    name: 'arms-platform-alias',
    config: () => ({
      resolve: {
        alias: isH5
          ? [{ find: /^@arms\/rum-miniapp$/, replacement: stubPath }]
          : [{ find: /^@arms\/rum-browser$/, replacement: stubPath }],
      },
    }),
  }
}

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'vite'>(async (merge, { command, mode }) => {
  const baseConfig: UserConfigExport<'vite'> = {
    projectName: 'jbsttj-frontend',
    date: '2026-7-28',
    designWidth: 375,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: ['@tarojs/plugin-html'],
    defineConstants: {
      // 后端域名优先级：构建期 shell 环境变量（Vercel/CI 注入） > .env 文件 > 代码默认值。
      // Taro 默认只把 .env 文件里的 TARO_APP_* 变量打进产物，读不到 shell 环境变量，
      // 因此这里显式取 process.env.TARO_APP_API_ORIGIN 用 Vite define 注入；
      // 仅在 shell 中存在该变量时才定义，避免覆盖 .env 文件的取值。
      ...(process.env.TARO_APP_API_ORIGIN
        ? { 'process.env.TARO_APP_API_ORIGIN': JSON.stringify(process.env.TARO_APP_API_ORIGIN) }
        : {}),
      // ARMS 上报环境标识（'prod' | 'gray' | 'pre' | 'daily' | 'local'），
      // 与 API_ORIGIN 同机制：shell(CI) > .env > 代码默认值 'prod'。
      ...(process.env.TARO_APP_ARMS_ENV
        ? { 'process.env.TARO_APP_ARMS_ENV': JSON.stringify(process.env.TARO_APP_ARMS_ENV) }
        : {})
    },
    copy: {
      // favicon 静态资源拷到 dist 根目录：走 vite-plugin-static-copy，
      // dev:h5（--watch）与 build:h5 都会执行；scripts/copy-favicon.js 仅作
      // postbuild 兜底。link 标签由 src/app.ts 运行时注入（构建会篡改模板 href）。
      patterns: [
        { from: 'src/assets/favicon/favicon.ico', to: 'dist/favicon.ico' },
        { from: 'src/assets/favicon/favicon.svg', to: 'dist/favicon.svg' },
        { from: 'src/assets/favicon/favicon-32.png', to: 'dist/favicon-32.png' },
        { from: 'src/assets/favicon/apple-touch-icon.png', to: 'dist/apple-touch-icon.png' },
      ],
      options: {
      }
    },
    framework: 'react',
    compiler: {
      vitePlugins: [
        armsPlatformAlias(),
        vitePluginImp({
        libList: [
          {
            libName: '@nutui/nutui-react-taro',
            style: (name) => {
              return `@nutui/nutui-react-taro/dist/esm/${name}/style/css`
            },
            replaceOldImport: false,
            camel2DashComponentName: false,
          }
        ]
      })],
      type: 'vite'
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {
            selectorBlackList: ['nut-']
          }
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]'
          }
        }
      },
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',

      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css'
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {}
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]'
          }
        }
      },
    },
    rn: {
      appName: 'taroDemo',
      postcss: {
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        }
      }
    }
  }
  if (process.env.NODE_ENV === 'development') {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig)
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig)
})
