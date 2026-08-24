/**
 * Postbuild: 把 favicon 资源拷到 dist 根目录。
 *
 * Taro/Vite 构建会篡改 index.html 里 <link> 的 href 路径但不一定拷文件，
 * 所以 favicon link 标签改为运行时注入（见 src/app.ts），文件由本脚本拷贝。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'assets', 'favicon');
const DIST = path.join(__dirname, '..', 'dist');

const FILES = ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png'];

if (!fs.existsSync(DIST)) {
  console.error('[copy-favicon] dist/ not found — skip');
  process.exit(0);
}

let copied = 0;
for (const f of FILES) {
  const src = path.join(SRC, f);
  const dst = path.join(DIST, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    copied++;
  } else {
    console.warn(`[copy-favicon] source not found: ${src}`);
  }
}
console.log(`[copy-favicon] ${copied}/${FILES.length} files copied to dist/`);
