/**
 * 生成 OG 分享图（1200×630），供 og:image / twitter:image 使用。
 *
 * 社交平台与 AI 助手在分享链接时会抓取这张图。没有它，分享出去的卡片是灰块，
 * 点击率明显更低。静态页与 SPA 首页的 og:image 都指向 /static/og-image.png。
 *
 * 用法：node scripts/gen-og-image.js
 * 输出：
 *   src/assets/og-image.png  源代码仓库归档
 *   src/static/og-image.png  Taro H5 构建时自动拷到 dist/static/og-image.png
 *   dist/static/og-image.png 已有 dist 时兜底
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT_ASSET = path.join(__dirname, '..', 'src', 'assets', 'og-image.png');
const OUT_STATIC = path.join(__dirname, '..', 'src', 'static', 'og-image.png');
const OUT_DIST = path.join(__dirname, '..', 'dist', 'static', 'og-image.png');

const W = 1200;
const H = 630;

/** 中文字体回退链：优先系统里最常见的几款黑体，resvg 会按序查找 */
const FONT = "Microsoft YaHei, PingFang SC, Noto Sans SC, Source Han Sans SC, Heiti SC, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5b7cfa"/>
      <stop offset="55%" stop-color="#6a6bf5"/>
      <stop offset="100%" stop-color="#8b5bf2"/>
    </linearGradient>
    <radialGradient id="glow" cx="82%" cy="18%" r="60%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="10%" cy="92%" r="55%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>

  <!-- 装饰：半透明圆环，暗示「复盘 / 推演」的层次感 -->
  <g fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="2">
    <circle cx="1055" cy="120" r="150"/>
    <circle cx="1055" cy="120" r="105"/>
    <circle cx="1055" cy="120" r="62"/>
  </g>
  <g fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2">
    <circle cx="120" cy="540" r="120"/>
    <circle cx="120" cy="540" r="78"/>
  </g>

  <!-- 品牌标 -->
  <g transform="translate(88,168)">
    <rect width="72" height="72" rx="20" fill="#ffffff" fill-opacity="0.20"/>
    <text x="36" y="50" font-family="${FONT}" font-size="38" font-weight="700"
          fill="#ffffff" text-anchor="middle">剧</text>
  </g>

  <text x="88" y="352" font-family="${FONT}" font-size="76" font-weight="700" fill="#ffffff">
    剧本杀复盘助手
  </text>
  <text x="88" y="418" font-family="${FONT}" font-size="32" fill="#ffffff" fill-opacity="0.92">
    DM 手册 AI 问答 · 剧情还原 · 真相复盘
  </text>

  <rect x="88" y="462" width="150" height="4" rx="2" fill="#ffffff" fill-opacity="0.75"/>
  <text x="88" y="524" font-family="${FONT}" font-size="26" fill="#ffffff" fill-opacity="0.85">
    www.jbs-ttj.store
  </text>
</svg>`;

function main() {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  })
    .render()
    .asPng();

  fs.mkdirSync(path.dirname(OUT_ASSET), { recursive: true });
  fs.writeFileSync(OUT_ASSET, png);
  console.log(`[gen-og-image] src/assets/og-image.png (${(png.length / 1024).toFixed(1)} KB)`);

  fs.mkdirSync(path.dirname(OUT_STATIC), { recursive: true });
  fs.writeFileSync(OUT_STATIC, png);
  console.log(`[gen-og-image] src/static/og-image.png (Taro 自动拷到 dist/static/)`);

  if (fs.existsSync(path.dirname(OUT_DIST))) {
    fs.mkdirSync(path.dirname(OUT_DIST), { recursive: true });
    fs.writeFileSync(OUT_DIST, png);
    console.log(`[gen-og-image] dist/static/og-image.png`);
  }
}

main();
