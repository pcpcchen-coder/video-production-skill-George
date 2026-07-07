/**
 * Node Canvas Slide Generator (no browser needed)
 *
 * Emergency fallback renderer. Path B (HTML templates) is strongly preferred — this path
 * cannot match its visual richness. Use only when Playwright AND the image API are both
 * unavailable, and re-render via Path A/B before publishing. See SKILL.md Step 2, Path C.
 *
 * Generates PNG slides from a slides.json definition file.
 *
 * Usage: node generate_slides.js [project_dir]
 *   - project_dir: directory containing slides.json (default: CWD)
 *
 * slides.json format (all fields optional except title):
 * [
 *   {
 *     "title": "Slide Title",
 *     "subtitle": "Optional subtitle",
 *     "bullets": ["Point 1", "Point 2", "## Section header"],
 *     "stat":   { "number": "95", "unit": "%", "caption": "解讀這個數字" },  // big-number layout
 *     "image":  "screenshots/foo.png",   // local image (relative to project dir) — a real visual
 *     "icon": "🦞",                        // NOTE: node-canvas can't render colour emoji (tofu)
 *     "footer": "Source: ..."
 *   }
 * ]
 * Prefer "stat" or "image" over long "bullets" — a slide of only bullets is a text wall
 * (SKILL.md 圖文並茂 rule). If you have neither a stat nor an image, you probably want Path B.
 *
 * Optional config.json:
 *   { "video": { "width": 1920, "height": 1080 },
 *     "slides": { "bgColor": "#1a1a2e", "accentColor": "#e94560",
 *                 "titleSize": 72, "subtitleSize": 40, "bodySize": 34 } }
 */

const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

// --- Resolve project directory ---
const PROJECT_DIR = path.resolve(process.argv[2] || process.cwd());

// --- Load config ---
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const W = config.video?.width || 1920;
const H = config.video?.height || 1080;
const BG_COLOR = config.slides?.bgColor || '#1a1a2e';
const ACCENT_COLOR = config.slides?.accentColor || '#e94560';

// Font-size floors from SKILL.md (mobile readability is law): title ≥72, subtitle ≥36,
// body ≥32. We clamp UP to the floor even if config asks for less, and warn.
function floored(value, floor, label) {
  const v = value || floor;
  if (v < floor) { console.warn(`⚠️ ${label} ${v}px is below the SKILL.md floor ${floor}px — using ${floor}px.`); return floor; }
  return v;
}
const TITLE_SIZE = floored(config.slides?.titleSize, 72, 'titleSize');
const SUBTITLE_SIZE = floored(config.slides?.subtitleSize, 36, 'subtitleSize');
const BODY_SIZE = floored(config.slides?.bodySize, 32, 'bodySize');
const BODY_LH = Math.round(BODY_SIZE * 1.5);   // CJK needs ~1.5 line-height to breathe
const FONT_FAMILY = config.slides?.fontFamily ||
  "'Microsoft JhengHei', 'Noto Sans TC', 'PingFang TC', 'WenQuanYi Zen Hei', 'Segoe UI', Arial, sans-serif";

// --- Load slides data ---
const slidesPath = path.join(PROJECT_DIR, 'slides.json');
if (!fs.existsSync(slidesPath)) {
  console.error(`ERROR: slides.json not found in ${PROJECT_DIR}`);
  console.error('Create a slides.json with an array of slide objects. See script header for format.');
  process.exit(1);
}
const slides = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));

// --- Ensure output directory ---
const outputDir = path.join(PROJECT_DIR, 'slides');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

console.log(`Project: ${PROJECT_DIR}`);
console.log(`Slides: ${slides.length} | Resolution: ${W}×${H}`);
console.log('---');

let hadWarning = false;
function warn(msg) { hadWarning = true; console.warn(`⚠️ ${msg}`); }

// --- Word-wrap a string to a max pixel width, returning lines ---
function wrapText(ctx, text, maxWidth, prefix = '', indent = '') {
  const lines = [];
  let line = prefix;
  for (const char of text) {
    const test = line + char;
    if (ctx.measureText(test).width > maxWidth && line !== prefix) {
      lines.push(line);
      line = indent + char;
    } else {
      line = test;
    }
  }
  if (line.trim()) lines.push(line);
  return lines;
}

