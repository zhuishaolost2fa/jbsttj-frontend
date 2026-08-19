import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import devConfig from './dev'
import prodConfig from './prod'
import vitePluginImp from 'vite-plugin-imp'
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
        : {})
    },
    copy: {
      patterns: [
      ],
      options: {
      }
    },
    framework: 'react',
    compiler: {
      vitePlugins: [vitePluginImp({
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
