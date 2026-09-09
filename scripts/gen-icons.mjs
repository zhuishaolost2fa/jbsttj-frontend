/**
 * 生成 AppIcon 图标集（SVG -> PNG）。
 *
 * 为什么是 PNG 而不是内联 SVG / 图标字体：
 *  - 微信小程序端不支持内联 <svg>，仅 <image> 能可靠渲染，小程序也不支持 SVG 字体；
 *  - 图标字体需要网络字体文件（小程序 @font-face 不支持 base64 内联）；
 *  - emoji 在不同设备字形不一致，且会给三色配色掺进杂色（已全站弃用）。
 * 因此统一光栅化为 PNG，按「色调」产出多份，用哪个色调由 AppIcon 决定。
 *
 * 用法：
 *   npm i -D sharp                       # 唯一依赖（离线时可用 ICON_TOOLS 指向已有 node_modules）
 *   ICON_TOOLS="C:/path/to/workspace" node scripts/gen-icons.mjs
 *
 * 产物：
 *   src/assets/icons/{name}-{tone}.png   图标（96x96）
 *   src/assets/tabbar/tab-*.png          tabBar 图标（81x81，小程序强制要求本地 PNG）
 *   src/components/AppIcon/icons.ts      组件用的静态引入映射表（自动生成，勿手改）
 *
 * 图标源：scripts/icon-src/*.svg，取自 lucide-static v1.43.0（ISC License），
 * 24x24 viewBox、stroke-width 2、圆角端点，风格统一。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC_DIR = path.join(ROOT, 'scripts', 'icon-src')
const OUT_ICONS = path.join(ROOT, 'src', 'assets', 'icons')
const OUT_TABBAR = path.join(ROOT, 'src', 'assets', 'tabbar')
const OUT_MAP = path.join(ROOT, 'src', 'components', 'AppIcon', 'icons.ts')

/** 图标尺寸（显示尺寸多为 16~28px，96px 保证 3x 屏不糊） */
const ICON_SIZE = 96
const TABBAR_SIZE = 81

/** 色调 -> 十六进制，必须与 src/styles/tokens.less 保持一致 */
const TONES = {
  ink: '#181818', // 主色：浅底上的图标
  mute: '#8C8C8C', // 次级：占位符、未激活
  white: '#FFFFFF', // 深底上的图标
  yellow: '#FFD342', // 品牌黄：强调
  danger: '#C0392B', // 危险操作 / 错误
}

/** 每个图标默认产出 ink / mute / white 三色，下面两个集合是额外补色 */
const EXTRA_YELLOW = new Set(['star', 'trophy', 'sparkles', 'upload', 'check-circle'])
const EXTRA_DANGER = new Set(['alert-circle', 'trash-2', 'x'])

/** tabBar：小程序要求 81x81 本地 PNG。底色为墨色，故未选中用灰、选中用品牌黄 */
const TABBAR = [
  { name: 'tab-scripts', src: 'book', idle: '#7A7A7A', active: '#FFD342' },
  { name: 'tab-profile', src: 'user', idle: '#7A7A7A', active: '#FFD342' },
]

function loadSharp() {
  const candidates = ['sharp']
  if (process.env.ICON_TOOLS) {
    candidates.unshift(path.join(process.env.ICON_TOOLS, 'node_modules', 'sharp'))
  }
  for (const c of candidates) {
    try {
      return require(c)
    } catch (e) {
      /* try next */
    }
  }
  throw new Error(
    '未找到 sharp。请先 `npm i -D sharp`，或用 ICON_TOOLS="<包含 sharp 的 node_modules 目录>" 指定。'
  )
}

/** 把 SVG 里的 currentColor 换成目标色，并按需覆盖尺寸 */
function colorize(svg, color, size) {
  return svg
    .replace(/currentColor/gi, color)
    .replace(/width="24"/i, `width="${size}"`)
    .replace(/height="24"/i, `height="${size}"`)
}

async function render(sharp, svg, color, size, outFile) {
  const buf = Buffer.from(colorize(svg, color, size))
  await sharp(buf, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9, palette: true })
    .toFile(outFile)
  return fs.statSync(outFile).size
}

function toPascal(str) {
  return str
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

async function main() {
  const sharp = loadSharp()
  fs.mkdirSync(OUT_ICONS, { recursive: true })
  fs.mkdirSync(OUT_TABBAR, { recursive: true })
  fs.mkdirSync(path.dirname(OUT_MAP), { recursive: true })

  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg')).sort()
  if (!files.length) throw new Error(`scripts/icon-src 下没有 SVG：${SRC_DIR}`)

  const imports = []
  const mapEntries = []
  const names = []
  let totalBytes = 0

  for (const file of files) {
    const name = path.basename(file, '.svg')
    const svg = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    const tones = ['ink', 'mute', 'white']
    if (EXTRA_YELLOW.has(name)) tones.push('yellow')
    if (EXTRA_DANGER.has(name)) tones.push('danger')

    const tonePairs = []
    for (const tone of tones) {
      const varName = `${toPascal(name)}${toPascal(tone)}`
      const rel = `../../assets/icons/${name}-${tone}.png`
      imports.push(`import ${varName} from '${rel}'`)
      tonePairs.push(`    ${tone}: ${varName},`)
      totalBytes += await render(
        sharp,
        svg,
        TONES[tone],
        ICON_SIZE,
        path.join(OUT_ICONS, `${name}-${tone}.png`)
      )
    }
    names.push(name)
    mapEntries.push(`  '${name}': {\n${tonePairs.join('\n')}\n  },`)
  }

  // tabBar 图标
  for (const item of TABBAR) {
    const svg = fs.readFileSync(path.join(SRC_DIR, `${item.src}.svg`), 'utf8')
    for (const [suffix, color] of [
      ['', item.idle],
      ['-active', item.active],
    ]) {
      totalBytes += await render(
        sharp,
        svg,
        color,
        TABBAR_SIZE,
        path.join(OUT_TABBAR, `${item.name}${suffix}.png`)
      )
    }
  }

  const mapSrc = `// 自动生成，请勿手改 —— 由 scripts/gen-icons.mjs 产出
// 图标源：scripts/icon-src/*.svg（lucide-static，ISC License）
// 每个图标按色调产出多份 PNG：小程序端不支持内联 SVG，故统一光栅化。

${imports.join('\n')}

export type IconName =
${names.map((n) => `  | '${n}'`).join('\n')}

export type IconTone = 'ink' | 'mute' | 'white' | 'yellow' | 'danger'

export const ICON_MAP: Record<IconName, Partial<Record<IconTone, string>>> = {
${mapEntries.join('\n')}
}
`
  fs.writeFileSync(OUT_MAP, mapSrc, 'utf8')

  console.log(
    `generated ${names.length} icons x tones, ${files.length && totalBytes} bytes total -> src/assets/icons`
  )
  console.log(`tabbar: ${TABBAR.map((t) => t.name).join(', ')} -> src/assets/tabbar`)
  console.log(`map: src/components/AppIcon/icons.ts`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
