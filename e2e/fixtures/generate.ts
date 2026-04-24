/**
 * e2e/fixtures/generate.ts
 *
 * Generates 7 placeholder 640×480 JPEG fixtures for the smoke test.
 * Run: bun run e2e/fixtures/generate.ts
 *
 * Each image is a solid-colored swatch with a text label "Meal N".
 * Output: e2e/fixtures/meals/meal-{1..7}.jpg (~20 KB each).
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'meals');

// 7 distinct background colors (RGB) — one per meal
const COLORS: [number, number, number][] = [
  [255, 128,  64],  // warm orange      — Meal 1
  [ 64, 190,  64],  // fresh green       — Meal 2
  [ 64, 128, 255],  // sky blue          — Meal 3
  [220,  80, 180],  // berry pink        — Meal 4
  [255, 210,  50],  // golden yellow     — Meal 5
  [ 80, 200, 180],  // teal              — Meal 6
  [200,  80,  80],  // tomato red        — Meal 7
];

const WIDTH  = 640;
const HEIGHT = 480;

async function generate(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (let i = 0; i < 7; i++) {
    const mealNum = i + 1;
    const [r, g, b] = COLORS[i];
    const outputPath = path.join(OUTPUT_DIR, `meal-${mealNum}.jpg`);

    // Build an SVG overlay with the meal label so we get readable text without
    // needing a font file. Sharp can composite an SVG Buffer onto a flat-color
    // background in one pass.
    const label = `Meal ${mealNum}`;
    const svg = Buffer.from(
      `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.25)" rx="0"/>
  <text
    x="50%" y="50%"
    font-family="sans-serif"
    font-size="72"
    font-weight="bold"
    fill="white"
    text-anchor="middle"
    dominant-baseline="middle"
  >${label}</text>
  <text
    x="50%" y="75%"
    font-family="sans-serif"
    font-size="28"
    fill="rgba(255,255,255,0.8)"
    text-anchor="middle"
    dominant-baseline="middle"
  >Food Pod E2E Fixture</text>
</svg>`
    );

    await sharp({
      create: {
        width: WIDTH,
        height: HEIGHT,
        channels: 3,
        background: { r, g, b },
      },
    })
      .composite([{ input: svg, gravity: 'center' }])
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    const size = fs.statSync(outputPath).size;
    console.log(`  ✅ ${path.basename(outputPath)}  (${Math.round(size / 1024)} KB)`);
  }

  console.log(`\n7 fixture JPEGs written to ${OUTPUT_DIR}`);
}

generate().catch((err) => {
  console.error('generate failed:', err);
  process.exit(1);
});

