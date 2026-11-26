/* JPEG, PNG and RIFF container inspection. The runtime accepts local files only. */
(() => {
  "use strict";
  const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ascii = (data, offset, length) => String.fromCharCode(...data.subarray(offset, offset + length));
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
    return n;
  });
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = (value >>> 8) ^ table[(value ^ byte) & 255];
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const bytes = new Uint8Array(data.length + 12);
    view(bytes).setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(data, 8);
    view(bytes).setUint32(bytes.length - 4, crc(bytes.subarray(4, -4)));
    return bytes;
  }

  function png(bytes) {
    let at = 8;
    const tags = [], metadata = [], idat = [], text = [];
    const d = view(bytes);
    let width, height, depth, color, interlace, animated = false;
    while (at + 12 <= bytes.length) {
      const length = d.getUint32(at);
      const end = at + 12 + length;
      const tag = ascii(bytes, at + 4, 4);
      if (end > bytes.length || crc(bytes.subarray(at + 4, end - 4)) !== d.getUint32(end - 4)) {
        throw Error("PNG 區塊截斷或 CRC 錯誤");
      }
      const payload = bytes.subarray(at + 8, end - 4);
      tags.push(tag);
      if (at === 8) {
        if (tag !== "IHDR" || length !== 13) throw Error("PNG 缺少有效 IHDR");
        width = d.getUint32(at + 8);
        height = d.getUint32(at + 12);
        [depth, color, , , interlace] = payload.subarray(8);
      }
      if (!["IHDR", "IDAT", "IEND", "PLTE", "tRNS", "sRGB"].includes(tag)) metadata.push(tag);
      if (["tEXt", "zTXt", "iTXt"].includes(tag)) text.push({ tag, payload });
      if (tag === "IDAT") idat.push(payload);
      if (tag === "acTL") animated = true;
      if (tag === "IEND" && length === 0 && idat.length) {
        if (end !== bytes.length) metadata.push("PNG 尾端資料");
        return { format: "png", width, height, depth, color, interlace, animated, tags, metadata, idat, text };
      }
      at = end;
    }
    throw Error("PNG 缺少完整 IEND");
  }

  function jpeg(bytes) {
    let at = 2, width, height;
    const tags = [], metadata = [];
    const d = view(bytes);
    while (at + 1 < bytes.length && bytes[at] === 255) {
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 && width && height) {
        if (at !== bytes.length) metadata.push("JPEG 尾端資料");
        return { format: "jpeg", width, height, tags, metadata, text: [] };
      }
      if (at + 2 > bytes.length) break;
      const length = d.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = d.getUint16(at + 3);
        width = d.getUint16(at + 5);
      }
      if (marker >= 0xe0 && marker <= 0xef || marker === 0xfe) {
        const tag = marker === 0xfe ? "JPEG Comment" : "APP" + (marker - 0xe0);
        tags.push(tag);
        const jfif = marker === 0xe0 && length === 16 && ascii(bytes, at + 2, 5) === "JFIF\0" &&
          bytes[at + 14] === 0 && bytes[at + 15] === 0;
        const icc = marker === 0xe2 && ascii(bytes, at + 2, 12) === "ICC_PROFILE\0";
        if (!jfif && !icc) metadata.push(tag);
      }
      at += length;
      if (marker === 0xda) {
        while (at < bytes.length) {
          if (bytes[at++] !== 255) continue;
          const start = at - 1;
          while (bytes[at] === 255) at++;
          if (bytes[at] === 0 || bytes[at] >= 0xd0 && bytes[at] <= 0xd7) at++;
          else { at = start; break; }
        }
      }
    }
    throw Error("JPEG 標記或掃描資料截斷");
  }

  function webp(bytes) {
    const d = view(bytes);
    if (d.getUint32(4, true) + 8 !== bytes.length) throw Error("WebP RIFF 長度不符");
    let at = 12, width, height, animated = false;
    const tags = [], metadata = [];
    const u24 = pos => bytes[pos] + (bytes[pos + 1] << 8) + (bytes[pos + 2] << 16);
    while (at + 8 <= bytes.length) {
      const tag = ascii(bytes, at, 4);
      const size = d.getUint32(at + 4, true);
      const pos = at + 8;
      at = pos + size + size % 2;
      if (at > bytes.length) throw Error("WebP 區塊截斷");
      tags.push(tag);
      if (!["VP8 ", "VP8L", "VP8X", "ALPH", "ICCP"].includes(tag)) metadata.push(tag);
      if (tag === "VP8X" && size === 10) {
        width = 1 + u24(pos + 4);
        height = 1 + u24(pos + 7);
        animated = !!(bytes[pos] & 2);
        if (bytes[pos] & 12) metadata.push("VP8X 元數據旗標");
      }
      if (!width && tag === "VP8 " && size >= 10) {
        width = d.getUint16(pos + 6, true) & 0x3fff;
        height = d.getUint16(pos + 8, true) & 0x3fff;
      }
      if (!width && tag === "VP8L" && size >= 5 && bytes[pos] === 47) {
        const dimensions = d.getUint32(pos + 1, true);
        width = 1 + (dimensions & 0x3fff);
        height = 1 + ((dimensions >>> 14) & 0x3fff);
      }
      if (["ANIM", "ANMF"].includes(tag)) animated = true;
    }
    if (at !== bytes.length || !width || !height) throw Error("WebP 缺少有效尺寸或結尾");
    return { format: "webp", width, height, animated, tags, metadata, text: [] };
  }

  function inspect(bytes) {
    if (PNG.every((byte, i) => bytes[i] === byte)) return png(bytes);
    if (bytes[0] === 255 && bytes[1] === 216) return jpeg(bytes);
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
    throw Error("僅支援 PNG、JPG 和 WebP 圖片");
  }

  async function inflate(blob, format, limit) {
    const reader = blob.stream().pipeThrough(new DecompressionStream(format)).getReader();
    const parts = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) throw Error("解壓縮大小超過限制");
        parts.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return data;
  }

  function paeth(a, b, c) {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  }

  async function rawPng(info) {
    if (info.depth !== 8 || info.interlace || ![2, 6].includes(info.color)) return null;
    const channels = info.color === 6 ? 4 : 3;
    const stride = info.width * channels;
    const size = (stride + 1) * info.height;
    const stream = await inflate(new Blob(info.idat), "deflate", size);
    if (stream.length !== size) throw Error("PNG 像素資料長度不符");
    const pixels = new Uint8Array(stride * info.height);
    for (let y = 0; y < info.height; y++) {
      const filter = stream[y * (stride + 1)];
      if (filter > 4) throw Error("無效的 PNG 濾波");
      for (let x = 0; x < stride; x++) {
        const pos = y * stride + x;
        const a = x >= channels ? pixels[pos - channels] : 0;
        const b = y ? pixels[pos - stride] : 0;
        const c = y && x >= channels ? pixels[pos - stride - channels] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b :
          filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
        pixels[pos] = stream[y * (stride + 1) + 1 + x] + predictor;
      }
    }
    return { pixels, channels, width: info.width, height: info.height };
  }

  async function encodePng(frame, alpha) {
    const { pixels, width, height } = frame;
    const channels = alpha ? 4 : 3;
    const stride = width * channels;
    const rows = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const start = y * (stride + 1);
      rows[start] = 1;
      for (let x = 0; x < stride; x++) {
        const pos = (y * width + Math.floor(x / channels)) * 4 + x % channels;
        rows[start + 1 + x] = pixels[pos] - (x >= channels ? pixels[pos - 4] : 0);
      }
    }
    const compressed = new Uint8Array(await new Response(new Blob([rows]).stream()
      .pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const header = new Uint8Array(13);
    view(header).setUint32(0, width);
    view(header).setUint32(4, height);
    header[8] = 8;
    header[9] = alpha ? 6 : 2;
    return new Blob([PNG, chunk("IHDR", header), chunk("sRGB", Uint8Array.of(0)),
      chunk("IDAT", compressed), chunk("IEND", new Uint8Array())], { type: "image/png" });
  }

  globalThis.ImageFormats = { inspect, rawPng, encodePng, inflate, chunk, crc };
})();

