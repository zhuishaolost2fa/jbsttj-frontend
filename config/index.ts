import { defineConfig, type UserConfigExport } from "@tarojs/cli";
import type { Plugin } from "vite";
import * as fs from "node:fs";
import * as path from "node:path";
import devConfig from "./dev";
import prodConfig from "./prod";

/**
 * ARMS 监控 SDK 平台分流（构建期裁剪）：
 * Taro 不支持 #ifdef 条件编译注释，因此用 vite alias 把"非当前构建平台"的
 * ARMS SDK 包替换为 no-op stub（src/monitor/arms-stub.ts）：
 *  - H5 构建：@arms/rum-miniapp → stub（产物只含 @arms/rum-browser）
 *  - 小程序构建：@arms/rum-browser → stub（产物只含 @arms/rum-miniapp）
 */
function armsPlatformAlias(): Plugin {
  const isH5 = process.env.TARO_ENV === "h5";
  const stubPath = path.resolve(__dirname, "../src/monitor/arms-stub.ts");
  return {
    name: "arms-platform-alias",
    config: () => ({
      resolve: {
        alias: isH5
          ? [{ find: /^@arms\/rum-miniapp$/, replacement: stubPath }]
          : [{ find: /^@arms\/rum-browser$/, replacement: stubPath }],
      },
    }),
  };
}

/**
 * 读取项目根目录 .env 文件（简单 KEY=VALUE 解析，忽略注释与空行），
 * 供构建期统一解析 TARO_APP_* 变量，保证任意环境（尤其无 .env 的本地）
 * 都能注入常量、产物不残留 process 引用。
 */
function loadEnvFile(): Record<string, string> {
  const envPath = path.resolve(__dirname, "../.env");
  const env: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return env;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<"vite">(async (merge, { command, mode }) => {
  // ── 构建期环境变量解析：shell(CI) > .env 文件 > 代码默认值 ──────────────
  // Taro 4.x Vite 模式只会把 .env 文件里的 TARO_APP_* 变量注入产物
  // （@tarojs/helper 的 dotenvParse 不读 shell 环境变量），且 .env 不存在时
  // 这些常量完全没有定义，导致源码里的 `process.env.TARO_APP_*` 原样残留。
  // 微信小程序运行时没有 process 全局对象，残留引用会直接抛
  // ReferenceError: process is not defined。因此这里手动解析 .env 并
  // 在 defineConstants 中**无条件**注入（defineConstants 优先级高于
  // Taro 自带的 envConstants，见 @tarojs/vite-runner/dist/mini/config.js）。
  const envFile = loadEnvFile();
  const TARO_APP_API_ORIGIN =
    process.env.TARO_APP_API_ORIGIN ||
    envFile.TARO_APP_API_ORIGIN ||
    "https://jbsttj-backend-production.up.railway.app"; // 与 src/constants/api.ts 默认值保持一致
  const TARO_APP_ARMS_ENV =
    process.env.TARO_APP_ARMS_ENV || envFile.TARO_APP_ARMS_ENV || "prod"; // 与 src/monitor/arms.ts 默认值保持一致

  const baseConfig: UserConfigExport<"vite"> = {
    projectName: "jbsttj-frontend",
    date: "2026-7-28",
    designWidth: 375,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: "src",
    outputRoot: "dist",
    plugins: ["@tarojs/plugin-html"],
    defineConstants: {
      // 无条件注入（而非仅在 shell 有值时注入）：
      // 1) 三级优先级（shell > .env > 默认值）只在此处解析一次，不冲突；
      // 2) 关键：微信小程序运行时没有 process 全局对象，若 TARO_APP_* 常量
      //    未被定义，源码中的 process.env 引用会原样打进产物并在启动时抛
      //    ReferenceError: process is not defined。
      "process.env.TARO_APP_API_ORIGIN": JSON.stringify(TARO_APP_API_ORIGIN),
      "process.env.TARO_APP_ARMS_ENV": JSON.stringify(TARO_APP_ARMS_ENV),
    },
    copy: {
      // favicon 静态资源拷到 dist 根目录：走 vite-plugin-static-copy，
      // dev:h5（--watch）与 build:h5 都会执行；scripts/copy-favicon.js 仅作
      // postbuild 兜底。link 标签由 src/app.ts 运行时注入（构建会篡改模板 href）。
      patterns: [
        { from: "src/assets/favicon/favicon.ico", to: "dist/favicon.ico" },
        { from: "src/assets/favicon/favicon.svg", to: "dist/favicon.svg" },
        {
          from: "src/assets/favicon/favicon-32.png",
          to: "dist/favicon-32.png",
        },
        {
          from: "src/assets/favicon/apple-touch-icon.png",
          to: "dist/apple-touch-icon.png",
        },
      ],
      options: {},
    },
    framework: "react",
    compiler: {
      vitePlugins: [armsPlatformAlias()],
      type: "vite",
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: "module", // 转换模式，取值为 global/module
            generateScopedName: "[name]__[local]___[hash:base64:5]",
          },
        },
      },
    },
    h5: {
      publicPath: "/",
      staticDirectory: "static",

      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: "css/[name].[hash].css",
        chunkFilename: "css/[name].[chunkhash].css",
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: "module", // 转换模式，取值为 global/module
            generateScopedName: "[name]__[local]___[hash:base64:5]",
          },
        },
      },
    },
    rn: {
      appName: "taroDemo",
      postcss: {
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        },
      },
    },
  };
  if (process.env.NODE_ENV === "development") {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig);
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig);
});
