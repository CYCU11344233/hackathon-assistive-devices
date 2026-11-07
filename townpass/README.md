# 台北通（TownPass）要改的地方

這個服務跑在台北通 App 的 WebView 裡。官方 TownPass 原始碼要改 4 個檔案，改好的內容都在 `aid-helper.patch`：

1. 「服務」頁加一個「輔具借用」入口，網址設為 `http://localhost:5173/`，並放在常用服務第一格。
2. 只允許 localhost 用 http 明文連線（`network_security_config.xml`）。
3. 補上網路權限，以及開啟 https 網址和 `geo:` 連結時需要的 `<queries>`。

## 怎麼套用
```bash
git clone https://github.com/taipei-doit/TownPass.git
cd TownPass
git apply path/to/aid-helper.patch
```
編譯 TownPass 的方法請看它自己的 README（Flutter 3.47.6）。
