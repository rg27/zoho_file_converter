/* ---------------------------------------------------------------
   File Converter and Compressor (Zoho CRM Web Tab, no record needed)

   Images (JPG, PNG, WebP): converted and resized in the browser. Files never leave the computer.
   PDFs: sent to a Deluge function that calls Zoho PDF Editor "Compress PDF".
         The function must return JSON, for example:
         { "status": "success", "new_size": 123456, "download_url": "https://..." }
         or { "status": "error", "message": "..." }
   Input to the function (inside the single "arguments" string parameter):
         { file_id, file_name, level: "low" | "recommended" | "extreme" }
--------------------------------------------------------------- */
const MAX_FILE_MB = 40, MAX_FILES = 50;
const IMG_EXT = ["jpg", "jpeg", "png", "webp"];
const ALLOWED_EXT = [...IMG_EXT, "pdf"];
const PDF_FUNCTION = "compress_pdf_widget";
const IMAGE_FUNCTION = "pdf_to_image_widget";
const MERGE_FUNCTION = "pdf_merge_widget";
const PAGES_FUNCTION = "pdf_pages_widget";   // PDF pages to JPG/PNG, saved in WorkDrive
const LEVELS = ["low", "recommended", "extreme"];
const PRESETS = { low: { q: .85, s: 1 }, recommended: { q: .7, s: .85 }, extreme: { q: .45, s: .6 } };
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

let files = [], outputs = [], nextId = 1, busy = false, greeted = false;
let tool = "convert", pgAction = "delete";
const st = { fmt: "keep", mode: "preset", level: "recommended" };
const $ = (id) => document.getElementById(id);

const WARN = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>';
const CLOSE = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
const OKI = '<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#10b981" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';

/* ---------- Helpers ---------- */
const getExt = (n) => (n.includes(".") ? n.split(".").pop().toLowerCase() : "");
const stem = (n) => n.replace(/\.[^.]+$/, "");
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeParse = (t) => { try { return JSON.parse(String(t).trim()); } catch (e) { return null; } };
const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;

function showToast(msg, type = "success", ms = 4000) {
  $("app-toast")?.remove();
  const t = document.createElement("div");
  t.id = "app-toast"; t.className = type;
  t.innerHTML = `<span class="toast-title">${type === "success" ? "Success" : "Action Required"}</span><span class="toast-text">${esc(msg)}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- Image processing (browser only) ---------- */
async function encode(bmp, scale, q, type) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const x = c.getContext("2d");
  if (type === "image/jpeg") { x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(bmp, 0, 0, c.width, c.height);
  const b = await new Promise(r => c.toBlob(r, type, q));
  b.w = c.width; b.h = c.height;
  return b;
}

function targetBytes() {
  const v = parseFloat($("t-val").value) || 0;
  return Math.round(v * ($("t-unit").value === "MB" ? 1048576 : 1024));
}

function outType(file) {
  if (st.fmt === "jpg" || st.fmt === "pdf") return "image/jpeg";
  if (st.fmt === "png") return "image/png";
  return file.type === "image/jpg" ? "image/jpeg" : (file.type || "image/jpeg");
}

async function processImage(item) {
  const file = item.file, type = outType(file), lossy = type !== "image/png";
  const bmp = await createImageBitmap(file);
  let blob;

  if (st.mode === "preset") {
    const p = PRESETS[st.level];
    blob = await encode(bmp, p.s, lossy ? p.q : 1, type);
  } else if (st.mode === "scale") {
    const s = +$("s-val").value / 100;
    blob = await encode(bmp, s, s > 1 ? .95 : .8, type);
  } else {
    const T = targetBytes();
    if (T < 1024) throw new Error("Enter a target size of at least 1 KB.");
    if (T >= file.size) {                       // enlarge towards the target
      let s = 1; blob = await encode(bmp, s, .95, type);
      while (blob.size < T && s < 4) { s *= 1.15; blob = await encode(bmp, s, .95, type); }
    } else {                                    // shrink towards the target
      let s = 1;
      for (let i = 0; i < 8 && !blob; i++) {
        if (lossy) {
          let lo = .1, hi = .95, best = null;
          for (let j = 0; j < 7; j++) {
            const m = (lo + hi) / 2, b = await encode(bmp, s, m, type);
            if (b.size <= T) { best = b; lo = m; } else hi = m;
          }
          blob = best;
        } else {
          const b = await encode(bmp, s, 1, type);
          if (b.size <= T) blob = b;
        }
        s *= .8;
      }
      if (!blob) { blob = await encode(bmp, s, .1, type); item.note = "Closest possible size"; }
      else if (!lossy) item.note = "PNG shrinks by dimensions only";
    }
  }

  const shrinking = st.mode === "preset" || (st.mode === "scale" && +$("s-val").value <= 100);
  let ext = st.fmt === "keep" ? getExt(file.name) : (st.fmt === "pdf" ? "pdf" : st.fmt);
  if (shrinking && st.fmt === "keep" && blob.size >= file.size) {
    blob = file; item.note = "Already optimized, original kept";
  } else if (st.fmt === "pdf") {
    blob = await jpegToPdf(blob);
  }
  item.out = { blob, name: `${stem(file.name)}-${st.fmt === "keep" ? "compressed" : "converted"}.${ext}` };
  item.newSize = blob.size;
}

/* Minimal PDF writer: one JPEG per page, no library needed */
async function jpegToPdf(jpg) {
  const data = new Uint8Array(await jpg.arrayBuffer()), w = jpg.w, h = jpg.h;
  const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
  const add = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; add(`${n} 0 obj\n`); body.forEach(p => add(p)); add("\nendobj\n"); };
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  add("%PDF-1.4\n");
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  obj(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`]);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`, data, "\nendstream"]);
  obj(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
  const xr = len; let x = "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++) x += String(offs[n]).padStart(10, "0") + " 00000 n \n";
  add(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`);
  return new Blob(parts, { type: "application/pdf" });
}

