# 依赖审计报告

> 生成时间：2026-09-08 23:0x（CST）
> 项目：jbsttj-frontend（Taro 4.2.1 + React 18）
> 命令：`npm outdated --json`、`npm audit --registry=https://registry.npmjs.org --json`

## 一句话结论

**54 个漏洞全部来自 `@tarojs/*` 依赖链，且 npm 给出的唯一「修复路径」是把 Taro 4.2.1 降级到 3.6.x —— 不可采纳。**
这些全是**构建期依赖**，不进线上运行时产物，对已部署的 H5 站点没有直接影响。建议维持现状，等 Taro 官方升级依赖链。

## 一、安全审计（npm audit）

| 等级 | 数量 |
|---|---|
| critical | 7 |
| high | 24 |
| moderate | 22 |
| low | 1 |
| **合计** | **54** |

### 漏洞来源分布

几乎 100% 挂在 `@tarojs/*` 上，根因是几个传递依赖版本偏旧：

| 传递依赖 | 被谁引入 | 性质 |
|---|---|---|
| `esbuild` | `@tarojs/helper` | 构建期（devDependency 链） |
| `glob` | `@tarojs/plugin-doctor`、`@tarojs/service` | 构建期 |
| `serialize-javascript` | `@rollup/plugin-terser` | 构建期 |
| `@tarojs/components` | `@tarojs/taro`、`@tarojs/taro-h5` | 框架内部 |

### 为什么不能按 npm 的建议修

npm 对每个 `@tarojs/*` 包给出的 `fixAvailable` 形如：

```json
{ "name": "@tarojs/cli", "version": "1.3.8", "isSemVerMajor": true }
{ "name": "@tarojs/components", "version": "3.2.16", "isSemVerMajor": true }
{ "name": "@tarojs/taro", "version": "3.6.22", "isSemVerMajor": true }
```

即**降级到 Taro 3.x**，与当前 Taro 4.2.1 大版本冲突，执行后项目必然构建失败。
`npm audit fix --force` 会照做，**不要跑**。

### 风险评估

- 全部位于构建工具链（CLI / plugin / helper / runner），**不进 `dist/` 运行时产物**
- 攻击面限于本地开发机与 GitHub Actions runner，不涉及线上用户
- 结论：**可接受，标记为「已知、不修」**，等 Taro 官方升依赖后复检

## 二、过期依赖（npm outdated）

19 个包有更新，实际只有 3 个值得动。

### B 档：可安全升级（wanted > current，patch / minor）

| 包 | 当前 | 可升到 | 说明 |
|---|---|---|---|
| `less` | 4.8.1 | 4.9.1 | 样式编译，minor 升级 |
| `postcss` | 8.5.23 | 8.5.28 | 补丁级 |
| `terser` | 5.49.0 | 5.51.2 | 压缩器，minor 升级 |

升级方式（**需先在 dev 环境验证样式产物无差异**）：

```bash
npm install less@4.9.1 postcss@8.5.28 terser@5.51.2
npm run build:h5 && npm run seo:verify
```

### C 档：仅 major 跨越 —— 不要自动升

`wanted == current`，说明在 package.json 声明的 semver 范围内已是最新，全是破坏性大版本：

| 包 | 当前 → latest | 风险 |
|---|---|---|
| `react` / `react-dom` | 18.3.1 → 19.2.8 | Taro 4 对 React 19 的支持需单独验证 |
| `typescript` | 5.9.3 → 7.0.2 | TS 7 是全新编译器（Go 版），生态未就位 |
| `vite` | 4.5.14 → 8.2.2 | 跨 4 个大版本，Taro 4 的 Vite 模式未必兼容 |
| `eslint` | 8.57.1 → 10.10.0 | 配置文件格式变更（flat config） |
| `@babel/*` | 7.29.7 → 8.0.x | Babel 8 破坏性变更 |
| `@types/react` | 18.3.31 → 19.2.18 | 需随 React 19 一起动 |
| `stylelint` | 14.16.1 → 17.15.0 | 规则与配置格式变更 |
| `react-refresh` / `terser` 等 | — | 随上面一起 |

**建议：全部维持现状。** 任何一项都需要独立的兼容性验证 + 完整回归，收益不明显。

## 三、复现与注意事项

```bash
# ⚠️ 必须显式指定官方源
npm audit --registry=https://registry.npmjs.org --json

# 直接跑会失败：项目默认 registry 是 npmmirror（淘宝镜像），
# 它不实现 /npm/v1/security/audits 端点，返回 404
npm audit   # → 404 Not Found

# 过期检查（镜像源可用，无需切源）
npm outdated --json
```

禁止执行：
```bash
npm audit fix --force   # 会把 Taro 4 降级到 3.x，项目报废
```

## 四、自动化

本报告由「每周依赖安全审计」自动化生成（每周一 03:00），覆盖写入。
