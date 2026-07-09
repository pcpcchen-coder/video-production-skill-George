# Minimal Path B (HTML) demo project

The same 3-slide "什麼是語音辨識" micro-video as `../demo/`, but built the **Path B** way:
hand-written HTML slides screenshotted by Playwright — **no image API needed**, and every
slide is 圖文並茂 (a title visual, a flow diagram, a closing scene), not a text wall.

```
demo-html/
├── narration.json          ← 3 narration entries (one per slide)
├── slides/
│   ├── slide_01.html       ← title layout   (from references/slide-templates/layout-title.html)
│   ├── slide_02.html       ← flow diagram   (from references/slide-templates/layout-flow.html)
│   └── slide_03.html       ← end / closing  (from references/slide-templates/layout-end.html)
└── (config.json)           ← copy from ../../references/config-example.json and fill in
```

Each `slide_NN.html` started life as a copy of a file in `references/slide-templates/` with
the placeholder content swapped for this demo's. That is exactly the intended Path B workflow:
**pick a layout per slide from the library, don't design from scratch.**

To actually produce it (from this directory, keys set):

```bash
cp ../../references/config-example.json config.json   # then set tts.voiceId
node ../../scripts/lint_narration.js                  # 斷句 lint — ERRORs must be zero before TTS
npm i playwright && npx playwright install chromium    # once, if not already installed
node ../../scripts/screenshot.js                      # slides/*.html → slides/*.png
# eyeball every PNG: garbled characters? a picture, or a text wall?
node ../../scripts/tts_with_asr.js                    # → audio/slide_01..03.mp3 (ASR-gated)
node ../../scripts/assemble.js                        # → video.mp4
node ../../scripts/gen_subtitles.js                   # → subtitles_aligned.srt
# (optional external SRT is often better than burn-in for dark full-bleed HTML slides)
```

The alignment law still holds: narration entries == slide count (here: 3 == 3).
For the gpt-image-2 hand-drawn version of the same video, see `../demo/`.