/* ---------- PDF processing (Zoho PDF Editor through Deluge) ---------- */
function findFileId(node, d = 0) {
  if (!node || d > 6) return null;
  if (typeof node === "string") { const p = safeParse(node); return p ? findFileId(p, d + 1) : null; }
  if (Array.isArray(node)) { for (const i of node) { const r = findFileId(i, d + 1); if (r) return r; } return null; }
  if (typeof node === "object") {
    if (typeof node.code === "string" && /error|invalid|fail/i.test(node.code)) return null;
    for (const k of ["id", "file_id", "File_Id", "fileId"]) if (typeof node[k] === "string" && node[k].length > 8) return node[k];
    for (const v of Object.values(node)) { const r = findFileId(v, d + 1); if (r) return r; }
  }
  return null;
}

async function uploadToStorage(file) {
  const tries = [
    () => ({ CONTENT_TYPE: "multipart", PARTS: [{ headers: { "Content-Disposition": "file;" } }], FILE: { fileParam: "file", file } }),
    () => ({ File: { Name: file.name, Content: file } })
  ];
  for (const build of tries) {
    try { const id = findFileId(await ZOHO.CRM.API.uploadFile(build())); if (id) return id; }
    catch (e) { console.warn("uploadFile attempt failed:", e); }
  }
  throw new Error("The PDF could not be prepared for upload.");
}

async function callPdfFunction(fileId, name, level) {
  const payload = { file_id: fileId, file_name: name, level };
  const res = await ZOHO.CRM.FUNCTIONS.execute(PDF_FUNCTION, { arguments: JSON.stringify({ arguments: JSON.stringify(payload) }) });
  console.log("PDF function result:", JSON.stringify(res, null, 2));
  if (res?.code && res.code !== "success") throw new Error(`CRM returned ${res.code}: ${res.message || "no message"}`);
  let out = res?.details?.output;
  if (typeof out === "string") out = safeParse(out);
  if (!out || out.status !== "success") throw new Error(out?.message || "The PDF function returned no result.");
  return out;
}

