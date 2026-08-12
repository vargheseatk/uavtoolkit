#!/usr/bin/env python3
"""
UAV Store product importer.

Paste one or more product URLs (China Hobby Line, Quadkart, DRK Store, or any
Shopify / JSON-LD store) and this will:
  1. Download every listing image, renamed  <Brand-Product-Name>_uavstore_NN.jpg
  2. Build a WooCommerce-ready CSV.

Behaviour (per store owner's rules):
  - Products import as DRAFT (Published = -1).
  - Pricing is NOT exported; In stock? = 1, Backorders allowed? = 0.
  - Categories are left blank (assigned manually later).
  - Product name starts with the brand.
  - Specs -> attributes ONLY for variable products; simple products keep the
    spec list inside the description.
  - "Stock Number" is renamed to "SKU Code" and used as the SKU.
  - Links back to the SOURCE store (its category / collection / product pages)
    are stripped; YouTube and external brand/manual links are kept.

WooCommerce CSV columns follow the official import schema:
  https://github.com/woocommerce/woocommerce/wiki/Product-CSV-Import-Schema

Usage:
  python import_products.py <url> [<url> ...]
  python import_products.py            (then paste URLs, one per line, blank line to finish)
  python import_products.py -f urls.txt

Standard library only - nothing to pip install.
"""

import csv
import html
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

# curl_cffi impersonates a real browser's TLS fingerprint, which gets past
# Cloudflare bot protection (403 Forbidden) that plain urllib cannot.
# Install once with:  pip install curl_cffi
try:
    from curl_cffi import requests as _cffi
except Exception:  # noqa: BLE001
    _cffi = None

# Some Windows Python installs ship an outdated CA bundle; fall back gracefully.
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()
    _SSL_CTX.check_hostname = False
    _SSL_CTX.verify_mode = ssl.CERT_NONE

# ---------------------------------------------------------------------------
# Config - tweak these to taste
# ---------------------------------------------------------------------------
IMG_SUFFIX = "_uavstore"                   # goes before the _NN number
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
IMAGES_DIR = os.path.join(OUTPUT_DIR, "images")
CSV_PATH = os.path.join(OUTPUT_DIR, "woocommerce_import.csv")
# A realistic browser UA + headers gets past most basic bot filters (403 Forbidden).
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Shopify "options" that are NOT real product variations (warehouse pickers etc.)
JUNK_OPTIONS = {
    "title", "ship_from", "ship from", "ships from", "shipping", "warehouse",
    "location", "send from", "sent from", "country", "region", "dispatch",
}
# ---------------------------------------------------------------------------


def slugify(text):
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    return text.strip("-")


def brand_safe_name(title):
    """Filesystem-safe name that PRESERVES brand casing (CNHL stays capital, mAh stays)."""
    name = re.sub(r'[\\/:*?"<>|]+', "", title)      # drop illegal filename chars
    name = re.sub(r"\s+", "-", name.strip())        # spaces -> hyphens
    name = re.sub(r"-{2,}", "-", name)              # collapse repeats
    return name.strip("-")


def fetch(url, binary=False):
    parts = urlparse(url)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                   "image/avif,image/webp,*/*;q=0.8"),
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": f"{parts.scheme}://{parts.netloc}/",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }
    # Preferred path: curl_cffi (passes Cloudflare). Falls back to urllib.
    if _cffi is not None:
        r = _cffi.get(url, headers=headers, impersonate="chrome124",
                      timeout=40, allow_redirects=True)
        if r.status_code >= 400:
            raise urllib.error.HTTPError(url, r.status_code, "Forbidden", None, None)
        return r.content if binary else r.text
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
        data = resp.read()
    return data if binary else data.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# Fetching - normalized product dict regardless of source store:
#   {title, brand, body_html, images:[url], sku, categories, tags,
#    options:[{name,values}], variants:[{sku, values:[...]}], platform}
# ---------------------------------------------------------------------------
# SHOPLINE product images live under .../image/store/<storeId>/<folder>/<file>.
# Filenames may contain parentheses, e.g. GNB5501S100PHV-(6)_416x.jpeg.
_SHOPLINE_IMG_RE = re.compile(
    r'https?://[\w.\-]*myshopline\.com/image/store/\d+/\d+/'
    r'[\w()\-]+?\.(?:jpe?g|png|webp)', re.I)
_SIZE_SUFFIX_RE = re.compile(r'_\d+x(?=\.(?:jpe?g|png|webp)$)', re.I)


def _gallery_images(page_html):
    """Extract full-size product gallery URLs from raw HTML (SHOPLINE etc.)."""
    found = []
    for u in _SHOPLINE_IMG_RE.findall(page_html):
        if any(skip in u.lower() for skip in ("logo", "/shopline/", "icon", "favicon")):
            continue
        found.append(_SIZE_SUFFIX_RE.sub("", u))   # drop _416x / _1800x -> full size
    return found


