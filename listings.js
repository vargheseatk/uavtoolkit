/* ====================================================================== *
 * Listings — product link → WooCommerce CSV + renamed images
 *
 * A browser port of import_products.py. The store's rules are unchanged:
 *   - products import as DRAFT (Published = -1), no pricing exported
 *   - In stock? = 1, Backorders allowed? = 0, Categories blank
 *   - product name starts with the brand
 *   - "Stock Number" → "SKU Code", and that value becomes the SKU
 *   - specs → attribute columns ONLY for variable products; simple products
 *     keep the spec list inside the description
 *   - ALL outbound links are stripped except YouTube          (changed rule)
 *
 * Only Shopify works here. Other platforms don't send CORS headers, so the
 * browser refuses to read them — those still need the Python script.
 * ====================================================================== */
(function(){
"use strict";

const { $, dl, stamp, csv, flash, zipStore } = window.APP;

/* Shopify "options" that aren't real variations — warehouse pickers etc. */
const JUNK_OPTIONS = new Set(["title","ship_from","ship from","ships from","shipping",
  "warehouse","location","send from","sent from","country","region","dispatch"]);

const BASE_COLUMNS = ["Type","SKU","Name","Published","Is featured?","Visibility in catalog",
  "Short description","Description","In stock?","Backorders allowed?","Categories","Tags",
  "Images","Parent"];

let RESULT = null;      // { rows, images:[{name,bytes}], failed }
let DIR = null;         // FileSystemDirectoryHandle

/* ---------------------------------------------------------------- *
 * small helpers, ported 1:1
 * ---------------------------------------------------------------- */
const slugify = t => String(t).toLowerCase().trim()
  .replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");

/* Filesystem-safe, and safe in a URL — brand casing is preserved (CNHL stays
   capital, mAh stays). Beyond the Python version this also drops & # % + , which
   are legal in a filename but break the image URL WooCommerce builds from it. */
const brandSafeName = t => String(t)
  .replace(/[\\/:*?"<>|]+/g, "")     // illegal filename characters
  .replace(/[&#%+]+/g, " ")          // legal, but hostile in a URL
  .trim().replace(/\s+/g, "-")
  .replace(/-{2,}/g, "-")
  .replace(/^-+|-+$/g, "");

const STOCK_LABEL_RE = /stock\s*(?:number|no\.?|code)/ig;
const SKU_KEY_RE = /\b(?:sku|(?:stock|model|item|part|article)\s*(?:number|no\.?|code))\b/i;

const unesc = s => { const d = document.createElement("textarea"); d.innerHTML = s; return d.value; };
const stripTags = s => unesc(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/* ---------------------------------------------------------------- *
 * fetch — Shopify only
 * ---------------------------------------------------------------- */
async function fetchProduct(rawUrl){
  const url = rawUrl.trim().split("?")[0].replace(/\/+$/, "");
  let res;
  try{
    res = await fetch(url + ".json", { headers:{ "Accept":"application/json" } });
  }catch(e){
    throw new Error("the browser blocked this request — this store doesn't allow " +
                    "cross-origin reads. Use the Download script card below for this one.");
  }
  if(!res.ok) throw new Error("HTTP " + res.status + " — not a Shopify product URL?");

  let data;
  try{ data = await res.json(); }
  catch(e){ throw new Error("that URL didn't return product JSON — not a Shopify store?"); }
  const p = data && data.product;
  if(!p) throw new Error("no product in the response.");

  return {
    title: p.title || "",
    brand: "",                                    // Shopify vendor is unreliable
    bodyHtml: p.body_html || "",
    images: (p.images || []).map(i => i.src),
    sku: ((p.variants || [{}])[0] || {}).sku || "",
    categories: p.product_type || "",
    options: (p.options || []).map(o => ({ name:o.name, values:(o.values || []).slice() })),
    variants: (p.variants || []).map(v => ({
      sku: v.sku || "",
      values: [v.option1, v.option2, v.option3].filter(x => x != null),
    })),
  };
}

/* ---------------------------------------------------------------- *
 * description cleaning
 * ---------------------------------------------------------------- */
const YT_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function isYouTube(href){
  try{ return YT_RE.test(new URL(href, location.href).hostname); }
  catch(e){ return false; }
}

/* Unwrap every <a> that isn't YouTube, keeping its text. YouTube links and
   embeds survive untouched. */
function cleanDescription(bodyHtml){
  const box = document.createElement("div");
  box.innerHTML = bodyHtml;

  box.querySelectorAll("a").forEach(a => {
    const href = a.getAttribute("href") || "";
    if(href && isYouTube(href)) return;                    // keep
    a.replaceWith(...a.childNodes);                        // unwrap, keep the text
  });
  box.querySelectorAll("iframe").forEach(f => {
    if(!isYouTube(f.getAttribute("src") || "")) f.remove();
  });
  box.querySelectorAll("script,style").forEach(n => n.remove());

  return box.innerHTML.replace(STOCK_LABEL_RE, "SKU Code");
}

/* Pull a "Specifications" <ul><li>Key: Value</li></ul> block into pairs. */
function parseSpecs(bodyHtml){
  const box = document.createElement("div");
  box.innerHTML = bodyHtml;
  const lists = [...box.querySelectorAll("ul")];
  if(!lists.length) return [];

  // prefer the list that follows a "Specifications" heading
  let list = lists[0];
  const specHead = [...box.querySelectorAll("*")].find(
    n => n.children.length === 0 && /specifications?/i.test(n.textContent || ""));
  if(specHead){
    const after = lists.find(u => specHead.compareDocumentPosition(u) &
                                  Node.DOCUMENT_POSITION_FOLLOWING);
    if(after) list = after;
  }

  const specs = [];
  list.querySelectorAll("li").forEach(li => {
    const text = stripTags(li.innerHTML);
    if(!text) return;
    const i = text.indexOf(":");
    if(i > 0){
      let key = text.slice(0, i).trim();
      if(/^stock\s*(?:number|no\.?|code)$/i.test(key)) key = "SKU Code";
      specs.push([key, text.slice(i + 1).trim()]);
    }else{
      specs.push([text, ""]);
    }
  });
  return specs;
}

/* First real paragraph of prose, skipping the spec list. */
function shortDescription(bodyHtml){
  const box = document.createElement("div");
  box.innerHTML = bodyHtml;
  const firstList = box.querySelector("ul");
  for(const p of box.querySelectorAll("p")){
    if(firstList && (firstList.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_PRECEDING))
      continue;                                            // sits above the specs
    const t = stripTags(p.innerHTML);
    if(t.length > 40) return t;
  }
  return stripTags(box.innerHTML).slice(0, 300);
}

/* ---------------------------------------------------------------- *
 * images
 * ---------------------------------------------------------------- */
const MIME_EXT = { "image/jpeg":".jpg", "image/png":".png", "image/webp":".webp",
                   "image/gif":".gif", "image/avif":".avif" };

function urlExt(src){
  const m = /\.(jpe?g|png|webp|gif|avif)(?=$|\?)/i.exec(String(src).split("?")[0]);
  return m ? "." + m[1].toLowerCase().replace("jpeg", "jpeg") : ".jpg";
}

async function downloadImages(images, fnameBase, suffix, log){
  const out = [];
  for(let i = 0; i < images.length; i++){
    const src = images[i];
    const num = i === 0 ? "" : "_" + String(i + 1).padStart(2, "0");   // primary unnumbered
    try{
      const r = await fetch(src);
      if(!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      // Shopify serves whatever format it likes regardless of the URL, so trust the MIME
      const ext = MIME_EXT[blob.type] || urlExt(src);
      const name = `${fnameBase}${suffix}${num}${ext}`;
      out.push({ name, bytes:new Uint8Array(await blob.arrayBuffer()) });
      log(`    saved ${name}`, "dim");
    }catch(e){
      log(`    ! image failed: ${e.message}`, "err");
    }
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * row building
 * ---------------------------------------------------------------- */
function baseRow(sku, o){
  o = o || {};
  return {
    "Type":"simple", "SKU":sku, "Name":o.name || "", "Published":o.published ?? -1,
    "Is featured?":0, "Visibility in catalog":"visible",
    "Short description":o.short || "", "Description":o.description || "",
    "In stock?":1, "Backorders allowed?":0,
    "Categories":"",                                   // assigned manually later
    "Tags":o.tags || "", "Images":o.images || "", "Parent":"",
    _attrs:[],
  };
}

function realVariationOptions(product){
  const out = [];
  product.options.forEach((o, i) => {
    const name = (o.name || "").trim();
    const values = (o.values || []).filter(Boolean);
    if(JUNK_OPTIONS.has(name.toLowerCase())) return;
    if(new Set(values).size > 1) out.push([i, name, values]);
  });
  return out;
}

async function buildRows(url, suffix, log){
  const product = await fetchProduct(url);

  let title = product.title;
  const brand = product.brand || (title ? title.split(/\s+/)[0] : "");
  if(brand && !title.toLowerCase().startsWith(brand.toLowerCase()))
    title = (brand + " " + title).trim();

  const desc = cleanDescription(product.bodyHtml).trim();
  const short = shortDescription(desc);
  const tags = [...new Set([brand, product.categories].filter(Boolean))].join(", ");

  const specs = parseSpecs(product.bodyHtml);
  const specSku = (specs.find(([k]) => SKU_KEY_RE.test(k)) || [])[1] || "";
  const sku = specSku || (product.sku.split(/\s+/)[0]) || slugify(title).toUpperCase().slice(0, 32);

  const fnameBase = brandSafeName(title);
  log(`  ${title}`, "ok");
  const files = await downloadImages(product.images, fnameBase, suffix, log);
  // files keep their extension on disk; the CSV references them without it
  const imagesCell = files.map(f => f.name.replace(/\.[^.]+$/, "")).join(", ");

  const realOpts = realVariationOptions(product);
  const common = { name:title, images:imagesCell, description:desc, short, tags };

  /* ---- simple product: no attribute columns ---- */
  if(!realOpts.length) return { rows:[baseRow(sku, common)], files };

  /* ---- variable product: parent + variation rows ---- */
  if(realOpts.length > 1)
    log(`    ! ${realOpts.length} variation dimensions (` +
        realOpts.map(o => o[1]).join(", ") + `); using the first only`, "err");
  const [optIndex, optName] = realOpts[0];

  const seen = new Map();
  product.variants.forEach(v => {
    const val = v.values[optIndex];
    if(val && !seen.has(val)) seen.set(val, v.sku || `${sku}-${slugify(val)}`);
  });

  const parent = baseRow(sku, common);
  parent.Type = "variable";
  parent._attrs = [[optName, [...seen.keys()].join(", ")]];
  const rows = [parent];

  seen.forEach((vsku, val) => {
    const child = baseRow(vsku || `${sku}-${slugify(val)}`);
    child.Type = "variation";
    child.Parent = sku;
    child["Visibility in catalog"] = "";
    child.Published = "";
    child._attrs = [[optName, val]];
    rows.push(child);
  });
  return { rows, files };
}

/* ---------------------------------------------------------------- *
 * CSV
 * ---------------------------------------------------------------- */
function buildCsv(rows){
  const maxAttrs = rows.reduce((m, r) => Math.max(m, r._attrs.length), 0);
  const attrCols = [];
  for(let n = 1; n <= maxAttrs; n++)
    attrCols.push(`Attribute ${n} name`, `Attribute ${n} value(s)`,
                  `Attribute ${n} visible`, `Attribute ${n} global`);
  const columns = BASE_COLUMNS.concat(attrCols);

  const out = [columns];
  rows.forEach(r => {
    const rec = Object.assign({}, r);
    delete rec._attrs;
    r._attrs.forEach(([name, value], i) => {
      rec[`Attribute ${i + 1} name`] = name;
      rec[`Attribute ${i + 1} value(s)`] = value;
      rec[`Attribute ${i + 1} visible`] = 1;
      rec[`Attribute ${i + 1} global`] = 0;
    });
    out.push(columns.map(c => rec[c] ?? ""));
  });
  return { text:csv(out), columns };
}

/* ---------------------------------------------------------------- *
 * UI
 * ---------------------------------------------------------------- */
const logEl = () => $("#log");
function log(msg, cls){
  const el = logEl();
  el.hidden = false;
  const span = document.createElement("span");
  if(cls) span.className = cls;
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

/* ---------- the Python script, for stores the browser can't read ---------- */
$("#btn-dl-script").addEventListener("click", async () => {
  const btn = $("#btn-dl-script");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Packaging…";
  try{
    const names = ["tools/import_products.py", "tools/requirements.txt", "tools/README.md"];
    const parts = await Promise.all(names.map(async n => {
      const r = await fetch(n);
      if(!r.ok) throw new Error(n + " — HTTP " + r.status);
      return { name:"uavstore-import/" + n.split("/")[1], data:await r.text() };
    }));
    dl(zipStore(parts), "uavstore-import-script-" + stamp() + ".zip", "application/zip");
    flash("#btn-dl-script", "Downloaded ✓");
  }catch(e){
    alert("Couldn't package the script: " + e.message +
          "\n\nThe files should be at tools/ next to this page — if you're running the app " +
          "from a single downloaded index.html rather than the full folder, they won't be there.");
  }finally{
    btn.disabled = false; if(btn.textContent === "Packaging…") btn.textContent = old;
  }
});

$("#btn-folder").addEventListener("click", async () => {
  if(!window.showDirectoryPicker){
    alert("Your browser can't save straight into a folder — that needs Chrome or Edge.\n\n" +
          "Everything still works; you'll get a .zip download instead.");
    return;
  }
  try{
    DIR = await window.showDirectoryPicker({ mode:"readwrite" });
    $("#folderName").innerHTML = "Saving into <b>" + DIR.name + "</b>";
  }catch(e){ /* user cancelled */ }
});

$("#btn-listing-clear").addEventListener("click", () => {
  $("#urls").value = "";
  logEl().innerHTML = ""; logEl().hidden = true;
  $("#resultCard").hidden = true;
  $("#previewTbl").innerHTML = "";
  RESULT = null;
});

$("#btn-scrape").addEventListener("click", async () => {
  const urls = $("#urls").value.split("\n").map(s => s.trim()).filter(Boolean);
  if(!urls.length){ alert("Paste at least one product URL."); return; }

  let suffix = $("#storeName").value.trim();
  if(suffix) suffix = "_" + suffix.replace(/^_+/, "").replace(/\s+/g, "-");

  const btn = $("#btn-scrape");
  btn.disabled = true; btn.textContent = "Fetching…";
  logEl().innerHTML = "";
  $("#resultCard").hidden = true;

  const allRows = [], allFiles = [];
  let failed = 0, blocked = 0;

  for(const url of urls){
    log(`\nFetching: ${url}`);
    try{
      const { rows, files } = await buildRows(url, suffix, log);
      allRows.push(...rows);
      allFiles.push(...files);
    }catch(e){
      failed++;
      if(/cross-origin/.test(e.message)) blocked++;
      log(`  ! error: ${e.message}`, "err");
    }
  }

  btn.disabled = false; btn.textContent = "Fetch products";

  if(blocked){
    $("#scriptCard").classList.add("flag");
    $("#scriptCard").scrollIntoView({ behavior:"smooth", block:"nearest" });
    setTimeout(() => $("#scriptCard").classList.remove("flag"), 2600);
  }

  if(!allRows.length){ log("\nNothing to write.", "err"); return; }

  RESULT = { rows:allRows, files:allFiles, failed };
  const products = allRows.filter(r => r.Type !== "variation").length;
  log(`\nDone. ${products} product(s), ${allRows.length} CSV row(s), ${allFiles.length} image(s).`, "ok");

  $("#r-products").textContent = products;
  $("#r-rows").textContent     = allRows.length;
  $("#r-images").textContent   = allFiles.length;
  $("#r-failed").textContent   = failed;
  $("#resultCard").hidden = false;
  renderPreview();
});

function renderPreview(){
  if(!RESULT) return;
  const show = ["Type","SKU","Name","Published","In stock?","Tags","Images"];
  const head = `<thead><tr>${show.map(h => `<th class="l">${h}</th>`).join("")}</tr></thead>`;
  const body = RESULT.rows.slice(0, 12).map(r =>
    `<tr>${show.map(c => {
      let v = String(r[c] ?? "");
      if(v.length > 60) v = v.slice(0, 60) + "…";
      return `<td class="l">${v.replace(/[&<>]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[m]))}</td>`;
    }).join("")}</tr>`).join("");
  $("#previewTbl").innerHTML = head + "<tbody>" + body + "</tbody>";
}

$("#btn-preview-csv").addEventListener("click", () => {
  if(!RESULT) return;
  const { text } = buildCsv(RESULT.rows);
  const w = window.open("", "_blank");
  if(w){ w.document.write("<pre style='font:12px monospace;white-space:pre-wrap'></pre>");
         w.document.querySelector("pre").textContent = text; }
  else alert(text.slice(0, 4000));
});

$("#btn-write").addEventListener("click", async () => {
  if(!RESULT) return;
  const { text } = buildCsv(RESULT.rows);

  if(DIR){
    try{
      const f = await DIR.getFileHandle("woocommerce_import.csv", { create:true });
      const w = await f.createWritable();
      await w.write("﻿" + text);
      await w.close();

      const imgDir = await DIR.getDirectoryHandle("images", { create:true });
      for(const img of RESULT.files){
        const h = await imgDir.getFileHandle(img.name, { create:true });
        const ws = await h.createWritable();
        await ws.write(img.bytes);
        await ws.close();
      }
      log(`\nWrote woocommerce_import.csv and images/ into ${DIR.name}.`, "ok");
      flash("#btn-write", "Saved ✓");
      return;
    }catch(e){
      log(`\n! couldn't write to the folder: ${e.message} — falling back to a .zip`, "err");
    }
  }

  // no folder chosen (or writing failed): hand back one zip
  const files = [{ name:"woocommerce_import.csv", data:"﻿" + text }];
  RESULT.files.forEach(f => files.push({ name:"images/" + f.name, data:f.bytes }));
  dl(zipStore(files), "listings-" + new Date().toISOString().slice(0, 10) + ".zip",
     "application/zip");
  flash("#btn-write", "Downloaded ✓");
});

/* exposed for testing */
window.LISTINGS = { fetchProduct, buildRows, buildCsv, cleanDescription, parseSpecs,
                    shortDescription, brandSafeName, slugify, realVariationOptions,
                    get result(){ return RESULT; } };
})();
