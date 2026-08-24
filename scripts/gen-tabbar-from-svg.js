// Generate tabbar icons from Tabler SVG sources (24x24, stroke-based).
// Renders each icon at 324x324 (4x supersample) then downsizes to 81x81 via PIL.
// Usage: node gen-tabbar-from-svg.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const SRC = path.join(__dirname, 'iconfont-src');
const OUT = path.join(__dirname, '..', 'src', 'assets', 'tabbar');
const COLORS = { gray: '#9aa0ae', blue: '#5b7cfa' };
const MAP = { upload: 'tab-import', book: 'tab-scripts', user: 'tab-profile' };
const SUPER = 324; // 4x of 81

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

for (const [svgName, tabName] of Object.entries(MAP)) {
  const svg = fs.readFileSync(path.join(SRC, `${svgName}.svg`), 'utf8');
  for (const [key, color] of Object.entries(COLORS)) {
    const colored = svg.replace(/stroke="currentColor"/g, `stroke="${color}"`);
    const png = new Resvg(colored, { fitTo: { mode: 'width', value: SUPER } }).render().asPng();
    const name = `${tabName}${key === 'gray' ? '' : '-active'}.png`;
    fs.writeFileSync(path.join(OUT, name), png);
    console.log(`rendered ${name} (${png.length} bytes)`);
  }
}
console.log('DONE');