def _dedupe_images(images):
    return list(dict.fromkeys(images))


def _from_shopify(url):
    data = json.loads(fetch(url + ".json"))
    p = data["product"]
    options = [{"name": o["name"], "values": list(o["values"])} for o in p.get("options", [])]
    variants = []
    for v in p.get("variants", []):
        vals = [v.get("option1"), v.get("option2"), v.get("option3")]
        vals = [x for x in vals if x is not None]
        variants.append({"sku": v.get("sku", "") or "", "values": vals})
    return {
        "title": p["title"],
        "brand": "",                                 # Shopify vendor is unreliable; derived from title
        "body_html": p.get("body_html", "") or "",
        "images": [img["src"] for img in p.get("images", [])],
        "sku": (p.get("variants") or [{}])[0].get("sku", "") or "",
        "categories": p.get("product_type", "") or "",
        "options": options,
        "variants": variants,
        "platform": "shopify",
    }


def _iter_jsonld_objects(page_html):
    for block in re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        page_html, re.I | re.S,
    ):
        try:
            data = json.loads(block.strip())
        except Exception:  # noqa: BLE001
            continue
        stack = [data]
        while stack:
            obj = stack.pop()
            if isinstance(obj, list):
                stack.extend(obj)
            elif isinstance(obj, dict):
                if "@graph" in obj:
                    stack.extend(obj["@graph"])
                yield obj


def _from_jsonld(url):
    page_html = fetch(url)
    product = None
    for obj in _iter_jsonld_objects(page_html):
        t = obj.get("@type", "")
        types = t if isinstance(t, list) else [t]
        if "Product" in types:
            product = obj
            break
    if not product:
        return None

    featured = product.get("image", [])
    if isinstance(featured, str):
        featured = [featured]
    featured = [urljoin(url, i) for i in featured if i]
    # JSON-LD usually lists only the featured image; pull the rest of the gallery
    # from the page. If the store names product photos after the model/SKU (e.g.
    # GNB5501S100PHV-(1).jpeg), keep only those and drop shared template banners.
    gallery = _gallery_images(page_html)
    token = re.split(r"[-_ ]", str(product.get("sku", "")))[0]
    if token and len(token) >= 5:
        named = [g for g in gallery
                 if token.lower() in g.rsplit("/", 1)[-1].lower()]
        if named:
            gallery = named
    images = _dedupe_images(featured + gallery)      # featured stays first
    if not images:
        images = [urljoin(url, m) for m in re.findall(
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            page_html, re.I)]

    brand = product.get("brand", "")
    if isinstance(brand, dict):
        brand = brand.get("name", "")

    return {
        "title": product.get("name", "").strip(),
        "brand": str(brand or "").strip(),
        "body_html": product.get("description", "") or "",
        "images": list(dict.fromkeys(images)),
        "sku": str(product.get("sku", "") or ""),
        "categories": str(product.get("category", "") or ""),
        "options": [],
        "variants": [],
        "platform": "json-ld",
    }


def fetch_product(url):
    url = url.strip().split("?")[0].rstrip("/")
    try:
        return _from_shopify(url)
    except Exception:  # noqa: BLE001
        pass
    prod = _from_jsonld(url)
    if prod and prod["title"]:
        return prod
    raise RuntimeError(
        "Couldn't read product data (not Shopify, no JSON-LD Product found). "
        "Send this link to Claude to add support for that store."
    )


# ---------------------------------------------------------------------------
# Parsing / cleaning helpers
# ---------------------------------------------------------------------------
STOCK_LABEL_RE = re.compile(r"stock\s*(?:number|no\.?|code)", re.I)
# used to pick the SKU value (Stock / Model / Item / Part / Article number, or SKU)
SKU_KEY_RE = re.compile(
    r"\b(?:sku|(?:stock|model|item|part|article)\s*(?:number|no\.?|code))\b", re.I)
SPEC_LINE_RE = re.compile(r"^.{1,45}?:\s+\S")     # "Key: Value" line


def ensure_html(body):
    """SHOPLINE and some stores give a plain-text description. Turn it into HTML,
    grouping consecutive 'Key: Value' lines into a spec list."""
    if "<" in body and ">" in body:
        return body                                # already HTML
    body = html.unescape(body)                     # &nbsp; -> \xa0 (stripped as blank)
    parts, bucket = [], []

    def flush():
        if bucket:
            parts.append("<ul>" + "".join(
                f"<li>{html.escape(x)}</li>" for x in bucket) + "</ul>")
            bucket.clear()

    for line in body.replace("\r", "").split("\n"):
        line = line.strip()
        if not line:
            flush()
        elif SPEC_LINE_RE.match(line):
            bucket.append(line)
        else:
            flush()
            parts.append(f"<p>{html.escape(line)}</p>")
    flush()
    return "\n".join(parts)


