/* narration 斷句 lint — deterministic phrasing checks, run BEFORE TTS (SKILL.md Step 1.8).
   The rules and their rationale live in references/tts-phrasing.md — the numbers here
   and in that doc are the same single source of truth; change them together.

   Usage: node lint_narration.js [project_dir]
     - project_dir: directory containing narration.json (default: CWD)

   Exit codes: 0 = pass (warnings allowed), 1 = ERRORs found, 2 = cannot run.

   Zero dependencies (Node ≥18 built-ins only), no network. */

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.argv[2] || process.cwd());

// --- Constants (must match references/tts-phrasing.md) ---
const BG_WIDTH_MAX = 16;   // E1: breath-group display width cap — same ruler as gen_subtitles.js capSplit
const BG_HAN_MIN = 6;      // W1: breath-group Han-char floor (first group of a sentence is exempt)
const SHORT_BG = 5;        // W2: machine-gun = ≥RUN_LEN consecutive groups each ≤ SHORT_BG Han
const LONG_BG = 14;        // W3: drone = ≥RUN_LEN consecutive groups each ≥ LONG_BG Han
const RUN_LEN = 3;
const SENT_MAX = 40;       // W4: Han chars between sentence enders
const SLIDE_MIN = 80, SLIDE_MAX = 150; // W5: Han chars per slide
const SLIDE_HARD_MIN = 20; // E6: below this the entry is degenerate

// Breath-group delimiters — keep IDENTICAL to the list in tts-phrasing.md §硬性數字
const BREATH_DELIMS = new Set([...'。！？，；、：…—–\n,.!?;:']);
const SENT_ENDERS = new Set([...'。！？.!?']);
const BRACKETS = /[「」『』（）()《》〈〉【】〔〕｛｝{}\[\]]/g;
const CONNECTIVES = /(然後|但是|不過|因為|所以|而且|於是|雖然|接著|首先|其實|然而|因此|可是|再來|另外)[，,]/g;
// chars that read 一 in citation tone when preceding it (第一/之一/二十一…) — no sandhi risk
const YI_SAFE_PREFIX = new Set([...'之第唯萬十百千零〇一二三四五六七八九兩']);

const isHan = c => /\p{Script=Han}/u.test(c);
const hanLen = s => [...s].filter(isHan).length;
// display width, mirrors gen_subtitles.js dw(): CJK = 1, ASCII (Latin/digit/space) = 0.5
const width = s => [...s].reduce((a, c) => a + (c.charCodeAt(0) <= 0xff ? 0.5 : 1), 0);

// Mask the dots of letter-dot acronyms (P.U.A.) so they neither trip the ASCII-dot
// ERROR nor split breath groups. '·' is not a delimiter and keeps string length.
const maskAcronyms = s => s.replace(/(?:[A-Za-z]\.){2,}/g, m => m.replace(/\./g, '·'));

// Split into breath groups, remembering the delimiter that PRECEDED each group
// (so W1 can exempt the first group of every sentence — the 主題—評論 topic).
function splitGroups(text) {
  const groups = []; let cur = '', prevDelim = '';
  for (const ch of text) {
    if (BREATH_DELIMS.has(ch)) {
      if (cur.trim()) groups.push({ t: cur.trim(), prevDelim });
      cur = ''; prevDelim = ch;
    } else cur += ch;
  }
  if (cur.trim()) groups.push({ t: cur.trim(), prevDelim });
  return groups;
}

// --- Load heteronym list (optional): script-relative first, then project dir ---
let heteronyms = null;
for (const p of [path.join(__dirname, '..', 'references', 'heteronyms.json'),
                 path.join(DIR, 'references', 'heteronyms.json')]) {
  if (fs.existsSync(p)) { try { heteronyms = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) {} }
}

// --- Load narration ---
const narrationPath = path.join(DIR, 'narration.json');
if (!fs.existsSync(narrationPath)) {
  console.error(`ERROR: narration.json not found in ${DIR}`);
  process.exit(2);
}
let narration;
try { narration = JSON.parse(fs.readFileSync(narrationPath, 'utf8')); }
catch (e) { console.error(`ERROR: narration.json is not valid JSON: ${e.message}`); process.exit(2); }
if (!Array.isArray(narration) || narration.length === 0) {
  console.error('ERROR: narration.json must be a non-empty JSON array of strings');
  process.exit(2);
}

const ctx = (s, i, n) => [...s].slice(Math.max(0, i - n), i + n + 1).join('');
let errorCount = 0, warnCount = 0;

console.log(`narration lint — ${DIR}`);
console.log('─'.repeat(56));

