// Generate favicon assets from src/assets/favicon/favicon.svg (detective mask, brand blue).
// Renders: favicon-32.png, apple-touch-icon.png (180, full-bleed square for iOS rounding),
// and favicon.ico (16/32/48 PNG-embedded entries, Vista+ format all modern browsers accept).
// Usage: node scripts/gen-favicon.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const SRC = path.join(__dirname, '..', 'src', 'assets', 'favicon', 'favicon.svg');
// 资产源目录：favicon 设计稿与代码引用入口
const OUT = path.join(__dirname, '..', 'src', 'assets', 'favicon');
// 构建产物目录：Taro H5 的 staticDirectory 会在构建时自动把 src/static/ 拷到 dist/static/
const OUT_STATIC = path.join(__dirname, '..', 'src', 'static');

/** Render the rounded-corner SVG at `size` px. */
function renderRounded(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

/** Render a full-bleed square variant (iOS applies its own corner mask) at `size` px. */
function renderSquare(svg, size) {
  const square = svg.replace(/<rect width="512" height="512" rx="116"/, '<rect width="512" height="512" rx="0"');
  return new Resvg(square, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

/** Bundle PNG buffers into a .ico (PNG-embedded entries). */
function buildIco(entries) {
  // entries: [{ size, png }]  -> ICONDIR + ICONDIRENTRY[] + image data
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dirs = [];
  const datas = [];
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // width
    dir.writeUInt8(size >= 256 ? 0 : size, 1); // height
    dir.writeUInt8(0, 2); // palette
    dir.writeUInt8(0, 3); // reserved
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirs.push(dir);
    datas.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirs, ...datas]);
}

const svg = fs.readFileSync(SRC, 'utf8');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(OUT_STATIC)) fs.mkdirSync(OUT_STATIC, { recursive: true });

function emit(name, buf) {
  fs.writeFileSync(path.join(OUT, name), buf);
  fs.writeFileSync(path.join(OUT_STATIC, name), buf);
  console.log(`rendered ${name} (${buf.length} bytes)`);
}

const png32 = renderRounded(svg, 32);
emit('favicon-32.png', png32);

const png180 = renderSquare(svg, 180);
emit('apple-touch-icon.png', png180);

const ico = buildIco([
  { size: 16, png: renderRounded(svg, 16) },
  { size: 32, png: png32 },
  { size: 48, png: renderRounded(svg, 48) },
]);
emit('favicon.ico', ico);
console.log('DONE');
