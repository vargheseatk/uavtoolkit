/* ====================================================================== *
 * Sync — cross-reference this shipment against your live WooCommerce
 * inventory, and produce an update sheet: SKU, Stock, Regular price.
 *
 * "Stock" and "Regular price" are WooCommerce's own CSV column names
 * (confirmed against the WC_Product_CSV_Exporter source), so the file
 * this tab produces needs no manual column mapping when re-imported.
 * ====================================================================== */
(function(){
"use strict";

const { $, dl, stamp, csv, flash, parseCsv, compute } = window.APP;

const SKU_ALIASES = ["sku","item sku","product code","code","part number"];
const STOCK_ALIASES = ["stock","inventory","quantity","qty","stock quantity","current stock"];

let wooMap = null;      // Map<sku, {stock:number, name:string}>
let matchResult = null; // { matched:[...], newSkus:[...] }

/* ---------------------------------------------------------------- *
 * 1. read the WooCommerce export
 * ---------------------------------------------------------------- */
function log(msg, cls){
  const el = $("#syncUploadLog");
  el.hidden = false;
  const span = document.createElement("span");
  if(cls) span.className = cls;
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function findCol(head, aliases){
  let i = head.indexOf(aliases[0]);
  if(i < 0) i = head.findIndex(h => aliases.includes(h));
  if(i < 0) i = head.findIndex(h => aliases.some(a => h.includes(a)));
  return i;
}

async function readWooTable(file){
  const isXlsx = /\.xlsx$/i.test(file.name) ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return isXlsx
    ? await window.LABELS.readXlsxTable(await file.arrayBuffer())
    : parseCsv((await file.text()).replace(/^﻿/, ""));
}

$("#btn-sync-upload").addEventListener("click", () => $("#syncFileInput").click());
$("#syncFileInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if(!file) return;
  $("#syncUploadLog").innerHTML = ""; $("#syncUploadLog").hidden = true;
  $("#syncUploadSummary").hidden = true;
  wooMap = null;
  try{
    const rows = await readWooTable(file);
    if(rows.length < 2) throw new Error("The file has no data rows.");
    const head = rows[0].map(h => String(h ?? "").trim().toLowerCase());
    const cSku = findCol(head, SKU_ALIASES);
    const cStock = findCol(head, STOCK_ALIASES);
    const cName = findCol(head, ["name","product","title"]);
    if(cSku < 0) throw new Error('Could not find a SKU column. Expected a header like "SKU".');
    if(cStock < 0) throw new Error('Could not find a Stock column. Expected a header like "Stock".');

    wooMap = new Map();
    let stocked = 0, blankSku = 0;
    rows.slice(1).forEach(r => {
      if(!r.some(c => String(c ?? "").trim() !== "")) return;
      const sku = String(r[cSku] ?? "").trim();
      if(!sku){ blankSku++; return; }
      const stockRaw = cStock >= 0 ? String(r[cStock] ?? "").trim() : "";
      const stock = stockRaw === "" ? 0 : (parseFloat(stockRaw.replace(/[^0-9.\-]/g, "")) || 0);
      if(stockRaw !== "") stocked++;
      wooMap.set(sku, { stock, name: cName >= 0 ? String(r[cName] ?? "").trim() : "" });
    });

    $("#su-rows").textContent = wooMap.size;
    $("#su-stocked").textContent = stocked;
    $("#syncUploadSummary").hidden = false;
    log(`Read ${file.name}: ${wooMap.size} SKUs from your store.`, "ok");
    if(blankSku) log(`  skipped ${blankSku} row(s) with no SKU`, "dim");
    flash("#btn-sync-upload", "Loaded ✓");
  }catch(err){
    log("! " + err.message, "err");
    alert("Couldn't read that file.\n\n" + err.message);
  }
  e.target.value = "";
});

/* ---------------------------------------------------------------- *
 * 2. match against the current Pricing tab shipment
 * ---------------------------------------------------------------- */
$("#btn-sync-match").addEventListener("click", () => {
  if(!wooMap){
    alert("Upload your WooCommerce export first (step 1).");
    return;
  }
  const rows = compute().rows.filter(r => r.sku);
  if(!rows.length){
    alert("The Pricing tab has no SKUs to match. Add or import products there first.");
    return;
  }

  const matched = [], newSkus = [];
  rows.forEach(r => {
    const woo = wooMap.get(r.sku);
    const price = Math.round(r.price);
    if(woo){
      const newStock = woo.stock + r.qty;
      matched.push({ sku:r.sku, name:r.name, existingStock:woo.stock, receivedQty:r.qty,
                     newStock, price });
    }else{
      newSkus.push({ sku:r.sku, name:r.name, qty:r.qty, price });
    }
  });

  matchResult = { matched, newSkus };

  $("#sm-matched").textContent = matched.length;
  $("#sm-new").textContent = newSkus.length;
  $("#sm-total").textContent = rows.length;
  $("#syncMatchSummary").hidden = false;
  $("#syncResultCard").hidden = false;
  renderPreview();
  flash("#btn-sync-match", "Matched ✓");
});

function renderPreview(){
  if(!matchResult) return;
  const rows = [
    ...matchResult.matched.map(r => ({ ...r, status:"update" })),
    ...matchResult.newSkus.map(r => ({ ...r, status:"new" })),
  ];
  const head = `<thead><tr>
    <th class="l">Status</th><th class="l">SKU</th><th class="l">Name</th>
    <th>Existing</th><th>Received</th><th>New stock</th><th>Price</th>
  </tr></thead>`;
  const body = rows.slice(0, 200).map(r => {
    const isNew = r.status === "new";
    const badge = isNew
      ? `<span class="pill b">NEW — not listed</span>`
      : `<span class="pill g">update</span>`;
    let name = String(r.name || "");
    if(name.length > 40) name = name.slice(0, 40) + "…";
    return `<tr>
      <td class="l">${badge}</td>
      <td class="l">${esc(r.sku)}</td>
      <td class="l">${esc(name)}</td>
      <td class="num">${isNew ? "—" : r.existingStock}</td>
      <td class="num">${isNew ? r.qty : r.receivedQty}</td>
      <td class="num">${isNew ? "—" : r.newStock}</td>
      <td class="num">₹${r.price}</td>
    </tr>`;
  }).join("");
  $("#syncPreviewTbl").innerHTML = head + "<tbody>" + body + "</tbody>";
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

/* ---------------------------------------------------------------- *
 * 3. export
 * ---------------------------------------------------------------- */
$("#btn-sync-update").addEventListener("click", () => {
  if(!matchResult || !matchResult.matched.length){
    alert("Nothing to update — run Match first, or every SKU in this shipment is new.");
    return;
  }
  const rows = [["SKU", "Stock", "Regular price", "In stock?"]];
  matchResult.matched.forEach(r => {
    rows.push([r.sku, r.newStock, r.price, r.newStock > 0 ? 1 : 0]);
  });
  dl("﻿" + csv(rows), "woocommerce-update-" + stamp() + ".csv", "text/csv;charset=utf-8");
  flash("#btn-sync-update", "Downloaded ✓");
});

$("#btn-sync-new").addEventListener("click", () => {
  if(!matchResult || !matchResult.newSkus.length){
    alert("No new SKUs — every SKU in this shipment already exists in WooCommerce.");
    return;
  }
  const rows = [["SKU", "Name", "Qty received", "Suggested price"]];
  matchResult.newSkus.forEach(r => rows.push([r.sku, r.name, r.qty, r.price]));
  dl("﻿" + csv(rows), "new-skus-to-list-" + stamp() + ".csv", "text/csv;charset=utf-8");
  flash("#btn-sync-new", "Downloaded ✓");
});

window.SYNC = { readWooTable, get wooMap(){ return wooMap; }, get matchResult(){ return matchResult; } };
})();
