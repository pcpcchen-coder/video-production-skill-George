# 投影片版型庫（Path B / HTML）

一組**可直接複製、自成一檔**的 1920×1080 深色投影片版型。每一個都圖文並茂、
字級都在 SKILL.md 的下限之上（正文 ≥32px、標題 ≥72px）、底部留了燒錄字幕的安全區。

> 為什麼有這個資料夾：舊的 `references/slide-template.html` 只有「置中大標題 + 一段
> 置中文字」一種版型，照抄只會做出**字牆**。這裡把每種內容類型各給一個現成版型，
> 讓 agent 有圖可套，而不是把旁白貼成大字。

## 怎麼用

1. 寫完 `narration.json` 後，先幫每一張投影片決定「這張要畫什麼」（見下方對照表）。
2. 從這裡挑對應版型，複製成 `你的專案/slides/slide_01.html`、`slide_02.html`…
3. 每檔開頭的註解說明要改哪幾個地方；把示範內容換成你的內容。
4. 全部改完 → `node scripts/screenshot.js` 截成 PNG → 照 SKILL.md 繼續。

檔名要 `slide_01.html`（兩位數、從 01 開始），`screenshot.js` 會自動抓。

## 內容類型 → 版型 對照表

| 旁白在講的東西 | 用哪個版型 | 檔案 |
|---|---|---|
| 開場（第 1 張） | 大標題 + 一個主視覺 | `layout-title.html` |
| 一個概念 + 一張圖解（**最常用**） | 左文右圖 | `layout-split.html` |
| 一個關鍵數字／比例 | 放大數字 | `layout-bignumber.html` |
| 兩件事對照（前後／對錯／A vs B） | 左右對比 | `layout-compare.html` |
| 有先後順序的步驟／流程 | 流程圖 | `layout-flow.html` |
| 幾個數字比大小 | 誠實長條圖 | `layout-bars.html` |
| 「我實際看了／做了 X」 | 真實截圖嵌入 | `layout-screenshot.html` |
| 發展過程／案例的起源→經過→結局 | 時間軸 | `layout-timeline.html` |
| 結尾（最後一張） | 一句心得 + 主視覺（+ AI 揭露） | `layout-end.html` |

**挑不到版型？** 那通常代表這張投影片其實是「一段旁白貼上去」而已 —— 回頭問自己
「這張要給觀眾看的『那張圖』是什麼」，答不出來就是內容該再想過（見 `visual-design.md`）。

## 共用設計約定（改內容時請維持）

- **配色**：底色深藍漸層；重點強調用品牌紅 `#e94560`；長條圖多色時用已驗證、
  色盲也分得出的組合（藍 `#4a90d9` / 紅 `#e94560`；三色再加黃 `#ffd460`）。
- **字級下限**：正文 ≥32px、小標 ≥36px、主標 ≥72px、關鍵數字盡量放大。
  只有頁碼／浮水印可以小於正文。
- **底部安全區**：內容區的 `padding-bottom` 都留了空間，燒錄字幕（`pad_and_burn.js
  burn`）不會蓋到內容。若你的字幕是外掛 SRT 就沒差。
- **文字預算**：每張最多一個標題 + 3 個短點，或幾個短標籤。長句是旁白的工作，
  不是投影片的。塞不下 = 拆成兩張，不是縮小字級。
- **中文字型**：字型堆疊同時列了 Windows／macOS／Linux 的繁中字型
  （JhengHei / PingFang TC / Noto Sans TC / WenQuanYi Zen Hei），跨平台截圖比較不會變豆腐框。
  在 Linux／CI 上請先裝好 Noto Sans TC（`fonts-noto-cjk`）。

## 想加真實截圖或圖片

`layout-screenshot.html` 示範了怎麼嵌入本機圖片：把畫面存到專案的 `screenshots/`，
`<img>` 用相對路徑指過去即可（Playwright 以 `file://` 載入，相對路徑可行）。這是 Path B
相對 Path A（gpt-image-2 生圖）最大的優勢 —— 生圖做不出「真實畫面」，
但 teaching-style §3 規定「我看了／做了 X」型影片一定要用真截圖。