/* Calls a Deluge function and returns its parsed JSON output */
async function callFn(name, payload) {
  const res = await ZOHO.CRM.FUNCTIONS.execute(name, { arguments: JSON.stringify({ arguments: JSON.stringify(payload) }) });
  console.log(name, "result:", JSON.stringify(res, null, 2));
  if (res?.code && res.code !== "success") throw new Error(`CRM returned ${res.code}: ${res.message || "no message"}`);
  let out = res?.details?.output;
  if (typeof out === "string") out = safeParse(out);
  if (!out || out.status !== "success") throw new Error(out?.message || "The function returned no result.");
  return out;
}

/* Reads a file the Deluge function stored in CRM file storage, back into the browser */
async function fetchCrmFile(id) {
  const r = await ZOHO.CRM.API.getFile({ id });
  console.log("getFile result for", id, r);
  if (r instanceof Blob) return r;
  if (r instanceof ArrayBuffer) return new Blob([r]);
  if (r && typeof r.blob === "function") return await r.blob();
  if (r && r.data instanceof Blob) return r.data;
  throw new Error("The file could not be read back from CRM.");
}

/* PDF to JPG/PNG: Zoho PDF Editor makes one image per page, and the widget brings them back for download */
async function pdfToImages(item) {
  item.stage = "Uploading PDF..."; render();
  const fileId = await uploadToStorage(item.file);
  item.stage = `Converting pages to ${st.fmt.toUpperCase()}...`; render();
  const out = await callFn(IMAGE_FUNCTION, { file_id: fileId, file_name: item.file.name, format: st.fmt === "jpg" ? "jpeg" : "png", pages: $("pg-range").value.trim() || "1-" });
  const got = [];
  try {
    for (const f of out.files) {
      item.stage = `Downloading page ${got.length + 1} of ${out.files.length}...`; render();
      got.push({ blob: await fetchCrmFile(f.file_id), name: f.name });
    }
    outputs.push(...got);
    item.pages = got.length;
    item.newSize = got.reduce((n, g) => n + g.blob.size, 0);
  } catch (e) {
    console.warn("Direct download failed, showing links instead:", e);
    item.links = out.files;
  }
}

async function processPdf(item) {
  if (st.fmt === "jpg" || st.fmt === "png") return pdfToImages(item);
  item.stage = "Uploading PDF...";  render();
  const fileId = await uploadToStorage(item.file);
  let levels = [st.level];
  if (st.mode === "target") levels = LEVELS;
  if (st.mode === "scale") { const s = +$("s-val").value; levels = [s >= 90 ? "low" : s >= 60 ? "recommended" : "extreme"]; }

  const T = st.mode === "target" ? targetBytes() : 0;
  let out = null, blob = null;
  for (const lvl of levels) {
    item.stage = `Compressing (${lvl})...`; render();
    out = await callPdfFunction(fileId, item.file.name, lvl);
    item.stage = "Downloading result..."; render();
    try { blob = await fetchCrmFile(out.file_id); }
    catch (e) { console.warn("Direct download failed, using the link:", e); blob = null; break; }
    if (!T || blob.size <= T) break;
  }
  if (!blob) {                       // fallback: WorkDrive link only
    item.newSize = out.new_size || item.file.size;
    item.out = { url: out.download_url, name: `${stem(item.file.name)}-compressed.pdf` };
    item.note = "Direct download failed, use the link";
    return;
  }
  if (T && blob.size > T) item.note = "Closest possible size";
  if (blob.size >= item.file.size) { blob = item.file; item.note = "Already optimized, original kept"; }
  item.newSize = blob.size;
  item.out = { blob, name: `${stem(item.file.name)}-compressed.pdf` };
}

