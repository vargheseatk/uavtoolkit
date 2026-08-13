/* ====================================================================== *
 * Labels — SKU + Quantity spreadsheet -> a print-ready PDF of QR labels
 *
 * Upload an .xlsx or .csv with a SKU column and a Quantity column, and get
 * back one PDF page per physical label, each with a QR code (encoding the
 * SKU) and the SKU printed underneath, sized for a thermal label printer.
 * ====================================================================== */
(function(){
"use strict";

const { $, dl, stamp, flash, parseCsv } = window.APP;

/* ================================================================== *
 * ZIP READING — the inverse of the ZIP writer in index.html.
 * xlsx entries are almost always DEFLATE-compressed (method 8); we lean
 * on the browser's native DecompressionStream for that rather than
 * hand-rolling inflate, which is exactly the kind of subtly-buggy code
 * this app avoids writing from memory (see the vendored QR encoder).
 * ================================================================== */
async function inflateRaw(bytes){
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntries(buf){
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // find End Of Central Directory (signature 0x06054b50), scanning back from
  // the end since an optional comment field can follow it
  let eocd = -1;
  for(let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--){
    if(view.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error("not a valid .xlsx file (no ZIP end-of-directory record)");

  const cdCount  = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const entries = new Map();
  let p = cdOffset;
  for(let i = 0; i < cdCount; i++){
    if(view.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const method     = view.getUint16(p + 10, true);
    const compSize   = view.getUint32(p + 20, true);
    const nameLen    = view.getUint16(p + 28, true);
    const extraLen   = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map();
  for(const [name, e] of entries){
    // local header repeats name/extra lengths; the exact data start can
    // differ slightly from the central directory copy, so re-read it
    if(view.getUint32(e.localOffset, true) !== 0x04034b50)
      throw new Error(`corrupt ZIP local header for ${name}`);
    const lNameLen  = view.getUint16(e.localOffset + 26, true);
    const lExtraLen = view.getUint16(e.localOffset + 28, true);
    const dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + e.compSize);
    out.set(name, e.method === 8 ? await inflateRaw(compressed) : new Uint8Array(compressed));
  }
  return out;
}

/* ================================================================== *
 * SPREADSHEETML PARSING — just enough to read a simple two-column
 * sheet: shared strings, inline strings, numbers, sparse cells.
 * ================================================================== */
const xmlOf = bytes => new DOMParser().parseFromString(new TextDecoder("utf-8").decode(bytes), "application/xml");

function parseSharedStrings(doc){
  if(!doc) return [];
  return [...doc.getElementsByTagName("si")].map(si => {
    // rich text runs (<r><t>...</t></r>) and a bare <t> both occur; concatenate all <t>
    return [...si.getElementsByTagName("t")].map(t => t.textContent).join("");
  });
}

const colIndex = ref => {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for(let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;                                      // zero-based
};

function parseSheetRows(doc, sharedStrings){
  const rows = [];
  for(const rowEl of doc.getElementsByTagName("row")){
    const cells = {};
    for(const c of rowEl.getElementsByTagName("c")){
      const ref = c.getAttribute("r");
      if(!ref) continue;
      const t = c.getAttribute("t");
      let value;
      if(t === "s"){
        const v = c.getElementsByTagName("v")[0];
        value = v ? (sharedStrings[+v.textContent] ?? "") : "";
      }else if(t === "inlineStr"){
        const is = c.getElementsByTagName("is")[0];
        value = is ? [...is.getElementsByTagName("t")].map(x => x.textContent).join("") : "";
      }else{
        const v = c.getElementsByTagName("v")[0];
        value = v ? v.textContent : "";               // number, "str" formula result, or boolean
      }
      cells[colIndex(ref)] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/* resolve the FIRST sheet's real file path via workbook.xml -> .rels,
   handling both relative ("worksheets/sheet1.xml") and absolute
   ("/xl/worksheets/sheet1.xml") relationship targets */
function firstSheetPath(entries){
  const wbDoc = xmlOf(entries.get("xl/workbook.xml"));
  const firstSheet = wbDoc.getElementsByTagName("sheet")[0];
  if(!firstSheet) throw new Error("workbook.xml has no sheets");
  const rId = firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
           || firstSheet.getAttribute("r:id");

  const relsBytes = entries.get("xl/_rels/workbook.xml.rels");
  if(!relsBytes || !rId) return "xl/worksheets/sheet1.xml";   // sane fallback
  const relsDoc = xmlOf(relsBytes);
  const rel = [...relsDoc.getElementsByTagName("Relationship")].find(r => r.getAttribute("Id") === rId);
  if(!rel) return "xl/worksheets/sheet1.xml";
  let target = rel.getAttribute("Target");
  if(target.startsWith("/")) return target.slice(1);          // "/xl/worksheets/sheet1.xml"
  return "xl/" + target;                                      // "worksheets/sheet1.xml"
}

async function readXlsxTable(arrayBuffer){
  const entries = xlsxEntriesFrom(await readZipEntries(arrayBuffer));
  const sheetPath = firstSheetPath(entries);
  const sheetBytes = entries.get(sheetPath);
  if(!sheetBytes) throw new Error(`workbook references ${sheetPath}, which isn't in the file`);

  const shared = parseSharedStrings(entries.has("xl/sharedStrings.xml") ? xmlOf(entries.get("xl/sharedStrings.xml")) : null);
  const rows = parseSheetRows(xmlOf(sheetBytes), shared);

  if(!rows.length) throw new Error("that sheet has no rows");
  const maxCol = rows.reduce((m, r) => Math.max(m, ...Object.keys(r).map(Number), -1), -1);
  return rows.map(r => Array.from({ length: maxCol + 1 }, (_, i) => r[i] ?? ""));
}
const xlsxEntriesFrom = m => m;   // readZipEntries already returns the right shape

/* ================================================================== *
 * SKU / Quantity column resolution — same alias-matching pattern as the
 * Pricing tab's CSV import, applied to either an .xlsx table or a CSV.
 * ================================================================== */
const SKU_ALIASES = ["sku","item code","product code","code","part number","stock code"];
const QTY_ALIASES = ["qty","quantity","qty to print","count","units","no of labels","number of labels"];

function resolveTable(rows){
  if(rows.length < 2) throw new Error("no data rows — just a header, or an empty sheet.");
  const head = rows[0].map(h => String(h ?? "").trim().toLowerCase());
  const findCol = aliases => {
    let i = head.findIndex(h => aliases.includes(h));
    if(i < 0) i = head.findIndex(h => aliases.some(a => h.includes(a)));
    return i;
  };
  const cSku = findCol(SKU_ALIASES);
  const cQty = findCol(QTY_ALIASES);
  if(cSku < 0 || cQty < 0){
    const missing = [cSku < 0 && "a SKU column", cQty < 0 && "a Quantity column"].filter(Boolean).join(" and ");
    throw new Error(`couldn't find ${missing}. Expected headers like "SKU" and "Quantity".`);
  }

  const items = [];
  const skipped = [];
  rows.slice(1).forEach((r, i) => {
    if(!r.some(c => String(c ?? "").trim() !== "")) return;         // blank row
    const sku = String(r[cSku] ?? "").trim();
    const qty = Math.round(parseFloat(r[cQty]));
    if(!sku){ skipped.push(`row ${i + 2}: no SKU`); return; }
    if(!(qty > 0)){ skipped.push(`row ${i + 2} (${sku}): quantity is ${r[cQty] || "blank"}`); return; }
    items.push({ sku, qty });
  });
  if(!items.length) throw new Error("no usable rows — every row was missing a SKU or a positive quantity.");
  return { items, skipped };
}

async function readSpreadsheet(file){
  const isXlsx = /\.xlsx$/i.test(file.name) ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  let rows;
  if(isXlsx){
    rows = await readXlsxTable(await file.arrayBuffer());
  }else{
    rows = parseCsv((await file.text()).replace(/^﻿/, ""));
  }
  return resolveTable(rows);
}

/* ================================================================== *
 * PDF WRITER — one page per physical label. Hand-rolled, no library,
 * for the same reason the ZIP/XLSX writers in index.html are hand-rolled:
 * this is a small, well-documented binary format and a vendored library
 * would be more code than writing exactly what's needed.
 *
 * Each unique SKU gets ONE QR image object and ONE content stream,
 * shared by reference across every page that prints that SKU — so a
 * quantity of 500 costs 500 lightweight Page objects, not 500 copies
 * of the image and text-drawing instructions.
 * ================================================================== */

/* Adobe's published Core-14 AFM metrics for Helvetica/Helvetica-Bold,
   codes 32-126 (printable ASCII), widths in 1/1000 em. Needed to center
   the SKU text under each QR without embedding a real font program —
   PDF viewers and printers are required to know these 14 fonts natively. */
const HELV_WIDTHS = [278,278,355,556,556,889,667,222,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,222,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD_WIDTHS = [278,333,474,556,556,889,722,278,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,278,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// text on the label is ASCII-only (the 14 standard fonts aren't embedded,
// so only WinAnsi/ASCII glyphs are guaranteed to render); anything else
// becomes '?' — the QR itself still carries the exact original string
const asciiSafe = s => String(s).replace(/[^\x20-\x7e]/g, "?");

function textWidthPt(text, fontSize, widths){
  let em = 0;
  for(const ch of asciiSafe(text)){
    const code = ch.charCodeAt(0);
    em += (code >= 32 && code <= 126) ? widths[code - 32] : widths["?".charCodeAt(0) - 32];
  }
  return em * fontSize / 1000;
}

function escapePdfString(s){
  return asciiSafe(s).replace(/[\\()]/g, m => "\\" + m);
}

const mmToPt = mm => mm * 72 / 25.4;

/* pack a QR module grid (with quiet zone) into a 1-bit DeviceGray bitmap,
   bit 0 = black (the PDF default Decode [0 1] maps bit 0 -> gray 0.0) */
function qrToBitmap(qr, quietZone){
  const n = qr.getModuleCount();
  const w = n + quietZone * 2, h = w;
  const rowBytes = Math.ceil(w / 8);
  const data = new Uint8Array(rowBytes * h);
  data.fill(0xff);                                    // start all-white
  for(let r = 0; r < n; r++){
    for(let c = 0; c < n; c++){
      if(!qr.isDark(r, c)) continue;
      const px = c + quietZone, py = r + quietZone;
      const byteIdx = py * rowBytes + (px >> 3);
      data[byteIdx] &= ~(0x80 >> (px & 7));            // clear bit -> black
    }
  }
  return { width: w, height: h, data };
}

/* ---------- minimal classic-xref PDF writer ---------- */
class PdfWriter{
  constructor(){
    this.objects = [];                                 // index+1 == object number
    this.chunks = [];
    this.length = 0;
    // header must be the first bytes written — every xref offset below is
    // measured from byte 0 of the whole file, not from the start of the
    // object section, so nothing can come before this
    this.pushBytes(new Uint8Array([
      ...new TextEncoder().encode("%PDF-1.4\n%"), 0xE2, 0xE3, 0xCF, 0xD3, 0x0A,
    ]));
  }
  reserve(){ this.objects.push(null); return this.objects.length; }   // returns obj number
  push(str){ const b = new TextEncoder().encode(str); this.chunks.push(b); this.length += b.length; return this.length; }
  pushBytes(bytes){ this.chunks.push(bytes); this.length += bytes.length; return this.length; }

  writeObject(num, bodyStr, streamBytes){
    const offset = this.length;
    this.objects[num - 1] = offset;
    this.push(`${num} 0 obj\n${bodyStr}`);
    if(streamBytes){
      this.push(`\nstream\n`);
      this.pushBytes(streamBytes);
      this.push(`\nendstream`);
    }
    this.push(`\nendobj\n`);
  }

  finish(rootNum, infoStr){
    const infoNum = infoStr ? this.reserve() : null;
    if(infoNum) this.writeObject(infoNum, infoStr);

    const xrefOffset = this.length;
    const n = this.objects.length + 1;
    let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for(const off of this.objects) xref += String(off).padStart(10, "0") + " 00000 n \n";
    this.push(xref);
    this.push(`trailer\n<< /Size ${n} /Root ${rootNum} 0 R` + (infoNum ? ` /Info ${infoNum} 0 R` : "") + ` >>\nstartxref\n${xrefOffset}\n%%EOF`);

    let total = new Uint8Array(this.length);
    let p = 0;
    for(const c of this.chunks){ total.set(c, p); p += c.length; }
    return total;
  }
}

/* ================================================================== *
 * MAIN ENTRY
 * items: [{sku, qty}]   opts: label size + text options
 * ================================================================== */
function buildLabelsPdf(items, opts){
  const o = Object.assign({
    widthMm: 50, heightMm: 30, marginMm: 2, showText: true,
    fontSize: 8, bold: false, ecc: "M", quietZone: 4,
  }, opts);

  const widthPt = mmToPt(o.widthMm), heightPt = mmToPt(o.heightMm), marginPt = mmToPt(o.marginMm);
  const widths = o.bold ? HELV_BOLD_WIDTHS : HELV_WIDTHS;
  const fontName = o.bold ? "Helvetica-Bold" : "Helvetica";

  const uniqueSkus = [...new Set(items.map(i => i.sku))];
  if(!uniqueSkus.length) throw new Error("nothing to print");

  const pdf = new PdfWriter();
  const catalogNum = pdf.reserve();
  const pagesNum   = pdf.reserve();
  const fontNum    = pdf.reserve();
  pdf.writeObject(fontNum, `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} /Encoding /WinAnsiEncoding >>`);

  // one Image XObject + one Content stream per UNIQUE sku
  const imageNumOf = {}, contentNumOf = {};
  for(const sku of uniqueSkus){
    const qr = qrcode(0, o.ecc);
    qr.addData(sku);
    qr.make();
    const bmp = qrToBitmap(qr, o.quietZone);

    const imgNum = pdf.reserve();
    pdf.writeObject(imgNum,
      `<< /Type /XObject /Subtype /Image /Width ${bmp.width} /Height ${bmp.height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 1 /Length ${bmp.data.length} >>`,
      bmp.data);
    imageNumOf[sku] = imgNum;

    // layout: QR square, centered, with the text (if any) in a reserved band underneath
    const textBandPt = o.showText ? o.fontSize * 1.5 : 0;
    const availW = widthPt - marginPt * 2;
    const availH = heightPt - marginPt * 2 - textBandPt;
    const qrSize = Math.max(1, Math.min(availW, availH));
    const qrX = (widthPt - qrSize) / 2;
    const qrY = marginPt + textBandPt;

    let content = `q\n${qrSize.toFixed(2)} 0 0 ${qrSize.toFixed(2)} ${qrX.toFixed(2)} ${qrY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    if(o.showText){
      const label = asciiSafe(sku);
      // shrink to fit rather than let a long SKU run off the label edge;
      // floor at 4pt, below which it's unreadable anyway
      let fs = o.fontSize;
      const maxTextW = widthPt - marginPt * 2;
      while(fs > 4 && textWidthPt(label, fs, widths) > maxTextW) fs -= 0.5;
      const tw = textWidthPt(label, fs, widths);
      const tx = Math.max(marginPt, (widthPt - tw) / 2);
      const ty = marginPt + (textBandPt - o.fontSize) / 2;
      content += `BT\n/F1 ${fs} Tf\n${tx.toFixed(2)} ${ty.toFixed(2)} Td\n(${escapePdfString(label)}) Tj\nET\n`;
    }
    const contentBytes = new TextEncoder().encode(content);
    const contentNum = pdf.reserve();
    pdf.writeObject(contentNum, `<< /Length ${contentBytes.length} >>`, contentBytes);
    contentNumOf[sku] = contentNum;
  }

  // one lightweight Page per physical label, sharing the image/content above
  const pageNums = [];
  for(const { sku, qty } of items){
    for(let i = 0; i < qty; i++){
      const pageNum = pdf.reserve();
      pdf.writeObject(pageNum,
        `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${imageNumOf[sku]} 0 R >> /Font << /F1 ${fontNum} 0 R >> >> ` +
        `/Contents ${contentNumOf[sku]} 0 R >>`);
      pageNums.push(pageNum);
    }
  }

  pdf.writeObject(pagesNum, `<< /Type /Pages /Kids [${pageNums.map(n => n + " 0 R").join(" ")}] /Count ${pageNums.length} >>`);
  pdf.writeObject(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const pdfDate = `D:${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const info = `<< /Producer (UAV Store Toolkit) /CreationDate (${pdfDate}) >>`;

  return pdf.finish(catalogNum, info);
}

window.LABELS = { readZipEntries, parseSharedStrings, parseSheetRows, colIndex,
                  firstSheetPath, readXlsxTable, resolveTable, readSpreadsheet,
                  buildLabelsPdf, textWidthPt, qrToBitmap };

/* ================================================================== *
 * UI
 * ================================================================== */
const OPT_KEY = "labels-opts-v1";
const PRESETS = { "50x30": [50, 30], "40x30": [40, 30], "30x20": [30, 20], "58x40": [58, 40] };
const defaultOpts = () => ({ preset: "50x30", widthMm: 50, heightMm: 30, marginMm: 2,
                             fontSize: 8, showText: true, bold: false });

let opts = Object.assign(defaultOpts(), (() => {
  try{ return JSON.parse(localStorage.getItem(OPT_KEY)) || {}; }catch(e){ return {}; }
})());
let items = null;    // [{sku, qty}] from the last successful upload

function syncOptionInputs(){
  $("#labelPreset").value    = opts.preset;
  $("#labelWidth").value     = opts.widthMm;
  $("#labelHeight").value    = opts.heightMm;
  $("#labelMargin").value    = opts.marginMm;
  $("#labelFontSize").value  = opts.fontSize;
  $("#labelShowText").checked = opts.showText;
  $("#labelBold").checked     = opts.bold;
}
function saveOpts(){ try{ localStorage.setItem(OPT_KEY, JSON.stringify(opts)); }catch(e){} }

$("#labelPreset").addEventListener("change", e => {
  opts.preset = e.target.value;
  if(PRESETS[opts.preset]){
    [opts.widthMm, opts.heightMm] = PRESETS[opts.preset];
    $("#labelWidth").value = opts.widthMm;
    $("#labelHeight").value = opts.heightMm;
  }
  saveOpts();
});
[["labelWidth","widthMm"],["labelHeight","heightMm"],["labelMargin","marginMm"],["labelFontSize","fontSize"]]
  .forEach(([id, key]) => $("#" + id).addEventListener("input", e => {
    opts[key] = parseFloat(e.target.value) || 0;
    saveOpts();
  }));
[["labelShowText","showText"],["labelBold","bold"]]
  .forEach(([id, key]) => $("#" + id).addEventListener("change", e => {
    opts[key] = e.target.checked;
    saveOpts();
  }));

/* ---------- upload ---------- */
function log(msg, cls){
  const el = $("#labelLog");
  el.hidden = false;
  const span = document.createElement("span");
  if(cls) span.className = cls;
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

$("#btn-label-upload").addEventListener("click", () => $("#labelFileInput").click());
$("#labelFileInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if(!file) return;
  $("#labelLog").innerHTML = ""; $("#labelLog").hidden = true;
  $("#labelSummary").hidden = true;
  items = null;
  try{
    const { items: rows, skipped } = await readSpreadsheet(file);
    items = rows;
    const totalLabels = items.reduce((s, r) => s + r.qty, 0);
    $("#ls-rows").textContent = items.length + skipped.length;
    $("#ls-labels").textContent = totalLabels;
    $("#ls-skus").textContent = items.length;
    $("#ls-skipped").textContent = skipped.length;
    $("#labelSummary").hidden = false;
    log(`Read ${file.name}: ${totalLabels} labels across ${items.length} SKU(s).`, "ok");
    skipped.slice(0, 8).forEach(s => log("  skipped — " + s, "dim"));
    if(skipped.length > 8) log(`  …and ${skipped.length - 8} more`, "dim");
  }catch(err){
    log("! " + err.message, "err");
    alert("Couldn't read that file.\n\n" + err.message);
  }
  e.target.value = "";
});

/* ---------- template ---------- */
$("#btn-label-template").addEventListener("click", () => {
  const rows = [["SKU","Quantity"], ["GNB3001S80PHV", 10], ["GNB22003S110A", 3]];
  dl("﻿" + window.APP.csv(rows), "label-import-template.csv", "text/csv;charset=utf-8");
  flash("#btn-label-template", "Downloaded ✓");
});

/* ---------- generate ---------- */
$("#btn-label-generate").addEventListener("click", () => {
  if(!items || !items.length){
    alert("Upload a SKU + Quantity sheet first.");
    return;
  }
  const total = items.reduce((s, r) => s + r.qty, 0);
  if(total > 1000 && !confirm(`This will generate ${total} label pages (${items.length} SKUs). Continue?`))
    return;

  const btn = $("#btn-label-generate");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Generating…";
  setTimeout(() => {
    try{
      const bytes = buildLabelsPdf(items, {
        widthMm: opts.widthMm, heightMm: opts.heightMm, marginMm: opts.marginMm,
        fontSize: opts.fontSize, showText: opts.showText, bold: opts.bold,
      });
      dl(bytes, "labels-" + stamp() + ".pdf", "application/pdf");
      log(`Generated ${total} label pages.`, "ok");
      flash("#btn-label-generate", "Downloaded ✓");
    }catch(err){
      log("! " + err.message, "err");
      alert("Couldn't generate the PDF.\n\n" + err.message);
    }finally{
      btn.disabled = false; btn.textContent = old;
    }
  }, 10);   // let the "Generating…" label paint before the (usually sub-second) build runs
});

syncOptionInputs();
})();
