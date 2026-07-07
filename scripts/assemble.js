/**
 * FFmpeg Video Assembly Script
 * 
 * Combines slide PNGs + audio MP3s into a single video.
 * Automatically detects slide count from the slides/ directory.
 * 
 * Usage: node assemble.js [project_dir]
 *   - project_dir: directory containing slides/ and audio/ (default: CWD)
 * 
 * Optional config.json in project_dir:
 *   { "video": { "audioBitrate": "192k", "slidePadding": 1.0 }, "ffmpeg": "ffmpeg", "ffprobe": "ffprobe" }
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Resolve project directory ---
const PROJECT_DIR = path.resolve(process.argv[2] || process.cwd());

// --- Load config ---
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const FFMPEG = config.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.ffprobe || process.env.FFPROBE_PATH || 'ffprobe';
const AUDIO_BITRATE = config.video?.audioBitrate || '192k';
const SLIDE_PADDING = config.video?.slidePadding ?? 1.0;

const SLIDES_DIR = path.join(PROJECT_DIR, 'slides');
const AUDIO_DIR = path.join(PROJECT_DIR, 'audio');
const TEMP_DIR = path.join(PROJECT_DIR, 'temp');

// --- Validate directories ---
if (!fs.existsSync(SLIDES_DIR)) { console.error(`ERROR: slides/ not found in ${PROJECT_DIR}`); process.exit(1); }
if (!fs.existsSync(AUDIO_DIR)) { console.error(`ERROR: audio/ not found in ${PROJECT_DIR}`); process.exit(1); }
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- Auto-detect slide count ---
const slideFiles = fs.readdirSync(SLIDES_DIR)
  .filter(f => /^slide_\d+\.png$/i.test(f))
  .sort();
const slideCount = slideFiles.length;

if (slideCount === 0) { console.error('ERROR: No slide_XX.png files found in slides/'); process.exit(1); }

// --- ⭐ Alignment gate (SKILL.md step 1.5): narration == slides == audio, or fail loudly ---
// Without this, a slide/narration count mismatch silently drops trailing narration and later
// crashes gen_subtitles.js with a raw ffprobe stack trace. Turn the skill's #1 failure mode
// into a clear error here.
const audioCount = fs.existsSync(AUDIO_DIR)
  ? fs.readdirSync(AUDIO_DIR).filter(f => /^slide_\d+\.mp3$/i.test(f)).length : 0;
const narrationPath = path.join(PROJECT_DIR, 'narration.json');
if (fs.existsSync(narrationPath)) {
  let narrationCount = 0;
  try { narrationCount = JSON.parse(fs.readFileSync(narrationPath, 'utf8')).length; }
  catch (e) { console.error(`ERROR: narration.json is not valid JSON: ${e.message}`); process.exit(1); }
  if (narrationCount !== slideCount || narrationCount !== audioCount) {
    console.error(`ERROR: count mismatch — narration.json=${narrationCount}, slides/*.png=${slideCount}, audio/*.mp3=${audioCount}. All three MUST be equal (SKILL.md step 1.5). Fix before assembling.`);
    process.exit(1);
  }
} else if (audioCount !== slideCount) {
  console.error(`ERROR: count mismatch — slides/*.png=${slideCount}, audio/*.mp3=${audioCount}. They MUST be equal. Fix before assembling.`);
  process.exit(1);
}

console.log(`Project: ${PROJECT_DIR}`);
console.log(`Slides: ${slideCount} | Padding: ${SLIDE_PADDING}s | Audio bitrate: ${AUDIO_BITRATE}`);
console.log('---');

// --- Get audio duration ---
function getDuration(audioPath) {
  const out = execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`, { encoding: 'utf8' });
  return parseFloat(out.trim());
}

// --- Step 1: Create individual video clips ---
const clips = [];
for (let i = 1; i <= slideCount; i++) {
  const num = String(i).padStart(2, '0');
  const imgPath = path.join(SLIDES_DIR, `slide_${num}.png`);
  const audioPath = path.join(AUDIO_DIR, `slide_${num}.mp3`);
  const clipPath = path.join(TEMP_DIR, `clip_${num}.mp4`);
  
  if (!fs.existsSync(imgPath)) { console.error(`Missing: ${imgPath}`); process.exit(1); }
  if (!fs.existsSync(audioPath)) { console.error(`Missing: ${audioPath}`); process.exit(1); }
  
  const duration = getDuration(audioPath);
  const totalDur = duration + SLIDE_PADDING;
  
  console.log(`Slide ${num}: ${duration.toFixed(1)}s audio → ${totalDur.toFixed(1)}s total`);
  
  execSync(
    `"${FFMPEG}" -y -loop 1 -i "${imgPath}" -i "${audioPath}" ` +
    `-c:v libx264 -tune stillimage -c:a aac -b:a ${AUDIO_BITRATE} ` +
    `-pix_fmt yuv420p -t ${totalDur.toFixed(2)} -shortest "${clipPath}"`,
    { stdio: 'pipe' }
  );
  
  clips.push(clipPath);
  console.log(`  ✅ clip_${num}.mp4`);
}

// --- Step 2: Create concat list ---
const listPath = path.join(TEMP_DIR, 'concat.txt');
// Escape single quotes for the ffmpeg concat demuxer (' → '\'') so paths containing an
// apostrophe (e.g. "George's") don't produce an unparseable list.
const listContent = clips.map(c => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
fs.writeFileSync(listPath, listContent);

// --- Step 3: Concatenate ---
const outputPath = path.join(PROJECT_DIR, 'video.mp4');
// +faststart: move moov atom to the front so the mp4 plays inline / streams (web players & chat
// attachments otherwise show "link won't open" until the whole file downloads). 2026-06-29 lesson.
execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart "${outputPath}"`, { stdio: 'pipe' });

// --- Report ---
const finalDur = getDuration(outputPath);
const finalSize = fs.statSync(outputPath).size;
console.log(`\n${'='.repeat(40)}`);
console.log(`🎬 Done!`);
console.log(`📁 Output: ${outputPath}`);
console.log(`⏱️  Duration: ${Math.floor(finalDur / 60)}:${String(Math.floor(finalDur % 60)).padStart(2, '0')}`);
console.log(`💾 Size: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);

// --- Quick audio check ---
try {
  const probeOut = execSync(`"${FFPROBE}" -v error -select_streams a:0 -show_entries stream=bit_rate -of csv=p=0 "${outputPath}"`, { encoding: 'utf8' });
  const audioBps = parseInt(probeOut.trim());
  // ffprobe returns "N/A" (→ NaN) for the exact silent-audio failure this check exists to catch,
  // so NaN must be treated as a failure, not a pass. SKILL.md 5a: "~2 kbps or N/A = TTS failed."
  if (!Number.isFinite(audioBps) || audioBps < 50000) {
    const shown = Number.isFinite(audioBps) ? `${Math.round(audioBps / 1000)}kbps` : 'N/A';
    console.log(`\n⚠️ WARNING: Audio bitrate is ${shown} — likely silent! Re-check TTS output.`);
    process.exitCode = 1;
  } else {
    console.log(`🔊 Audio: ${Math.round(audioBps / 1000)}kbps ✅`);
  }
} catch (e) {
  console.log(`⚠️ Could not check audio bitrate: ${e.message}`);
}
