# 網頁版獨立測試

在 Windows 使用 Chrome 158.0.8127.37 與 Edge 158.0.4370.33 執行 `npm test`。兩個瀏覽器均直接以 `file://` 開啟網頁並完成測試，頁面觀察到的請求僅使用本機檔案或 Blob。測試使用獨立的 JavaScript 合成素材與實際瀏覽器輸出，測試結束後清除暫存目錄。

| 驗證 | 兩個瀏覽器的結果 |
| --- | --- |
| PNG 容器 | 來源 tEXt、zTXt、iTXt、eXIf 可辨識，清理後只剩 IHDR、sRGB、IDAT、IEND |
| JPEG 容器 | 已注入 EXIF、XMP、IPTC、Comment 的圖片重新輸出後無相關元數據標記 |
| WebP 容器 | 已注入 EXIF、XMP 及 VP8X 旗標的圖片重新輸出後無相關區塊或旗標 |
| NovelAI Stealth | Alpha 欄序 gzip 與相容 RGB 列序皆可讀取；輸出已無測試簽名 |
| PNG 畫質 | 中繼資料清除後重新解碼像素一致；未經色彩轉換的透明 PNG 與來源逐 RGBA 樣本一致 |
| 透明度 | 真透明圖清除 Alpha Stealth 時最大差 1，測試 WebP Alpha 重新解碼一致，JPG 已合成白底 |
| JPG／WebP 畫質 | 64 × 48 合成漸層、品質 95，JPG 49.64 dB，WebP 45.95 dB |
| 尺寸與方向 | 等比例縮小；套用 JPEG EXIF 方向後，輸出尺寸正確 |
| 原樣複製 | 位元組完全一致，執行時另比較 SHA-256 |
| 安全處理 | 拒絕截斷 JPG、動態或 16 位元 PNG 的重新編碼，以及不安全 ZIP 路徑 |
| 批次 ZIP | 實際點擊下載，驗證 ZIP CRC 並使用 Windows tar.exe 解壓；保留兩個「晏清徵_日常_01/02.png」，未包含失敗的一張 |

PSNR 數值適用於表中的合成圖片，沒有涵蓋所有照片、編碼器、ICC 色域或作業系統。Safari、Firefox、行動裝置和目標相簿分類尚未實測。

Canvas 編碼及 Alpha 精度規範見 [WHATWG Canvas](https://html.spec.whatwg.org/multipage/canvas.html)。

