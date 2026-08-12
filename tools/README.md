# Non-Shopify store importer

The Listings tab in the web app only reads Shopify stores — that's a hard browser
limitation (see the main README), not a missing feature. This script covers everything
else: SHOPLINE stores, Cloudflare-protected stores, and any store using standard
JSON-LD product data.

## One-time setup

Needs [Python 3](https://www.python.org/downloads/) (any recent version). Then, in this
folder:

```powershell
pip install -r requirements.txt
```

That installs `curl_cffi` (gets past Cloudflare's "403 Forbidden") and `certifi` (an
up-to-date CA bundle, since some Windows Python installs ship a stale one).

## Run it

```powershell
python import_products.py "https://some-store.com/products/some-product"
python import_products.py "https://.../a" "https://.../b"     # several at once
python import_products.py                                     # paste a list, blank line to finish
python import_products.py -f urls.txt                          # from a file
```

## What you get

A new `output/` folder appears next to the script:

- `output/images/` — every listing image, renamed `<Brand-Product-Name>_uavstore.jpg`
  (primary image), `_02`, `_03`, … for the rest.
- `output/woocommerce_import.csv` — same format, same rules (draft, no price, blank
  categories, brand-first names, "Stock Number" → SKU Code) as the web app produces.

Drag `output/images/` and `output/woocommerce_import.csv` into the web app's Listings
tab result the same way you'd use the app's own output — or just upload the CSV to
WooCommerce directly (**Media → Add New** the images first, then **Products → Import**).

If a store still can't be read, the script says so — send that link back for it to be
added.
