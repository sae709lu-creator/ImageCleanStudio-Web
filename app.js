(() => {
  "use strict";
  const studio = ImageStudio;
  const $ = id => document.getElementById(id);
  const rows = [], results = [];
  let running = false, adding = false, cancelled = false, zipBusy = false;
  let resultBytes = 0;
  const LIMIT = 512 * 1024 ** 2;

  function options() {
    return {
      mode: $("mode").value, format: $("format").value, quality: $("quality").value,
      alpha: $("alpha").value, background: $("background").value, maxEdge: $("maxEdge").value,
      naming: $("naming").checked, numbered: $("numbered").checked,
    };
  }

  function tab(id) {
    for (const button of document.querySelectorAll("[data-tab]")) {
      if (button.dataset.tab === id) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const area of document.querySelectorAll(".pane")) area.hidden = area.id !== id;
  }
  for (const button of document.querySelectorAll("[data-tab]")) button.onclick = () => tab(button.dataset.tab);

  function cell(row, text) {
    const td = row.insertCell();
    td.textContent = text || "";
    return td;
  }

  function makeRow(item) {
    const row = $("rows").insertRow();
    item.row = row;
    const select = document.createElement("input");
    select.type = "checkbox";
    select.setAttribute("aria-label", "選取 " + item.file.name);
    select.onchange = () => { item.selected = select.checked; };
    cell(row).append(select);
    item.select = select;
    const name = cell(row);
    name.className = "filecell filename";
    const thumb = document.createElement("img");
    thumb.alt = "";
    thumb.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = item.file.name;
    name.append(thumb, label);
    item.thumb = thumb;
    for (const field of ["group", "scene"]) {
      const td = cell(row);
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute("aria-label", (field === "group" ? "群組 " : "情境 ") + item.file.name);
      input.oninput = () => { item[field] = input.value; item.state = ""; refresh(); };
      td.append(input);
      item[field + "Input"] = input;
    }
    item.nameCell = cell(row);
    item.stateCell = cell(row, "讀取中");
  }

  function refresh() {
    const settings = options();
    const plans = studio.plan(rows, settings);
    let errors = 0;
    for (const [index, item] of rows.entries()) {
      const plan = plans[index];
      item.groupInput.disabled = item.sceneInput.disabled = running || !settings.naming;
      item.nameCell.textContent = plan.filename || "";
      item.stateCell.textContent = item.format || item.error ? plan.error || item.state || "可處理" : "讀取中";
      item.stateCell.classList.toggle("error", Boolean(item.error || item.format && plan.error || item.failed));
      if (plan.error) errors++;
    }
    $("count").textContent = rows.length + " 張圖片";
    $("empty").hidden = rows.length > 0;
    $("start").disabled = !rows.length || running || adding || errors > 0;
    $("remove").disabled = $("add").disabled = $("addFolder").disabled = running || adding;
    $("cancel").disabled = !running || cancelled;
    $("bulk").hidden = !settings.naming;
    $("bulk").disabled = running;
    $("formatRow").hidden = settings.mode !== "convert";
    $("qualityRow").hidden = settings.mode === "copy" ||
      (settings.mode === "convert" && settings.format === "png") ||
      (settings.mode === "clean" && !rows.some(item => ["jpeg", "webp"].includes(item.format)));
    $("qualityValue").value = settings.quality;
    $("alphaRow").hidden = $("backgroundRow").hidden = $("resizeRow").hidden = settings.mode === "copy";
    $("modeNote").textContent = settings.mode === "copy" ? "原樣複製會保留完整元數據。" :
      "輸出會重新讀取並驗證。瀏覽器控制 JPG 色度取樣與 WebP 編碼。";
    return plans;
  }

  async function thumbnail(item) {
    const scale = Math.min(1, 96 / Math.max(item.width, item.height));
    const bitmap = await createImageBitmap(item.file, { resizeWidth: Math.max(1, Math.round(item.width * scale)),
      resizeHeight: Math.max(1, Math.round(item.height * scale)), resizeQuality: "medium" });
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        item.url = URL.createObjectURL(blob);
        item.thumb.src = item.url;
      }
    } finally {
      bitmap.close();
    }
  }

  async function add(files) {
    if (running || adding || !files.length) return;
    adding = true;
    const known = new Set(rows.map(item => item.key));
    const added = [];
    for (const file of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(file.name)) continue;
      const key = [file.webkitRelativePath || file.name, file.size, file.lastModified].join("\0");
      if (known.has(key)) continue;
      known.add(key);
      const item = { file, key, group: "", scene: "", selected: false };
      rows.push(item);
      added.push(item);
      makeRow(item);
    }
    refresh();
    $("status").textContent = "讀取圖片中";
    for (const item of added) {
      try {
        const info = await studio.fileInfo(item.file);
        item.format = info.format;
        item.width = info.width;
        item.height = info.height;
        await thumbnail(item).catch(() => {});
      } catch (error) { item.error = error.message; }
    }
    adding = false;
    refresh();
    $("status").textContent = added.length ? "已加入 " + added.length + " 張圖片。" : "沒有新的支援圖片。";
  }

  for (const [input, button] of [["files", "add"], ["folder", "addFolder"]]) {
    $(button).onclick = () => $(input).click();
    $(input).onchange = () => { add(Array.from($(input).files)); $(input).value = ""; };
  }
  $("drop").onclick = () => $("files").click();
  $("drop").ondragover = event => {
    event.preventDefault();
    if (!running) $("drop").classList.add("is-active");
  };
  $("drop").ondragleave = () => $("drop").classList.remove("is-active");
  $("drop").ondrop = event => {
    event.preventDefault();
    $("drop").classList.remove("is-active");
    add(Array.from(event.dataTransfer.files));
  };
  $("all").onclick = () => {
    const selected = !rows.every(item => item.selected);
    for (const item of rows) item.select.checked = item.selected = selected;
  };
  $("remove").onclick = () => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].selected) continue;
      if (rows[i].url) URL.revokeObjectURL(rows[i].url);
      rows[i].row.remove();
      rows.splice(i, 1);
    }
    refresh();
  };

  function setField(item, field, value) {
    item[field] = item[field + "Input"].value = value;
    item.state = "";
  }
  $("apply").onclick = () => {
    for (const item of rows.filter(item => item.selected)) {
      for (const field of ["group", "scene"]) if ($(field).value) setField(item, field, $(field).value);
    }
    refresh();
  };
  async function paste(field) {
    const chosen = rows.filter(item => item.selected);
    if (!chosen.length) { $("status").textContent = "請先選取圖片。"; return; }
    try {
      const text = await navigator.clipboard.readText();
      const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
      if (lines.length !== chosen.length) throw Error("剪貼簿 " + lines.length + " 行，已選取 " + chosen.length + " 張。");
      chosen.forEach((item, index) => setField(item, field, lines[index]));
      refresh();
    } catch (error) { $("status").textContent = error.message + " 也可直接貼到表格輸入欄。"; }
  }
  $("pasteGroup").onclick = () => paste("group");
  $("pasteScene").onclick = () => paste("scene");
  for (const key of ["mode", "format", "quality", "alpha", "background", "maxEdge", "naming", "numbered"]) {
    $(key).addEventListener("input", refresh);
  }

  function showResult(name, data, error) {
    const row = $("results").insertRow();
    cell(row, name).className = "filename";
    cell(row, data ? data.width + " × " + data.height : "");
    cell(row, error || data.privacy).className = error ? "error" : "success";
    cell(row, data ? [data.quality, ...data.warnings].join(" · ") : "");
    const output = cell(row);
    if (!data) return;
    const url = URL.createObjectURL(data.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = "下載";
    output.append(link);
    results.push({ name, blob: data.blob, url });
  }

  $("start").onclick = async () => {
    const plans = refresh();
    if ($("start").disabled) return;
    for (const result of results) URL.revokeObjectURL(result.url);
    results.length = resultBytes = 0;
    $("results").replaceChildren();
    $("download").disabled = true;
    running = true;
    cancelled = false;
    refresh();
    const settings = options();
    let completed = 0, failed = 0;
    $("progress").max = rows.length;
    $("progress").value = 0;
    for (const [index, item] of rows.entries()) {
      if (cancelled) break;
      const { filename } = plans[index];
      $("status").textContent = "正在處理 " + (index + 1) + " / " + rows.length;
      try {
        const result = await studio.process(item.file, settings);
        if (cancelled) break;
        if (resultBytes + result.blob.size > LIMIT) throw Error("本批輸出超過 512 MiB，請分批處理");
        resultBytes += result.blob.size;
        showResult(filename, result);
        item.state = result.warnings.length ? "通過，有處理提示" : "通過";
        item.failed = false;
      } catch (error) {
        showResult(filename, null, error.message);
        item.state = error.message;
        item.failed = true;
        failed++;
      }
      $("progress").value = ++completed;
      refresh();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    running = false;
    const summary = (cancelled ? "已取消 · " : "處理完成 · ") +
      results.length + " 張可下載，" + failed + " 張失敗";
    $("status").textContent = $("summary").textContent = summary;
    $("download").disabled = !results.length || zipBusy;
    refresh();
    tab("history");
  };
  $("cancel").onclick = () => { cancelled = true; refresh(); };

  async function archive(files) {
    const locals = [], central = [];
    let offset = 0, total = 0;
    const utf8 = new TextEncoder();
    for (const { name, blob } of files) {
      const bytes = utf8.encode(name);
      const hash = ImageFormats.crc(new Uint8Array(await blob.arrayBuffer()));
      const header = new Uint8Array(30 + bytes.length);
      const h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 2048, true);
      h.setUint16(12, 33, true);
      h.setUint32(14, hash, true);
      h.setUint32(18, blob.size, true);
      h.setUint32(22, blob.size, true);
      h.setUint16(26, bytes.length, true);
      header.set(bytes, 30);
      const entry = new Uint8Array(46 + bytes.length);
      const e = new DataView(entry.buffer);
      e.setUint32(0, 0x02014b50, true);
      e.setUint16(4, 20, true);
      entry.set(header.subarray(4, 30), 6);
      e.setUint32(42, offset, true);
      entry.set(bytes, 46);
      locals.push(header, blob);
      central.push(entry);
      offset += header.length + blob.size;
      total += entry.length;
    }
    const final = new Uint8Array(22);
    const end = new DataView(final.buffer);
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, total, true);
    end.setUint32(16, offset, true);
    return new Blob([...locals, ...central, final], { type: "application/zip" });
  }

  $("download").onclick = async () => {
    zipBusy = true;
    $("download").disabled = true;
    try {
      const url = URL.createObjectURL(await archive(results.slice()));
      const link = document.createElement("a");
      link.href = url;
      link.download = "ImageCleanStudio.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { $("summary").textContent = error.message; }
    finally {
      zipBusy = false;
      $("download").disabled = !results.length || running;
    }
  };

  $("inspectFile").onchange = async () => {
    const file = $("inspectFile").files[0];
    if (!file) return;
    $("inspection").textContent = "讀取中";
    try {
      const info = await studio.inspectImage(file);
      $("inspection").textContent = file.name + "\n" + JSON.stringify(info, null, 2);
    } catch (error) { $("inspection").textContent = error.message; }
  };
  $("theme").onclick = () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    $("theme").textContent = light ? "深色主題" : "淺色主題";
  };
  refresh();
})();

