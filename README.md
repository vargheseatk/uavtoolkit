# UAV Store Toolkit

Two tools in one page, no build step, no dependencies, no backend.

- **Pricing** — replaces the `GNB.xlsx` costing sheet. Enter what a shipment actually cost
  you and it works out the landed cost of every SKU and the selling price that hits your
  target margin, with a live slider.
- **Listings** — paste product links, get a WooCommerce import CSV and every image renamed
  with your store name. A browser port of `import_products.py`.

There's an **? How this works** button in the top right that explains the whole thing in
plain English — start there if you're new to it.

## Deploy to GitHub Pages

```bash
git init && git add . && git commit -m "Landing cost calculator"
```

Create an empty repo on GitHub, then:

```bash
git remote add origin https://github.com/USERNAME/REPO.git && git push -u origin main
```

In the repo: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.**

Live in about a minute at `https://USERNAME.github.io/REPO/`.

To run it locally, just open `index.html` in a browser — no server needed.

## The model

Import costs are allocated across SKUs **in proportion to their USD value**, exactly as the
spreadsheet did.

| Rate | Formula |
|---|---|
| Effective FX | amount debited ÷ invoice USD |
| Freight + duty per $ | (freight + customs) ÷ invoice USD |
| ITC per $ | import IGST ÷ invoice USD |

Then, per unit:

```
landed        = cost$ × (FX + freight/$ + ITC/$)
suggested     = roundUp( landed ÷ (1 − target margin), ₹100 ) − ₹1
output GST    = price − price ÷ (1 + GST rate)
net GST       = output GST − ITC          # import IGST offsets the output liability
P/L           = price − net GST − landed
margin        = P/L ÷ price
```

Rounding up to ₹100 and subtracting ₹1 is what produces the ₹399 / ₹999 / ₹1,499 price
points. Both numbers are configurable.

## The workflow

**Upload inputs → slide → export prices.**

### 1. Import schema

Click **Template** for a file with these headers already in place. Column order and letter
case don't matter, and common aliases are recognised (`Product Code`, `Quantity`,
`Unit Cost`, `Regular price`, …), so a Zoho or WooCommerce export usually drops straight in.

| Column | | Meaning |
|---|---|---|
| `sku` | **required** | The key. Rows without one are skipped. |
| `qty` | **required** | Units on this shipment. Drives how freight is allocated. |
| `cost_usd` | **required** | Unit cost on the supplier invoice. Rows with a blank or zero cost are skipped. |
| `name` | optional | Falls back to the SKU. |
| `connector` | optional | Or any variant label. |
| `target_margin_pct` | optional | Prices *this* row at its own margin. **Blank = follow the slider.** |
| `gst_pct` | optional | Per-row GST. Blank = the global rate. |
| `price` | optional | A hard price. Blank = use the suggested price. |

Import replaces the whole list, and shows you what it's about to do first — how many rows,
what it's skipping and why, any duplicate SKUs.

### 2. Price it

Drag the margin slider; every SKU reprices. Type over any price to pin that row (↺ releases
it). Set a per-row target margin for a category that prices differently — the toggle above
the table shows those columns.

### 3. Export

| Button | What you get |
|---|---|
| **SKU + Price ↓** | `price-list-YYYY-MM-DD.csv` — two columns, `sku,price`. The file you run at the store. |
| **Copy** | The same thing as `SKU⇥price` on the clipboard, for pasting straight into a sheet. |
| **Excel backup ↓** | `landing-cost-YYYY-MM-DD.xlsx` — see below. |
| **Full CSV ↓** | Every computed column, for your own analysis. |

### The Excel backup

Not a dead snapshot — a **working model**. Two tabs:

- **Calculator** — the assumptions in blue at the top (`B5:B12`), the full SKU table below,
  and live formulas throughout. Change the amount debited, the freight, or the target margin
  in Excel and every landed cost and price recalculates. It's the original spreadsheet,
  rebuilt cleanly.
- **Price List** — `sku` and `price`, linked to the Calculator tab, so it updates with it.

Prices you pinned in the app are written as hard numbers; the rest track the formula.

### Clearing

- **Clear sheet** — a genuinely blank page: no products, costs/freight/duty zeroed. Your
  margin, GST, rounding and column preferences are kept.
- **Sample data** — reloads the original 37-SKU GNB shipment as a worked example.

State is saved to `localStorage` in your own browser. Nothing is uploaded anywhere.

---

# Listings tab

Paste product URLs → store name → choose a folder → **Fetch products**. You get
`woocommerce_import.csv` and an `images/` folder beside it.

The store rules from `import_products.py` are unchanged: products import as **draft**
(`Published = -1`), **no pricing is exported**, `In stock? = 1` with backorders off,
categories are left blank for manual assignment, the name starts with the brand,
“Stock Number” becomes **SKU Code** and supplies the SKU, and specs become attribute
columns only for variable products (simple products keep the spec list in the description).
Images are renamed `Brand-Product-Name_yourstore_NN.ext`, primary image unnumbered.

**Two deliberate changes from the Python version:**

1. **Every outbound link is stripped except YouTube.** The Python tool only removed links
   back to the source store and kept external brand/manual links. Now a Hobbywing manual
   link is unwrapped too — its text survives, the link doesn't. YouTube links *and* embeds
   are kept.
2. Filenames also drop `& # % +`. Legal on disk, but they break the image URL WooCommerce
   builds from the filename.

## What works in a browser, and what doesn't

| | |
|---|---|
| **Shopify stores** | ✅ Works, images included. Tested live end to end. |
| **SHOPLINE, Cloudflare-protected stores, the JSON-LD fallback** | ❌ Blocked. Those servers don't send CORS headers, so the browser refuses to read them — nothing the page can do about it. |
| **Saving into a folder** | Chrome/Edge only (File System Access API). Other browsers get a `.zip` with the same contents. |

The Cloudflare problem that forced `curl_cffi` in the Python tool doesn't exist here — the
request comes from a real browser, so it looks legitimate by definition.

### Everything else: the same tool, as a script

The Listings tab has a **Download script (.zip)** button — it packages `tools/import_products.py`,
its `requirements.txt`, and a walkthrough README, live from this repo (so it's never out of
sync). Unzip it, `pip install -r requirements.txt` once, then
`python import_products.py "<url>"`. Same output format, same rules, so its `output/images/`
and `output/woocommerce_import.csv` drop into the same WooCommerce import flow.

If you paste a URL the browser can't reach, the card lights up on its own rather than leaving
you to find it.

## Differences from the spreadsheet

- The sheet's markup-tier columns added `0.001 × (markup amount)` — a stray artifact worth
  a few paise. Dropped; the tiers are a clean `landed × (1 + markup%)`.
- The sheet's "Total Profit of Order" cell was broken (`#REF!`). It's the order gross
  profit tile here, and it works.
- Customs duty was allocated through the same per-USD rate as freight, so the two share one
  "freight + duty" column. Enter them separately; they are allocated identically.
