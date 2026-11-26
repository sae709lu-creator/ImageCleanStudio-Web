(() => {
  "use strict";
  const F = globalThis.ImageFormats;
  const LIMIT = 2 * 1024 * 1024;
  const STEALTH = new Set(["stealth_pngcomp", "stealth_pnginfo", "stealth_rgbcomp", "stealth_rgbinfo"]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const EXT = { png: "png", jpeg: "jpg", webp: "webp" };

  async function fileInfo(file) {
    if (file.size > 100 * 1024 ** 2) throw Error("檔案超過 100 MiB");
    const info = F.inspect(new Uint8Array(await file.arrayBuffer()));
    if (!info.width || !info.height || info.width * info.height > 20_000_000 ||
        info.width > 16384 || info.height > 16384) throw Error("圖片尺寸超過 2,000 萬像素或單邊 16,384");
    return info;
  }

  async function scan(frame, readPayload = false) {
    const { pixels, width, height, channels = 4 } = frame;
    const matches = [];
    for (const alpha of channels === 4 ? [true, false] : [false]) {
      for (const columns of [true, false]) {
        const stride = alpha ? 1 : 3;
        const capacity = width * height * stride;
        if (capacity < 120) continue;
        let offset = 0;
        function take(length) {
          if (offset + length * 8 > capacity) throw Error("隱寫資料截斷");
          const result = new Uint8Array(length);
          for (let i = 0; i < length; i++) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++, offset++) {
              const p = Math.floor(offset / stride);
              const index = columns ? (p % height) * width + Math.floor(p / height) : p;
              const channel = alpha ? 3 : offset % 3;
              byte = (byte << 1) | (pixels[index * channels + channel] & 1);
            }
            result[i] = byte;
          }
          return result;
        }
        const header = String.fromCharCode(...take(15));
        if (!STEALTH.has(header) || alpha !== header.startsWith("stealth_png")) continue;
        const entry = { alpha, columns, header };
        matches.push(entry);
        if (!readPayload) continue;
        try {
          const bits = new DataView(take(4).buffer).getUint32(0);
          if (bits % 8 || bits <= 0 || bits > LIMIT * 8) throw Error("不合法的長度");
          let data = take(bits / 8);
          if (header.endsWith("comp")) data = await F.inflate(new Blob([data]), "gzip", LIMIT);
          entry.payload = decoder.decode(data);
        } catch (error) {
          entry.error = error.message;
        }
      }
    }
    return matches;
  }

  async function pngText(info) {
    const found = [];
    let remaining = LIMIT;
    for (const { tag, payload } of info.text) {
      try {
        if (payload.length > LIMIT) throw Error("欄位過大");
        const split = payload.indexOf(0);
        if (split < 1) throw Error("缺少欄位名稱");
        const latin = data => Array.from(data, byte => String.fromCharCode(byte)).join("");
        const label = latin(payload.subarray(0, split));
        let value = payload.subarray(split + 1);
        if (tag === "zTXt") {
          if (value[0] !== 0) throw Error("不支援的壓縮方式");
          value = await F.inflate(new Blob([value.subarray(1)]), "deflate", remaining);
        }
        if (tag === "iTXt") {
          const compressed = value[0];
          if (compressed > 1 || value[1] !== 0) throw Error("無效 iTXt");
          const languageEnd = value.indexOf(0, 2);
          const titleEnd = languageEnd < 0 ? -1 : value.indexOf(0, languageEnd + 1);
          if (titleEnd < 0) throw Error("不完整的 iTXt");
          value = value.subarray(titleEnd + 1);
          if (compressed) value = await F.inflate(new Blob([value]), "deflate", remaining);
        }
        remaining -= value.length;
        if (remaining < 0) throw Error("文字總量超過限制");
        found.push({ tag, label, value: tag === "iTXt" ? decoder.decode(value) : latin(value) });
      } catch (error) {
        found.push({ tag, error: error.message });
      }
      if (remaining <= 0 || found.length >= 200) break;
    }
    return found;
  }

  function canvas(width, height) {
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    const context = element.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    if (!context) throw Error("瀏覽器無法建立 sRGB 畫布");
    return { element, context };
  }

  async function decoded(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image", colorSpaceConversion: "default" });
    try {
      const frame = canvas(bitmap.width, bitmap.height);
      frame.context.drawImage(bitmap, 0, 0);
      const pixels = frame.context.getImageData(0, 0, bitmap.width, bitmap.height);
      frame.element.width = 0;
      return pixels;
    } finally {
      bitmap.close();
    }
  }

  async function inspectImage(file) {
    const info = await fileInfo(file);
    let matches = [];
    if (!info.animated && info.depth !== 16) {
      const source = info.format === "png" && await F.rawPng(info);
      const image = source || await decoded(file);
      matches = await scan(source || { ...frameFrom(image) }, true);
    }
    return { format: info.format, width: info.width, height: info.height, tags: info.tags,
      text: await pngText(info), metadata: info.metadata, animated: !!info.animated,
      stealthChecked: !info.animated && info.depth !== 16, stealth: matches };
  }

  function frameFrom(image) {
    return { width: image.width, height: image.height, pixels: image.data };
  }

  function metric(reference, output) {
    if (reference.length !== output.length) throw Error("輸出像素長度不符");
    let sum = 0, alphaMax = 0;
    for (let i = 0; i < reference.length; i += 4) {
      alphaMax = Math.max(alphaMax, Math.abs(reference[i + 3] - output[i + 3]));
      for (let c = 0; c < 3; c++) {
        const delta = (reference[i + c] * reference[i + 3] - output[i + c] * output[i + 3]) / 255;
        sum += delta * delta;
      }
    }
    const mse = sum / (reference.length * 0.75);
    return { psnr: mse ? 10 * Math.log10(65025 / mse) : Infinity, alphaMax };
  }

  function exactPng(raw, expected) {
    const { channels, pixels } = raw;
    for (let i = 0; i < expected.length / 4; i++) {
      for (let c = 0; c < channels; c++) {
        if (expected[i * 4 + c] !== pixels[i * channels + c]) return false;
      }
      if (channels === 3 && expected[i * 4 + 3] !== 255) return false;
    }
    return true;
  }

  function preparePixels(image, matches, options, outputFormat) {
    const { width, height, data } = image;
    const warnings = [];
    let alpha = false, minAlpha = 255;
    const cleanAlpha = matches.some(match => match.alpha);
    const cleanRgb = matches.some(match => !match.alpha);
    const flatten = outputFormat === "jpeg" || options.alpha === "flatten";
    const background = /^#[0-9a-f]{6}$/i.test(options.background || "") ? options.background : "#ffffff";
    const bg = [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16));
    for (let i = 3; i < data.length; i += 4) minAlpha = Math.min(minAlpha, data[i]);
    const opaque = cleanAlpha && minAlpha >= 254 && options.alpha !== "keep" && !flatten;
    if (cleanRgb) warnings.push("已重設 RGB 最低位元");
    if (cleanAlpha && !flatten) warnings.push(opaque ? "已正規化 254–255 Alpha" : "已清理 Alpha 最低位元，最多調整一階");
    if (flatten && minAlpha < 255) warnings.push("已合成透明背景");
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      for (let c = 0; c < 3; c++) {
        if (flatten) data[i + c] = Math.round((data[i + c] * a + bg[c] * (255 - a)) / 255);
        if (cleanRgb) data[i + c] &= 254;
      }
      data[i + 3] = flatten || opaque ? 255 : cleanAlpha ? a >= 254 ? 255 : a & 254 : a;
      if (data[i + 3] !== 255) alpha = true;
    }
    const max = Number(options.maxEdge) || 0;
    if (max > 0 && max < Math.max(width, height)) {
      const source = canvas(width, height);
      source.context.putImageData(image, 0, 0);
      const ratio = max / Math.max(width, height);
      const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
      const target = canvas(w, h);
      target.context.imageSmoothingQuality = "high";
      target.context.drawImage(source.element, 0, 0, w, h);
      image = target.context.getImageData(0, 0, w, h);
      target.element.width = source.element.width = 0;
      warnings.push("已縮小尺寸");
    }
    return { image, alpha, warnings };
  }

  async function sha(blob) {
    if (!globalThis.crypto?.subtle) throw Error("此環境無法驗證 SHA-256");
    return new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  }

  async function process(file, options = {}) {
    const info = await fileInfo(file);
    const format = options.mode === "convert" ? options.format : info.format;
    if (!EXT[format]) throw Error("不支援的輸出格式");
    if (options.mode === "copy") {
      const blob = file.slice();
      const first = await sha(file), second = await sha(blob);
      if (!first.every((value, index) => value === second[index])) throw Error("原樣複製 SHA-256 不符");
      return { blob, format, width: info.width, height: info.height, quality: "SHA-256 與來源一致",
        privacy: "原樣複製，保留來源元數據", warnings: [] };
    }
    if (info.animated) throw Error("動態圖片只能選擇原樣複製");
    if (info.depth === 16) throw Error("16 位元 PNG 只能選擇原樣複製");
    const sourceRaw = info.format === "png" ? await F.rawPng(info) : null;
    let image;
    if (sourceRaw && !info.tags.some(tag => ["iCCP", "gAMA", "cHRM", "cICP", "eXIf", "tRNS"].includes(tag))) {
      const rgba = new Uint8ClampedArray(info.width * info.height * 4);
      for (let i = 0; i < rgba.length / 4; i++) {
        const offset = i * sourceRaw.channels;
        const dest = i * 4;
        rgba[dest] = sourceRaw.pixels[offset];
        rgba[dest + 1] = sourceRaw.pixels[offset + 1];
        rgba[dest + 2] = sourceRaw.pixels[offset + 2];
        rgba[dest + 3] = sourceRaw.channels === 4 ? sourceRaw.pixels[offset + 3] : 255;
      }
      image = new ImageData(rgba, info.width, info.height);
    } else {
      image = await decoded(file);
    }
    const matches = await scan(sourceRaw || frameFrom(image));
    const prepared = preparePixels(image, matches, options, format);
    const expected = prepared.image;
    let blob;
    if (format === "png") {
      blob = await F.encodePng(frameFrom(expected), prepared.alpha);
    } else {
      const stage = canvas(expected.width, expected.height);
      stage.context.putImageData(expected, 0, 0);
      const quality = Math.min(1, Math.max(0.01, Number(options.quality ?? 95) / 100));
      blob = await new Promise(resolve => stage.element.toBlob(resolve, "image/" + format, quality));
      stage.element.width = 0;
      if (!blob) throw Error("瀏覽器編碼失敗");
    }
    const output = await fileInfo(blob);
    if (output.format !== format || output.width !== expected.width || output.height !== expected.height) {
      throw Error("實際輸出格式或尺寸與設定不符");
    }
    if (output.metadata.length) throw Error("輸出仍有非預期區塊：" + output.metadata.join("、"));
    const reopened = await decoded(blob);
    if (reopened.width !== expected.width || reopened.height !== expected.height) throw Error("重新解碼尺寸不符");
    const raw = format === "png" ? await F.rawPng(output) : null;
    if ((await scan(raw || frameFrom(reopened))).length) throw Error("輸出仍有已知 Stealth 簽名");
    const stats = metric(expected.data, reopened.data);
    if (format === "png" && (!raw || !exactPng(raw, expected.data))) throw Error("PNG 重新解碼的原始像素不符");
    if (stats.alphaMax !== 0) throw Error("輸出透明度與預期不符");
    if (info.format === "png" && !sourceRaw) prepared.warnings.push("來源 PNG 隱寫由瀏覽器解碼像素檢查");
    return { blob, format, width: output.width, height: output.height, ...stats, warnings: prepared.warnings,
      quality: format === "png" ? "PNG 編碼前後像素一致" :
        Number.isFinite(stats.psnr) ? "有損編碼 · PSNR " + stats.psnr.toFixed(2) + " dB" : "有損格式 · 此圖解碼像素一致",
      privacy: "未偵測到已知生成元數據。" };
  }

  function filenameError(value, allowUnderscore = false) {
    if (!value.trim()) return "群組及情境皆必填";
    if ((!allowUnderscore && value.includes("_")) || /[<>:"/\\|?*\u0000-\u001f]/u.test(value)) return "含額外底線或 Windows 禁用字元";
    if (/[ .]$/u.test(value) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)/iu.test(value)) {
      return "Windows 保留名稱或結尾字元";
    }
    return "";
  }

  function plan(items, options) {
    const values = items.map(item => {
      const format = options.mode === "convert" ? options.format : item.format;
      if (!EXT[format]) return { error: item.error || "尚未讀取格式" };
      const ext = options.mode !== "convert" && format === "jpeg" && /\.jpeg$/i.test(item.file.name) ? "jpeg" : EXT[format];
      const stem = options.naming ? item.group + "_" + item.scene : item.file.name.replace(/\.[^.]+$/, "");
      const error = item.error || (options.naming ? filenameError(item.group) || filenameError(item.scene)
        : filenameError(stem, true));
      return { stem, ext, error, key: (stem + "." + ext).toLowerCase() };
    });
    const totals = new Map();
    for (const value of values) if (!value.error) totals.set(value.key, (totals.get(value.key) || 0) + 1);
    const reserved = new Set([...totals].filter(([, n]) => n === 1).map(([key]) => key));
    const used = new Map();
    return values.map(value => {
      if (value.error) return value;
      const { stem, ext, key } = value;
      if (totals.get(key) > 1 && !options.numbered) return { error: "批次內檔名衝突" };
      let filename = stem + "." + ext;
      if (totals.get(key) > 1) {
        let next = used.get(key) || 0;
        do { filename = stem + "_" + String(++next).padStart(2, "0") + "." + ext; }
        while (reserved.has(filename.toLowerCase()));
        reserved.add(filename.toLowerCase());
        used.set(key, next);
      }
      return filename.length > 255 ? { error: "檔名超過 Windows 長度限制" } : { filename };
    });
  }

  globalThis.ImageStudio = { fileInfo, inspectImage, process, plan, scan, metric, decoded };
})();

