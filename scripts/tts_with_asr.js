/**
 * TTS + ASR Verification Script
 *
 * Reads narration.json from the project directory, synthesizes each entry
 * via ElevenLabs TTS, and verifies with OpenAI Whisper ASR.
 *
 * Usage: node tts_with_asr.js [project_dir]
 *   - project_dir: directory containing narration.json (default: CWD)
 *
 * Environment variables (or a .env file in the project directory):
 *   ELEVENLABS_API_KEY — ElevenLabs API key
 *   OPENAI_API_KEY     — OpenAI API key (for Whisper)
 *
 * config.json in project_dir (required for voiceId):
 *   { "tts": { "voiceId": "...", "model": "...", "maxRetries": 5,
 *              "stripPunctuation": true, "synthesisMode": "breath_context" },
 *     "asr": { "passThreshold": 0.85, "language": "zh" } }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

// --- Resolve project directory ---
const PROJECT_DIR = path.resolve(process.argv[2] || process.cwd());

// --- Load .env fallback (project dir) ---
try {
  const envPath = path.join(PROJECT_DIR, '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env — fine, env vars may already be set */ }

// --- Load config ---
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const VOICE_ID = config.tts?.voiceId || process.env.TTS_VOICE_ID;
const MODEL_ID = config.tts?.model || 'eleven_multilingual_v2';
const PASS_THRESHOLD = config.asr?.passThreshold || 0.85;
const MAX_RETRIES = config.tts?.maxRetries || 5;
const STRIP_PUNCT = config.tts?.stripPunctuation !== false; // default true
const SYNTHESIS_MODE = config.tts?.synthesisMode || 'breath_context';
const VOICE_SETTINGS = config.tts?.voiceSettings || {
  stability: 0.72,
  similarity_boost: 0.84,
  style: 0,
  use_speaker_boost: true,
  speed: 0.95
};
const SEGMENT_MAX_HAN = config.tts?.breathSegmentMaxHan || 30;
const SEGMENT_SHORT_SILENCE = config.tts?.breathSegmentSilenceSeconds ?? 0.28;
const SEGMENT_LONG_SILENCE = config.tts?.breathSentenceSilenceSeconds ?? 0.52;
const FFMPEG = config.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';

if (!VOICE_ID || VOICE_ID.startsWith('YOUR_')) {
  console.error('ERROR: set tts.voiceId in config.json (or TTS_VOICE_ID env var).');
  console.error('Any voice from your ElevenLabs voice library works — premade or cloned.');
  process.exit(1);
}
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_KEY) { console.error('ERROR: ELEVENLABS_API_KEY env var not set'); process.exit(1); }
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error('ERROR: OPENAI_API_KEY env var not set'); process.exit(1); }

// --- Load narration ---
const narrationPath = path.join(PROJECT_DIR, 'narration.json');
if (!fs.existsSync(narrationPath)) {
  console.error(`ERROR: narration.json not found in ${PROJECT_DIR}`);
  process.exit(1);
}
const narration = JSON.parse(fs.readFileSync(narrationPath, 'utf8'));

const audioDir = path.join(PROJECT_DIR, 'audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

console.log(`Project: ${PROJECT_DIR}`);
console.log(`Slides: ${narration.length} | Voice: ${VOICE_ID} | Threshold: ${PASS_THRESHOLD}`);
console.log('---');

// --- Similarity: character overlap ratio ---
function similarity(a, b) {
  if (!a || !b) return 0;
  const sa = a.replace(/[\s\p{P}]/gu, '');
  const sb = b.replace(/[\s\p{P}]/gu, '');
  if (!sa || !sb) return 0;
  let matches = 0;
  const bChars = sb.split('');
  for (const c of sa) {
    const idx = bChars.indexOf(c);
    if (idx >= 0) { matches++; bChars.splice(idx, 1); }
  }
  return matches / Math.max(sa.length, sb.length);
}

// --- ElevenLabs TTS ---
function synthesize(text, outputPath, context = {}) {
  return new Promise((resolve, reject) => {
    const body = {
      text,
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS
    };
    if (context.previous_text) body.previous_text = context.previous_text;
    if (context.next_text) body.next_text = context.next_text;
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${VOICE_ID}`,
      method: 'POST',
      headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_KEY }
    }, res => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => reject(new Error(`TTS HTTP ${res.statusCode}: ${body}`)));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { fs.writeFileSync(outputPath, Buffer.concat(chunks)); resolve(); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('TTS request timed out after 120s')));
    req.write(data);
    req.end();
  });
}

// --- OpenAI Whisper ASR ---
async function transcribe(audioPath) {
  const audioData = fs.readFileSync(audioPath);
  const boundary = '----FormBoundary' + Date.now();
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`);
  parts.push(audioData);
  parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`);
  parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${config.asr?.language || 'zh'}`);
  parts.push(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`ASR HTTP ${res.statusCode}: ${data}`)); return; }
        try { resolve(JSON.parse(data).text || ''); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('ASR request timed out after 120s')));
    req.write(body);
    req.end();
  });
}