/* ---------- ZIP (store only, no library) ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u) => { let c = -1; for (const b of u) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (~c) >>> 0; };

async function makeZip(list) {
  const enc = new TextEncoder(), chunks = [], central = []; let off = 0, cs = 0;
  for (const f of list) {
    const d = new Uint8Array(await f.blob.arrayBuffer()), n = enc.encode(f.name), crc = crc32(d);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, n.length, true);
    chunks.push(lh, n, d);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, n.length, true); ch.setUint32(42, off, true);
    central.push(ch, n); cs += 46 + n.length; off += 30 + n.length + d.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, list.length, true); end.setUint16(10, list.length, true);
  end.setUint32(12, cs, true); end.setUint32(16, off, true);
  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function downloadResults() {
  const list = [...files.filter(f => f.out?.blob).map(f => f.out), ...outputs];
  if (!list.length) return;
  if (list.length === 1) return saveBlob(list[0].blob, list[0].name);
  const seen = {};
  const named = list.map(o => { seen[o.name] = (seen[o.name] || 0) + 1; return { blob: o.blob, name: seen[o.name] > 1 ? o.name.replace(/(\.[^.]+)$/, `-${seen[o.name]}$1`) : o.name }; });
  saveBlob(await makeZip(named), "processed-files.zip");
}

/* ---------- Rendering ---------- */
function render() {
  $("file-list").innerHTML = files.map(it => {
    const ext = getExt(it.file.name);
    const saved = it.newSize !== undefined ? Math.round((1 - it.newSize / it.file.size) * 100) : 0;
    const link = it.out?.url ? ` · <a href="${esc(it.out.url)}" target="_blank" rel="noopener">Open file</a>` : "";
    const meta = it.status === "working" ? esc(it.stage || "Processing...")
      : it.status === "done" && it.msg ? esc(it.msg)
      : it.status === "done" && it.pages ? `${it.pages} page ${it.pages === 1 ? "image" : "images"} ready · ${fmtSize(it.newSize)}`
      : it.status === "done" && it.links ? `${it.links.length} page ${it.links.length === 1 ? "image" : "images"} saved to WorkDrive · ` + it.links.map((l, i) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">Page ${i + 1}</a>`).join(" · ")
      : it.status === "done" ? `${fmtSize(it.file.size)} → ${fmtSize(it.newSize)} (${saved >= 0 ? "-" + saved : "+" + Math.abs(saved)}%)${it.note ? " · " + esc(it.note) : ""}${link}`
      : it.status === "error" ? esc(it.error) : fmtSize(it.file.size);
    const state = it.status === "working" ? '<div class="file-spinner"></div>' : it.status === "done" ? OKI : "";
    const mv = tool === "merge" && it.status === "pending" ? `<button type="button" class="file-remove" data-move="${it.id}:-1" aria-label="Move up">▲</button><button type="button" class="file-remove" data-move="${it.id}:1" aria-label="Move down">▼</button>` : "";
    const rm = it.status === "working" ? "" : `<button type="button" class="file-remove" data-remove="${it.id}" aria-label="Remove">${CLOSE}</button>`;
    return `<li class="file-item is-${it.status}"><div class="file-badge ${ext === "pdf" ? "pdf" : "image"}">${esc(ext)}</div>
      <div class="file-info"><p class="file-name" title="${esc(it.file.name)}">${esc(it.file.name)}</p><p class="file-meta">${meta}</p></div>
      ${state}${mv}${rm}<div class="file-bar"></div></li>`;
  }).join("");
  const total = files.reduce((n, f) => n + f.file.size, 0);
  $("file-summary").classList.toggle("hidden", !files.length);
  $("file-count").textContent = `${files.length} ${files.length === 1 ? "file" : "files"} · ${fmtSize(total)}`;
  $("clear-all").classList.toggle("hidden", busy);
  $("dropzone").classList.toggle("disabled", busy);
  $("run-btn").disabled = busy;
  $("download-btn").hidden = !(files.some(f => f.out?.blob) || outputs.length);
}

function setError(msg) {
  $("dropzone").classList.add("input-error");
  const e = $("files-error"); e.innerHTML = `${WARN}<span>${esc(msg)}</span>`; e.classList.remove("hidden");
}
function clearError() { $("dropzone").classList.remove("input-error"); $("files-error").classList.add("hidden"); }

function addFiles(list) {
  if (busy) return;
  const problems = [];
  [...list].forEach(file => {
    const ext = getExt(file.name);
    if (!(tool === "convert" ? ALLOWED_EXT : ["pdf"]).includes(ext)) problems.push(`${file.name}: .${ext || "unknown"} is not supported.`);
    else if (!file.size) problems.push(`${file.name}: the file is empty.`);
    else if (file.size > MAX_FILE_MB * 1048576) problems.push(`${file.name}: larger than ${MAX_FILE_MB} MB.`);
    else if (files.some(f => f.file.name === file.name && f.file.size === file.size)) problems.push(`${file.name}: already added.`);
    else if (files.length >= MAX_FILES) problems.push(`${file.name}: up to ${MAX_FILES} files at a time.`);
    else files.push({ id: nextId++, file, status: "pending" });
  });
  problems.length ? setError(problems.join("\n")) : clearError();
  render();
}

/* ---------- Merge and Pages tools ---------- */
async function runMerge() {
  if (files.length < 2) return setError("Add at least two PDF files to merge.");
  clearError(); busy = true; render();
  try {
    const ids = [];
    for (const it of files) { it.status = "working"; it.stage = "Uploading..."; render(); ids.push(await uploadToStorage(it.file)); }
    files.forEach(it => { it.stage = "Merging..."; }); render();
    const out = await callFn(MERGE_FUNCTION, { file_ids: ids.join(","), name: $("m-name").value.trim() || "merged" });
    const blob = await fetchCrmFile(out.file_id);
    outputs = [{ blob, name: out.name || "merged.pdf" }];
    files.forEach(it => { it.status = "done"; it.msg = `Merged into ${outputs[0].name} (${fmtSize(blob.size)})`; });
    showToast("The PDFs are merged. Select Download results.");
  } catch (err) {
    console.error(err);
    files.forEach(it => { if (it.status === "working") { it.status = "error"; it.error = err?.message || "Merge failed."; } });
    showToast("The merge failed. Check the message on the files.", "error");
  }
  busy = false; render();
}

async function runPages() {
  const range = $("pg-val").value.trim();
  if (!range) return setError("Enter the pages, for example 1,3-5.");
  const queue = files.filter(f => f.status !== "done");
  if (!queue.length) return setError(files.length ? "All files are already processed." : "Add at least one PDF.");
  clearError(); busy = true; render();
  for (const it of queue) {
    it.status = "working"; it.stage = "Uploading..."; render();
    try {
      const id = await uploadToStorage(it.file);
      it.stage = pgAction === "delete" ? "Deleting pages..." : "Extracting pages..."; render();
      const out = await callFn(PAGES_FUNCTION, { file_id: id, file_name: it.file.name, action: pgAction, pages: range });
      const blob = await fetchCrmFile(out.file_id);
      outputs.push({ blob, name: out.name || `${stem(it.file.name)}-edited.pdf` });
      it.msg = `${pgAction === "delete" ? "Pages deleted" : "Pages extracted"} · ${fmtSize(blob.size)}`;
      it.status = "done";
    } catch (err) { console.error(err); it.status = "error"; it.error = err?.message || "Failed."; }
    render();
  }
  busy = false; render();
  const failed = files.filter(f => f.status === "error").length;
  failed ? showToast(`${failed} ${failed === 1 ? "file" : "files"} failed.`, "error") : showToast("Done. Select Download results.");
}

function setTool(t) {
  tool = t; files = []; outputs = []; clearError();
  ["convert", "merge", "pages"].forEach(x => $("tab-" + x).classList.toggle("hidden", x !== t));
  $("run-label").textContent = { convert: "Process files", merge: "Merge PDFs", pages: "Apply to PDFs" }[t];
  $("dz-hint").textContent = t === "convert"
    ? `${ALLOWED_EXT.map(x => x.toUpperCase()).join(", ")} · up to ${MAX_FILE_MB} MB each · max ${MAX_FILES} files`
    : `PDF only · up to ${MAX_FILE_MB} MB each · max ${MAX_FILES} files`;
  render();
}

/* ---------- Run ---------- */
async function run(e) {
  e.preventDefault();
  if (busy) return;
  if (tool === "merge") return runMerge();
  if (tool === "pages") return runPages();
  const queue = files.filter(f => f.status !== "done");
  if (!queue.length) return setError(files.length ? "All files are already processed." : "Add at least one file.");
  clearError(); busy = true; render();
  for (const it of queue) {
    it.status = "working"; it.stage = "Processing..."; it.note = ""; it.out = null; it.links = null; it.pages = 0; render();
    try { await (getExt(it.file.name) === "pdf" ? processPdf(it) : processImage(it)); it.status = "done"; }
    catch (err) { console.error(err); it.status = "error"; it.error = err?.message || "Processing failed."; }
    render();
  }
  busy = false; render();
  const failed = files.filter(f => f.status === "error").length;
  failed ? showToast(`${failed} ${failed === 1 ? "file" : "files"} failed. Remove it or try other settings.`, "error")
         : showToast("All files are ready. Select Download results.");
}

/* ---------- Setup ---------- */
function pick(segId, attr, cb) {
  $(segId).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || busy) return;
    $(segId).querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    cb(b.dataset[attr]);
  });
}
function resetResults() { outputs = []; files.forEach(f => { if (f.status !== "working") { f.status = "pending"; f.msg = ""; f.pages = 0; f.out = null; f.links = null; f.newSize = undefined; } }); render(); }

