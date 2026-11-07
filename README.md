# 輔具借用小幫手（台北通微服務）

臺北市二手輔具在官方網站預約。這個微服務處理官方網站沒有做的部分：

- **取貨期限：** 依「預約後 2 天內（含當日）」和各中心的開館時間，算出最晚取貨時間。預約後沒有可取貨時段時會警告，例如週日預約合宜或西區中心。
- **中心比較：** 顯示現在有沒有開、如果現在預約最晚何時取貨，以及距離；可以撥號、導航，也有入口提示。
- **借用紀錄：** 記錄取貨、到期、續借（限 1 次）和歸還。
- **到期提醒：** 到期前 14、7、1 天和當天提醒。到期日剛好休館時，提醒前一個開館日就要送回。
- **停權提醒：** 逾期歸還時，算出停權到哪一天。
- **檢查清單：** 出門取貨和歸還前各有一份檢查清單。
- **其他狀況：** 戶籍不在臺北市時導向 1966；爬梯機導向評估預約。
- **示範模式：** 可以固定時間，並一鍵載入 Demo 情境。

## 執行
不需要安裝套件，只需要 Node.js 18 以上。

```bash
node serve.mjs        # http://localhost:5173，監聽 0.0.0.0；含 /api/stock 庫存 API
node --test           # 規則引擎測試（12 項）
```

網頁在 `web/` 資料夾。即時庫存需要 `serve.mjs`（它負責爬官網，瀏覽器不能直接跨網域抓）；只放靜態空間（例如 GitHub Pages）時，App 會自動退回沒有庫存資訊的版本。

## 結構
| 檔案 | 內容 |
|---|---|
| `web/js/rules.js` | 規則引擎：開放時間、取貨期限、到期、停權和提醒。全部是純函式 |
| `web/js/data.js` | 3 個中心、可借項目、官方連結、檢查清單，並註明出處 |
| `web/js/bridge.js` | 台北通 WebView 橋接；不在 App 內時改用瀏覽器原生功能 |
| `web/js/app.js` | 畫面與路由（hash router），資料存在 localStorage |
| `tests/rules.test.mjs` | 測試情境 |

## 台北通橋接（已對照官方原始碼）
協定來自 `taipei-doit/TownPass` 的 `lib/util/web_message_handler/*.dart`：

- **網頁傳給 App：** `window.flutterObject.postMessage(JSON.stringify({ name, data }))`
- **App 回傳給網頁：** `flutterObject` 會收到 `message` 事件，`event.data` 是 `{ name, data }` 的 JSON 字串。

| 功能 | name | data |
|---|---|---|
| 定位 | `location` | 回傳 geolocator `Position.toJson()`（`latitude`、`longitude`），失敗時回傳 `[]` |
| 撥號 | `phone_call` | 電話號碼字串 |
| 導航 | `launch_map` | 網址字串（目前用 OpenStreetMap 路線網址） |
| 開官方網站 | `open_link` | 網址字串 |
| 通知 | `notify` | `{ title, content }`；只能立即通知，不能排程 |

**注意：**
- **通知內容：** 不能含「已訂閱…」或「已取消訂閱…」，否則 App 會當成訂閱指令。`bridge.js` 已經自動過濾。
- **提醒時機：** `notify` 不能排程，所以提醒是在每次打開服務時檢查並發出。
- **驗證範圍：** 我在瀏覽器裡用模擬的 `flutterObject` 測過訊息格式，但還沒在真的台北通 App 裡測。

## 交接給手機 session 的待辦事項
1. **載入服務：** 讓台北通 App 載入這個服務。可以加一個微服務入口指向網址，或在開發時直接改 WebView 的起始網址。
2. **連到電腦：** USB 連手機時可以用 `adb reverse tcp:5173 tcp:5173`，讓手機用 `http://localhost:5173` 連到電腦。要注意 Android 預設會擋 http 明文連線。
3. **真機測試：** 實際測撥號、導航、定位權限、通知，以及 localStorage 在 WebView 裡能不能保存。
4. **Demo 流程：** 先進「示範模式」，再按「載入示範情境」。

## 資料來源
- [臺北市二手輔具資源提供單位](https://data.gov.tw/dataset/135817)（臺北市政府社會局，政府資料開放授權條款第 1 版）
- [二手輔具借用須知](https://tpap.taipei/app37/rentView/intaipei)
- [臺北市輔具資源整合資訊網 二手輔具借用](https://tpap.taipei/app37/rentView/additem)：即時庫存、款式、各中心數量、等待人數。由 `server/stock.mjs` 爬取（經主辦單位同意），`serve.mjs` 的 `/api/stock` 快取 10 分鐘；爬不到時用 `data/stock-snapshot.json` 快照
- [中華民國政府行政機關辦公日曆表](https://data.gov.tw/dataset/14718)（行政院人事行政總處，政府資料開放授權條款第 1 版）：國定假日休館。原始 CSV 在 `data/`，`web/js/holidays.js` 由它產生
- 座標：OpenStreetMap Nominatim（© OpenStreetMap contributors，ODbL）

## 授權
AGPL-3.0（比賽規定），全文在 `LICENSE`。