// --- Drawing function ---
async function drawSlide(ctx, slide, slideNum) {
  const { bg = BG_COLOR, accentColor = ACCENT_COLOR, title = '', subtitle = '',
          bullets = [], footer = '', icon = '', stat = null, image = null } = slide;

  // Background + accent bar
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accentColor; ctx.fillRect(0, 0, W, 8);

  // Title (wraps instead of clipping off the right edge)
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${TITLE_SIZE}px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  let y = 130;
  const titleText = icon ? `${icon}  ${title}` : title;
  const titleLines = wrapText(ctx, titleText, W - 160);
  for (const tl of titleLines) { ctx.fillText(tl, 80, y); y += Math.round(TITLE_SIZE * 1.25); }

  // Subtitle
  if (subtitle) {
    y += 8;
    ctx.fillStyle = accentColor;
    ctx.font = `bold ${SUBTITLE_SIZE}px ${FONT_FAMILY}`;
    ctx.fillText(subtitle, 80, y);
    y += Math.round(SUBTITLE_SIZE * 1.4);
  }

  // --- Visual anchor 1: big-number stat (preferred over bullets) ---
  if (stat && (stat.number != null)) {
    ctx.textAlign = 'center';
    ctx.fillStyle = accentColor;
    const numSize = Math.min(300, Math.round((H - y) * 0.55));
    ctx.font = `bold ${numSize}px ${FONT_FAMILY}`;
    const numY = Math.round((y + H) / 2);
    const num = String(stat.number);
    ctx.fillText(num, W / 2, numY);
    if (stat.unit) {
      ctx.font = `bold ${Math.round(numSize * 0.35)}px ${FONT_FAMILY}`;
      ctx.fillStyle = '#ffffff';
      const numW = (() => { ctx.font = `bold ${numSize}px ${FONT_FAMILY}`; const w = ctx.measureText(num).width; ctx.font = `bold ${Math.round(numSize * 0.35)}px ${FONT_FAMILY}`; return w; })();
      ctx.textAlign = 'left';
      ctx.fillText(stat.unit, W / 2 + numW / 2 + 12, numY);
    }
    if (stat.caption) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e0e0e0';
      ctx.font = `${BODY_SIZE}px ${FONT_FAMILY}`;
      ctx.fillText(stat.caption, W / 2, numY + Math.round(numSize * 0.55));
    }
    ctx.textAlign = 'left';
  }

  // --- Visual anchor 2: embedded image (a real picture beats bullets) ---
  else if (image) {
    const imgPath = path.isAbsolute(image) ? image : path.join(PROJECT_DIR, image);
    const textW = bullets.length ? Math.round(W * 0.42) : 0;
    const areaX = textW ? textW + 40 : 120;
    const areaW = W - areaX - 120;
    const areaY = y + 20;
    const areaH = H - areaY - 120;
    try {
      const img = await loadImage(imgPath);
      const scale = Math.min(areaW / img.width, areaH / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      ctx.drawImage(img, areaX + (areaW - dw) / 2, areaY + (areaH - dh) / 2, dw, dh);
    } catch (e) {
      warn(`slide ${slideNum}: could not load image "${image}" (${e.message}). Rendered a placeholder.`);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(areaX, areaY, areaW, areaH);
      ctx.fillStyle = '#888'; ctx.textAlign = 'center';
      ctx.font = `${BODY_SIZE}px ${FONT_FAMILY}`;
      ctx.fillText(`[missing: ${image}]`, areaX + areaW / 2, areaY + areaH / 2);
      ctx.textAlign = 'left';
    }
    if (bullets.length) drawBullets(ctx, bullets, y + 20, accentColor, textW + 40, slideNum);
  }

  // --- Fallback: bullets (a text wall — emergency only) ---
  else if (bullets.length) {
    drawBullets(ctx, bullets, y + 20, accentColor, W - 180, slideNum);
  }

  // Footer / watermark (the one sanctioned sub-body element)
  if (footer) {
    ctx.fillStyle = '#888';
    ctx.font = `24px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(footer, 80, H - 40);
  }
}

// --- Draw bullet list, warning (not silently dropping) when it overflows ---
function drawBullets(ctx, bullets, startY, accentColor, maxRight, slideNum) {
  ctx.fillStyle = '#e0e0e0';
  ctx.font = `${BODY_SIZE}px ${FONT_FAMILY}`;
  let y = startY;
  const bottom = H - 130;
  let drawn = 0;

  for (const b of bullets) {
    if (y > bottom) {
      warn(`slide ${slideNum}: ${bullets.length - drawn} bullet(s) did not fit and were dropped — split into two slides or shorten text.`);
      break;
    }
    if (b.startsWith('##')) {
      ctx.fillStyle = accentColor;
      ctx.font = `bold ${BODY_SIZE + 8}px ${FONT_FAMILY}`;
      ctx.fillText(b.replace('##', '').trim(), 80, y);
      ctx.fillStyle = '#e0e0e0';
      ctx.font = `${BODY_SIZE}px ${FONT_FAMILY}`;
      y += Math.round(BODY_LH * 1.15);
    } else {
      const lines = wrapText(ctx, b, maxRight - 100, '• ', '  ');
      for (const line of lines) { ctx.fillText(line, 100, y); y += BODY_LH; }
      y += Math.round(BODY_SIZE * 0.4);
    }
    drawn++;
  }
}

// --- Generate slides ---
(async () => {
  for (let i = 0; i < slides.length; i++) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const num = String(i + 1).padStart(2, '0');
    await drawSlide(ctx, slides[i], num);
    const outPath = path.join(outputDir, `slide_${num}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    const s = slides[i];
    const kind = s.stat ? 'stat' : s.image ? 'image' : (s.bullets?.length ? 'bullets(text-wall)' : 'title-only');
    console.log(`✅ slide_${num}.png  [${kind}]`);
  }
  console.log(`\nAll ${slides.length} slides generated!`);
  if (hadWarning) { console.log('⚠️ Some slides had warnings (see above).'); process.exitCode = 1; }
})();