narration.forEach((entry, i) => {
  const num = String(i + 1).padStart(2, '0');
  const findings = [];
  const err = m => { findings.push(`  ❌ ERROR ${m}`); errorCount++; };
  const warn = m => { findings.push(`  ⚠ WARN  ${m}`); warnCount++; };
  const info = m => findings.push(`  ℹ INFO  ${m}`);

  if (typeof entry !== 'string') {
    err('entry is not a string');
    console.log(`Slide ${num}`); findings.forEach(f => console.log(f)); return;
  }

  const masked = maskAcronyms(entry);
  const slideHan = hanLen(entry);
  const groups = splitGroups(masked);
  const lens = groups.map(g => hanLen(g.t));

  // E6 / W5 — slide length
  if (slideHan < SLIDE_HARD_MIN) err(`only ${slideHan} Han chars — degenerate entry (min ${SLIDE_HARD_MIN})`);
  else if (slideHan < SLIDE_MIN || slideHan > SLIDE_MAX) warn(`slide has ${slideHan} Han chars (target ${SLIDE_MIN}–${SLIDE_MAX})`);

  // E1 / W1 / W9 — per breath-group
  groups.forEach(g => {
    const w = width(g.t), h = hanLen(g.t);
    if (w > BG_WIDTH_MAX) err(`breath-group width ${w} > ${BG_WIDTH_MAX} (subtitle capSplit WILL cut it mid-word): 「${g.t}」`);
    const sentenceInitial = g.prevDelim === '' || SENT_ENDERS.has(g.prevDelim);
    if (h > 0 && h < BG_HAN_MIN && !sentenceInitial) warn(`breath-group under ${BG_HAN_MIN} Han (${h}) — merge or extend: 「${g.t}」`);
    const chars = [...g.t];
    const last = chars[chars.length - 1];
    if (last === '不') warn(`breath-group ends on 「不」 — tone sandhi breaks across the pause: 「${g.t}」`);
    if (last === '一' && !(chars.length > 1 && YI_SAFE_PREFIX.has(chars[chars.length - 2])))
      warn(`breath-group ends on 「一」 — tone sandhi breaks across the pause: 「${g.t}」`);
  });

  // W2 / W3 — machine-gun and drone runs
  for (const [name, test] of [['machine-gun (≥3 consecutive groups ≤5 Han) — merge them', l => l <= SHORT_BG],
                              [`drone (≥3 consecutive groups ≥${LONG_BG} Han) — vary the rhythm`, l => l >= LONG_BG]]) {
    let run = 0, reported = false;
    for (const l of lens) {
      run = test(l) ? run + 1 : 0;
      if (run >= RUN_LEN && !reported) { warn(name); reported = true; }
    }
  }

  // W4 — sentence length
  masked.split(/[。！？.!?]/).forEach(s => {
    const h = hanLen(s);
    if (h > SENT_MAX) warn(`sentence has ${h} Han chars (max ${SENT_MAX}) — split it: 「${s.trim().slice(0, 20)}…」`);
  });

  // E2 — terminal punctuation
  const lastChar = [...entry.trim()].pop();
  if (!'。！？'.includes(lastChar)) err(`entry must end with 。！？ (got '${lastChar || ''}')`);

  // E3 / W7 — ASCII punctuation (acronym dots already masked)
  const asciiTerm = masked.match(/[.!?]/g);
  if (asciiTerm) err(`ASCII ${[...new Set(asciiTerm)].join(' ')} found — TTS strips it but subtitles SHOW it; use 。！？ or rewrite`);
  const asciiWeak = masked.match(/[,;:]/g);
  if (asciiWeak) warn(`ASCII ${[...new Set(asciiWeak)].join(' ')} found — use full-width 、，；：`);

  // E4 — brackets/quotes
  const brackets = entry.match(BRACKETS);
  if (brackets) err(`brackets/quotes ${[...new Set(brackets)].join(' ')} found — stripped to a dead pause in TTS and dropped from subtitles; rewrite as a plain clause`);

  // W6 — digits
  const digits = entry.match(/[0-9０-９]/g);
  if (digits) warn(`raw digits ${[...new Set(digits)].join('')} — spell out in Chinese; exact figures go on the SLIDE (tts-phrasing.md §畫面分工)`);

  // E5 / W-latin — Latin tokens (a masked acronym counts as one token)
  const latinTokens = masked.match(/[A-Za-z][A-Za-z·]*/g) || [];
  if (latinTokens.length >= 2) err(`${latinTokens.length} English tokens (${latinTokens.join(', ')}) — max 1 per slide; put exact names on the slide`);
  else if (latinTokens.length === 1) warn(`English token '${latinTokens[0]}' adds a forced pause — keep it in its own short group, or move it to the slide`);

  // W8 — connective + comma
  for (const m of entry.matchAll(CONNECTIVES))
    warn(`comma right after connective 「${m[1]}」 — drop it, save the pause for a real boundary`);

  // I — heteronyms: confirmed chars → every occurrence; suspected → known-risky words only
  if (heteronyms && heteronyms.chars) {
    const lines = [];
    for (const [chr, spec] of Object.entries(heteronyms.chars)) {
      if (spec.status === 'confirmed') {
        const chars = [...entry];
        const hits = chars.reduce((a, c, j) => (c === chr ? [...a, j] : a), []);
        if (hits.length) lines.push(`「${chr}」×${hits.length} (${Object.keys(spec.readings).join('/')}) — AVOID: …${ctx(entry, hits[0], 5)}…`);
      } else {
        const risky = Object.keys(spec.rewrites || {}).filter(k => k.length >= 2 && entry.includes(k));
        if (risky.length) lines.push(`「${chr}」 risky words: ${risky.join('、')} — see heteronyms.json rewrites`);
      }
    }
    lines.slice(0, 5).forEach(l => info(`heteronym ${l}`));
  }

  console.log(`Slide ${num}  (Han: ${slideHan})  意群: ${lens.join('|') || '—'}`);
  if (findings.length) findings.forEach(f => console.log(f));
  else console.log('  ✅ clean');
});

console.log('─'.repeat(56));
console.log(`Summary: ${narration.length} slides · ${errorCount} ERROR · ${warnCount} WARN`);
if (errorCount > 0) {
  console.log('RESULT: FAIL — fix all ERRORs before TTS (references/tts-phrasing.md)');
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS (warnings are judgment calls — read them, then decide)');
}