// --- Strip ALL punctuation (CJK + Latin) before sending to TTS ---
// Every punctuation mark becomes a pause in Chinese TTS output. Dense commas produce
// machine-gun narration; stripping them lets the voice flow in natural breath groups.
// Subtitles still come from the original punctuated narration.json.
// Disable with config.tts.stripPunctuation = false if your voice behaves differently.
function stripPunctForTTS(text) {
  return text
    .replace(/[。！？，；、：「」『』（）「」《》〈〉【】〔〕｛｝…—–‐~～]/g, ' ')
    .replace(/[.,!?;:"'(){}\[\]‐-―‘-‟…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hanLen(s) {
  return [...s].filter(c => /\p{Script=Han}/u.test(c)).length;
}

function normalizeSpaces(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function splitWithDelimiters(text, delimiters) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (delimiters.has(ch)) {
      out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function packUnits(units, maxHan) {
  const packed = [];
  let cur = '';
  for (const unit of units) {
    const candidate = cur ? cur + unit : unit;
    if (cur && hanLen(candidate) > maxHan) {
      packed.push(cur);
      cur = unit;
    } else {
      cur = candidate;
    }
  }
  if (cur) packed.push(cur);
  return packed;
}

// D-mode: sentence-sized breath segments + ElevenLabs request stitching. Each segment
// gets previous_text/next_text, then deterministic silence joins the final slide audio.
function splitBreathSegments(text) {
  const sentenceDelims = new Set([...'。！？']);
  const weakDelims = new Set([...'，、；：…—–']);
  const sentences = splitWithDelimiters(text, sentenceDelims);
  const segments = [];

  for (const sentence of sentences) {
    if (hanLen(sentence) <= SEGMENT_MAX_HAN) {
      segments.push(sentence);
      continue;
    }
    const units = splitWithDelimiters(sentence, weakDelims);
    segments.push(...packUnits(units, SEGMENT_MAX_HAN));
  }

  return segments.map(normalizeSpaces).filter(Boolean);
}

function silencePath(seconds) {
  const safe = String(seconds).replace('.', '_');
  const out = path.join(audioDir, `silence_${safe}.mp3`);
  if (!fs.existsSync(out)) {
    execFileSync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=mono',
      '-t', String(seconds),
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      out
    ], { stdio: 'pipe' });
  }
  return out;
}

function concatAudio(parts, outputPath) {
  const listPath = outputPath.replace(/\.mp3$/i, '.concat.txt');
  fs.writeFileSync(listPath, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  execFileSync(FFMPEG, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c:a', 'libmp3lame',
    '-b:a', '160k',
    outputPath
  ], { stdio: 'pipe' });
  fs.rmSync(listPath, { force: true });
}

async function synthesizeSlide(text, outputPath, idx, attempt) {
  if (SYNTHESIS_MODE !== 'breath_context') {
    const ttsText = STRIP_PUNCT ? stripPunctForTTS(text) : text;
    await synthesize(ttsText, outputPath);
    return { segments: 1 };
  }

  const segments = splitBreathSegments(text);
  const renderedParts = [];

  for (let i = 0; i < segments.length; i++) {
    const segPath = outputPath.replace(/\.mp3$/i, `.seg_${String(i + 1).padStart(2, '0')}.attempt_${attempt}.mp3`);
    const previousRaw = i > 0 ? segments[i - 1] : narration[idx - 1];
    const nextRaw = i < segments.length - 1 ? segments[i + 1] : narration[idx + 1];
    const segmentText = STRIP_PUNCT ? stripPunctForTTS(segments[i]) : segments[i];
    const previousText = previousRaw && (STRIP_PUNCT ? stripPunctForTTS(previousRaw) : previousRaw);
    const nextText = nextRaw && (STRIP_PUNCT ? stripPunctForTTS(nextRaw) : nextRaw);

    await synthesize(segmentText, segPath, { previous_text: previousText, next_text: nextText });
    renderedParts.push(segPath);
    if (i < segments.length - 1) {
      const previousIsShortBridge = hanLen(segments[i]) <= 10 && /[。！？]$/.test(segments[i]);
      renderedParts.push(silencePath(previousIsShortBridge ? SEGMENT_LONG_SILENCE : SEGMENT_SHORT_SILENCE));
    }
  }

  concatAudio(renderedParts, outputPath);
  for (const part of renderedParts) {
    if (!part.includes('silence_')) fs.rmSync(part, { force: true });
  }
  return { segments: segments.length };
}

// --- Process one slide ---
async function processSlide(idx) {
  const num = String(idx + 1).padStart(2, '0');
  const text = narration[idx];
  const outPath = path.join(audioDir, `slide_${num}.mp3`);
  const tmpPath = path.join(audioDir, `slide_${num}.attempt.mp3`);

  // Track the BEST attempt (highest similarity), not merely the last one. Whisper false-alarms
  // on cloned voices mean a later retry can score WORSE than an earlier one — shipping the last
  // attempt could throw away a good take. See SKILL.md "keep the best attempt".
  let bestSim = -1;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[${num}/${String(narration.length).padStart(2, '0')}] Attempt ${attempt}/${MAX_RETRIES}...`);

    try {
      const synthInfo = await synthesizeSlide(text, tmpPath, idx, attempt);
      const size = fs.statSync(tmpPath).size;
      console.log(`  TTS OK: ${Math.round(size / 1024)} KB (${synthInfo.segments} segment${synthInfo.segments === 1 ? '' : 's'})`);

      // Provisional fallback: while no attempt has been ASR-scored yet, keep the latest
      // synthesized (but unverified) audio, so a transient Whisper outage doesn't leave the
      // slide with no audio at all. A scored attempt below overwrites this.
      if (bestSim < 0) fs.copyFileSync(tmpPath, outPath);

      console.log(`  ASR verifying...`);
      const transcript = await transcribe(tmpPath);
      const sim = similarity(text, transcript);
      console.log(`  Similarity: ${(sim * 100).toFixed(1)}%`);

      // Promote this attempt to the shipped file whenever it beats the best so far.
      if (sim > bestSim) { bestSim = sim; fs.copyFileSync(tmpPath, outPath); }

      if (sim >= PASS_THRESHOLD) {
        console.log(`  ✅ PASS`);
        fs.rmSync(tmpPath, { force: true });
        return true;
      } else {
        console.log(`  ❌ FAIL (need ≥${(PASS_THRESHOLD * 100).toFixed(0)}%)`);
        console.log(`  Original: ${text.substring(0, 60)}...`);
        console.log(`  ASR got:  ${transcript.substring(0, 60)}...`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  fs.rmSync(tmpPath, { force: true });
  if (bestSim < 0) {
    if (fs.existsSync(outPath)) {
      console.log(`  ⚠️ ASR never succeeded (Whisper down?) — kept UNVERIFIED audio for slide ${num}. Re-run to verify.`);
    } else {
      console.log(`  ⚠️ All ${MAX_RETRIES} attempts errored — no audio written for slide ${num}`);
    }
  } else {
    console.log(`  ⚠️ Kept best attempt (${(bestSim * 100).toFixed(1)}%) after ${MAX_RETRIES} tries`);
  }
  return false;
}

// --- Main ---
(async () => {
  console.log(`\nStarting TTS+ASR for ${narration.length} slides\n`);
  let passed = 0, failed = 0;

  for (let i = 0; i < narration.length; i++) {
    const ok = await processSlide(i);
    if (ok) passed++; else failed++;
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Done! Passed: ${passed}, Failed: ${failed}, Total: ${narration.length}`);
  if (failed > 0) {
    console.log(`⚠️ ${failed} slide(s) did not meet ASR threshold — see SKILL.md "verify the words, ship on redundancy" before re-rolling forever.`);
    // Non-zero exit so an orchestrating agent notices instead of assuming success.
    process.exitCode = 1;
  }
})();
