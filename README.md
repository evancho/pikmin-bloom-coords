# Bloom Pin — Pikmin Bloom 座標工具

上傳 Pikmin Bloom 明信片／地圖截圖 → OCR 讀出地名與地址 → 查詢緯度、經度 → 可編輯後用愛心歸檔。

**手機**：可安裝成主畫面 App（iPhone Safari／Android Chrome），並用「同步檔」在 iOS ↔ Android 共用喜好。

## 座標格式

```text
緯度, 經度
```

例如：`34.700393, 137.783065`

## 本機執行

```bash
npm install
npm run dev
```

## 下載到手機（不是 App Store）

這是 **PWA**（漸進式網頁 App），不用上架，用瀏覽器「加到主畫面」即可；iPhone 與 Android 同一套。

線上網址：

`https://evancho.github.io/pikmin-bloom-coords/`

### iPhone / iPad

1. 用 **Safari** 打開上述網址（不要用 Chrome）
2. 點底部分享 → **加入主畫面** → 新增
3. 主畫面會出現 Bloom Pin 圖示，可全螢幕使用

### Android

1. 用 **Chrome** 打開上述網址
2. 選單 ⋮ → **安裝應用程式**／加到主畫面  
   （或頁面上的「安裝 Bloom Pin」按鈕）

## iPhone ↔ Android 共用愛心歸檔

兩邊各自的瀏覽器資料是分開的，請用同步檔：

1. 在 A 手機打開 Bloom Pin → **匯出同步檔**
2. 把檔案存到 **Google Drive**／檔案 App（或 AirDrop／Nearby Share）
3. 在 B 手機 → **匯入同步檔**（合併更新，不會整份蓋掉）

建議固定一個雲端資料夾放最新的 `bloom-pin-sync-….json`，換機時匯入即可。

## 功能

- 拖曳／點擊／貼上截圖
- 日文＋英文 OCR（Tesseract.js）
- 依地名／地址查座標（可手動修正）
- 儲存／愛心歸檔（本機 IndexedDB）
- 匯出／匯入同步檔（跨裝置喜好）

## 建置

```bash
npm run build
npm run preview
```