function updateMode() {
  ["preset", "target", "scale"].forEach(m => $("p-" + m).classList.toggle("hidden", m !== st.mode));
  $("mode-hint").textContent = {
    preset: "Low keeps the best quality. Extreme gives the smallest file.",
    target: "Aims for this size. A value above the original size enlarges the file.",
    scale: "Below 100% shrinks the file. Above 100% enlarges dimensions and quality."
  }[st.mode];
}

function setup() {
  $("dz-hint").textContent = `${ALLOWED_EXT.map(x => x.toUpperCase()).join(", ")} · up to ${MAX_FILE_MB} MB each · max ${MAX_FILES} files`;
  const dz = $("dropzone"), input = $("file-input");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(v => dz.addEventListener(v, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(v => dz.addEventListener(v, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  ["dragover", "drop"].forEach(v => window.addEventListener(v, (e) => e.preventDefault()));

  $("file-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]"); if (!b || busy) return;
    files = files.filter(f => f.id !== Number(b.dataset.remove)); clearError(); render();
  });
  $("clear-all").addEventListener("click", () => { if (!busy) { files = []; outputs = []; clearError(); render(); } });
  $("file-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-move]"); if (!b || busy) return;
    const [id, d] = b.dataset.move.split(":").map(Number);
    const i = files.findIndex(f => f.id === id), j = i + d;
    if (j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j], files[i]]; render();
  });
  pick("tool-seg", "t", setTool);
  pick("pg-seg", "a", (v) => { pgAction = v; resetResults(); });
  ["pg-val", "m-name"].forEach(id => $(id).addEventListener("change", resetResults));

  pick("fmt-seg", "v", (v) => { st.fmt = v; resetResults(); });
  pick("mode-seg", "v", (v) => { st.mode = v; updateMode(); resetResults(); });
  pick("p-preset", "l", (v) => { st.level = v; resetResults(); });
  $("s-val").addEventListener("input", () => { $("s-label").textContent = $("s-val").value + "%"; });
  ["t-val", "t-unit", "s-val"].forEach(id => $(id).addEventListener("change", resetResults));

  $("main-form").addEventListener("submit", run);
  $("download-btn").addEventListener("click", downloadResults);
  updateMode(); render();
}

async function greet() {
  if (greeted) return; greeted = true;
  try {
    const u = await ZOHO.CRM.CONFIG.getCurrentUser();
    if (u?.users?.length) { const g = $("user-greeting"); g.textContent = `Hello ${u.users[0].full_name}!`; g.classList.add("visible"); }
  } catch (e) { console.warn("Could not load the user:", e); }
}

setup();
ZOHO.embeddedApp.on("PageLoad", greet);   // web tabs may not send a record, so nothing here depends on one
ZOHO.embeddedApp.init().then(greet);