def parse_specs(body_html):
    """Pull a 'Specifications' <ul><li>Key: Value</li></ul> block into (key, value) pairs."""
    specs = []
    m = re.search(r"Specifications.*?<ul>(.*?)</ul>", body_html, re.I | re.S)
    if not m:
        m = re.search(r"<ul>(.*?)</ul>", body_html, re.I | re.S)
    if not m:
        return specs
    for li in re.findall(r"<li>(.*?)</li>", m.group(1), re.I | re.S):
        text = html.unescape(re.sub(r"<[^>]+>", "", li)).strip()
        if ":" in text:
            key, value = text.split(":", 1)
            key = key.strip()
            if STOCK_LABEL_RE.fullmatch(key):        # rule #4
                key = "SKU Code"
            specs.append((key, value.strip()))
        elif text:
            specs.append((text, ""))
    return specs


def clean_description(body_html, source_domain):
    """Strip links back to the SOURCE store; rename 'Stock Number' -> 'SKU Code'."""
    body = body_html
    if source_domain:
        # unwrap <a href="...sourcedomain...">text</a>  ->  text   (keeps external + youtube links)
        pattern = re.compile(
            r'<a\b[^>]*href="[^"]*' + re.escape(source_domain) + r'[^"]*"[^>]*>(.*?)</a>',
            re.I | re.S,
        )
        body = pattern.sub(r"\1", body)
    body = STOCK_LABEL_RE.sub("SKU Code", body)      # rule #4 (in visible text)
    return body


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "iframe"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "iframe") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.parts.append(data.strip())


def short_description(body_html):
    """First real paragraph of prose (skipping the specs list)."""
    text = re.sub(r".*?</ul>", "", body_html, count=1, flags=re.S)
    for para in re.findall(r"<p>(.*?)</p>", text, re.I | re.S):
        p = _TextExtractor()
        p.feed(para)
        joined = " ".join(p.parts)
        if len(joined) > 40:
            return joined
    p = _TextExtractor()
    p.feed(body_html)
    return " ".join(p.parts)[:300]


def image_extension(src):
    ext = os.path.splitext(src.split("?")[0])[1].lower()
    return ext if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif") else ".jpg"


def download_images(images, fname_base):
    os.makedirs(IMAGES_DIR, exist_ok=True)
    filenames = []
    for i, src in enumerate(images, start=1):
        num = "" if i == 1 else f"_{i:02d}"    # primary image is unnumbered
        fname = f"{fname_base}{IMG_SUFFIX}{num}{image_extension(src)}"   # keep extension on disk
        dest = os.path.join(IMAGES_DIR, fname)
        try:
            with open(dest, "wb") as f:
                f.write(fetch(src, binary=True))
            filenames.append(fname)
            print(f"    saved {fname}")
        except Exception as e:  # noqa: BLE001
            print(f"    ! failed {src}: {e}")
    return filenames


def real_variation_options(product):
    """Return [(index, name, [values])] for options that are genuine variations."""
    out = []
    for i, o in enumerate(product["options"]):
        name = (o.get("name") or "").strip()
        values = [v for v in o.get("values", []) if v]
        if name.lower() in JUNK_OPTIONS:
            continue
        if len(set(values)) > 1:
            out.append((i, name, values))
    return out


def base_row(sku, name="", images="", description="", short="", tags="", published=-1):
    """A WooCommerce row with the store's default flags."""
    return {
        "Type": "simple",
        "SKU": sku,
        "Name": name,
        "Published": published,
        "Is featured?": 0,
        "Visibility in catalog": "visible",
        "Short description": short,
        "Description": description,
        "In stock?": 1,
        "Backorders allowed?": 0,
        "Categories": "",                # rule #7 - assigned manually
        "Tags": tags,
        "Images": images,
        "Parent": "",
        "_attrs": [],                    # list of (name, value(s)) -> attribute columns
    }


def build_rows(url):
    source_domain = urlparse(url if "//" in url else "https://" + url).netloc
    product = fetch_product(url)

    title = product["title"]
    brand = product["brand"] or (title.split()[0] if title else "")
    # rule #5 - make sure the name starts with the brand
    if brand and not title.lower().startswith(brand.lower()):
        title = f"{brand} {title}".strip()

    body = ensure_html(product["body_html"])     # SHOPLINE plain-text -> HTML
    desc = clean_description(body, source_domain).strip()
    short = short_description(desc)
    tags = ", ".join(dict.fromkeys(          # rule #10 - brand + category, de-duped, no blanks
        t for t in [brand, product["categories"]] if t
    ))

    specs = parse_specs(body)
    # rule #4 - SKU from a Stock/Model/Item number spec, else the source SKU
    sku = next((v for k, v in specs if SKU_KEY_RE.search(k)), "")
    sku = (sku
           or product["sku"].split()[0]      # strip " US" style location suffix
           or slugify(title).upper()[:32])

    fname_base = brand_safe_name(title)
    print(f"  {title}  [{product['platform']}]")
    filenames = download_images(product["images"], fname_base)
    # files keep their extension on disk; the CSV references them without it
    images_cell = ", ".join(os.path.splitext(f)[0] for f in filenames)

    real_opts = real_variation_options(product)

    # ---- simple product -------------------------------------------------
    if not real_opts:
        row = base_row(sku, name=title, images=images_cell,
                       description=desc, short=short, tags=tags)
        return [row]                          # rule #8 - simple => no attribute columns

    # ---- variable product (parent + variation rows) ---------------------
    if len(real_opts) > 1:
        print(f"    ! {len(real_opts)} variation dimensions "
              f"({', '.join(n for _, n, _ in real_opts)}); using the first only")
    opt_index, opt_name, _ = real_opts[0]

    # distinct values in first-seen order, mapped to a representative variant sku
    seen = {}
    for v in product["variants"]:
        if opt_index < len(v["values"]):
            val = v["values"][opt_index]
            if val and val not in seen:
                seen[val] = v.get("sku") or f"{sku}-{slugify(val)}"

    parent = base_row(sku, name=title, images=images_cell,
                      description=desc, short=short, tags=tags)
    parent["Type"] = "variable"
    parent["_attrs"] = [(opt_name, ", ".join(seen.keys()))]
    rows = [parent]

    for val, vsku in seen.items():
        child = base_row(vsku or f"{sku}-{slugify(val)}")
        child["Type"] = "variation"
        child["Parent"] = sku
        child["Visibility in catalog"] = ""
        child["Published"] = ""
        child["_attrs"] = [(opt_name, val)]
        rows.append(child)
    return rows


BASE_COLUMNS = [
    "Type", "SKU", "Name", "Published", "Is featured?", "Visibility in catalog",
    "Short description", "Description", "In stock?", "Backorders allowed?",
    "Categories", "Tags", "Images", "Parent",
]


def write_csv(rows):
    max_attrs = max((len(r["_attrs"]) for r in rows), default=0)
    attr_columns = []
    for n in range(1, max_attrs + 1):
        attr_columns += [
            f"Attribute {n} name", f"Attribute {n} value(s)",
            f"Attribute {n} visible", f"Attribute {n} global",
        ]
    columns = BASE_COLUMNS + attr_columns

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = CSV_PATH
    try:
        f = open(path, "w", newline="", encoding="utf-8-sig")
    except PermissionError:
        # main CSV is locked (usually open in Excel) - write a timestamped copy
        import time
        path = os.path.join(OUTPUT_DIR, f"woocommerce_import_{time.strftime('%Y%m%d_%H%M%S')}.csv")
        print(f"  ! {os.path.basename(CSV_PATH)} is open/locked - writing {os.path.basename(path)} instead")
        f = open(path, "w", newline="", encoding="utf-8-sig")
    with f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            out = {k: v for k, v in r.items() if not k.startswith("_")}
            for n, (name, value) in enumerate(r["_attrs"], start=1):
                out[f"Attribute {n} name"] = name
                out[f"Attribute {n} value(s)"] = value
                out[f"Attribute {n} visible"] = 1
                out[f"Attribute {n} global"] = 0
            writer.writerow(out)
    return path


def read_urls(argv):
    if "-f" in argv:
        path = argv[argv.index("-f") + 1]
        with open(path, encoding="utf-8") as f:
            return [ln.strip() for ln in f if ln.strip()]
    urls = [a for a in argv if a.startswith("http")]
    if urls:
        return urls
    print("Paste product URLs, one per line. Blank line to finish:")
    urls = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            break
        urls.append(line)
    return urls


def main():
    urls = read_urls(sys.argv[1:])
    if not urls:
        print("No URLs given.")
        return
    all_rows = []
    for url in urls:
        print(f"\nFetching: {url}")
        try:
            all_rows.extend(build_rows(url))
        except Exception as e:  # noqa: BLE001
            print(f"  ! error: {e}")
    if all_rows:
        csv_path = write_csv(all_rows)
        products = sum(1 for r in all_rows if r["Type"] != "variation")
        print(f"\nDone. {products} product(s), {len(all_rows)} CSV row(s).")
        print(f"  CSV:    {csv_path}")
        print(f"  Images: {IMAGES_DIR}")


if __name__ == "__main__":
    main()
