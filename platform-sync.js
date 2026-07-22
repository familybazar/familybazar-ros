/**
 * Family Bazar — ROS → Platform connector (pusher)
 * ------------------------------------------------------------------
 * Reads the ROS catalog/stock from data.json and pushes it to the customer platform's
 * secured sync endpoint (POST /api/connector/sync). Idempotent — safe to run repeatedly.
 * Zero dependencies (Node 18+ global fetch). Does NOT touch server.js.
 *
 * SETUP
 *   1. Copy platform-sync.config.example.json → platform-sync.config.json and fill it in:
 *        { "url": "https://<platform>/api/connector/sync",
 *          "secret": "<same as ROS_SYNC_SECRET on the platform>",
 *          "locationCode": "brooklyn-liberty", "batchSize": 200 }
 *   2. Test SMALL first:   node platform-sync.js --limit 20
 *   3. Full run:           node platform-sync.js
 *   4. Preview only:       node platform-sync.js --dry-run --limit 5
 *   5. Schedule it (Windows Task Scheduler → every 5 minutes):
 *        Program:  node
 *        Arguments: platform-sync.js
 *        Start in:  D:\Automation\ros-server
 *
 * FLAGS
 *   --limit N     only send the first N products (great for a quick test)
 *   --batch N     override batchSize for this run
 *   --dry-run     build + validate the payload and print a sample, but send nothing
 *
 * Config comes from platform-sync.config.json, or env vars
 * PLATFORM_SYNC_URL / PLATFORM_SYNC_SECRET / LOCATION_CODE (env wins).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;

// ── TEMPORARY (testing) ──────────────────────────────────────────────────────
// Force every product to this on-hand count so the whole catalog shows as "in stock"
// on the customer platform. Set FORCE_STOCK to null once real ROS stock counts are ready
// (then the connector uses each product's real `qty` again). Can also be overridden per run
// with the env var PLATFORM_SYNC_FORCE_STOCK (e.g. PLATFORM_SYNC_FORCE_STOCK=25 node platform-sync.js).
const FORCE_STOCK =
  process.env.PLATFORM_SYNC_FORCE_STOCK != null
    ? Math.max(0, Math.trunc(+process.env.PLATFORM_SYNC_FORCE_STOCK) || 0)
    : 10;

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { limit: 0, batch: 0, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run" || t === "--dry") a.dryRun = true;
    else if (t === "--limit") a.limit = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (t === "--batch") a.batch = Math.max(1, parseInt(argv[++i], 10) || 0);
    else if (t.startsWith("--limit=")) a.limit = Math.max(0, parseInt(t.slice(8), 10) || 0);
    else if (t.startsWith("--batch=")) a.batch = Math.max(1, parseInt(t.slice(8), 10) || 0);
  }
  return a;
}

function loadConfig() {
  let cfg = {};
  const cfgPath = path.join(DIR, "platform-sync.config.json");
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) {
      console.error("Bad platform-sync.config.json:", e.message); process.exit(1);
    }
  }
  const url = process.env.PLATFORM_SYNC_URL || cfg.url;
  const secret = process.env.PLATFORM_SYNC_SECRET || cfg.secret;
  const locationCode = process.env.LOCATION_CODE || cfg.locationCode || "brooklyn-liberty";
  const batchSize = Number(cfg.batchSize || 200);
  if (!url || !secret || /PASTE-YOUR|REPLACE-WITH/i.test(secret)) {
    console.error("Missing/placeholder url or secret. Fill platform-sync.config.json (or env vars).");
    process.exit(1);
  }
  return { url, secret, locationCode, batchSize };
}

function loadProducts() {
  // Honor ROS_DATA_DIR so the cloud deploy (persistent disk) and the local run both find data.json.
  const dataDir = process.env.ROS_DATA_DIR || DIR;
  const dataPath = path.join(dataDir, "data.json");
  if (!fs.existsSync(dataPath)) { console.error("data.json not found in", dataDir); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  return Array.isArray(data.products) ? data.products : [];
}

function num(v) { return v === "" || v == null ? null : Number(v); }

// Turn raw register names ("10 2 stainless blades rzrs") into presentable titles for the website.
// Deterministic + idempotent. Mirrors the site's cleanTitle so search/display stay consistent.
const _ACR = new Set(["USB","LED","LCD","OLED","HDMI","TV","PVC","EVA","ABS","XL","XXL","XS","SD","HD","AA","AAA","AC","DC","3D","ID","US","USA","NY","SPF","UV","BBQ","DIY","PU","RGB","IP","ML","OZ","LB","FT"]);
const _ABBR = { rzrs:"Razors", rzr:"Razor", asst:"Assorted", asstd:"Assorted", pk:"Pack", pkt:"Packet", pcs:"Pieces", ct:"Count", "w/":"with", blk:"Black", wht:"White", grn:"Green", yel:"Yellow", ylw:"Yellow", choc:"Chocolate", med:"Medium", lg:"Large", sm:"Small", pr:"Pair", btl:"Bottle", cont:"Container", dispsble:"Disposable", disp:"Disposable", stnls:"Stainless", plas:"Plastic", asrt:"Assorted" };
function cleanName(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^[^A-Za-z0-9]+/, "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const words = s.split(" ").map((w) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9/]/g, "");
    if (_ABBR[bare]) return _ABBR[bare];
    const up = w.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (_ACR.has(up)) return up;
    if (/^\d/.test(w)) return w.toLowerCase();
    if (/[a-z]/.test(w) && /[A-Z]/.test(w) && w[0] === w[0].toUpperCase()) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
  return words.join(" ").replace(/^./, (c) => c.toUpperCase());
}

// ── Automatic public categorization ──────────────────────────────────────────
// Every product that syncs gets a clean, customer-facing category computed from its name/brand — no
// manual step. A staff override (product.publicCategory, set in the ROS Categories tab) always wins;
// otherwise these rules decide. Ordered specific→general; `not` blocks false positives.
const CATEGORY_RULES = [
  { name: "Screen Protectors", any: ["screen protector", "tempered glass", "screen guard"] },
  { name: "Phone Cases", any: ["phone case", "case for", "otterbox", "silicone case", "phone cover", "flip case", "wallet case"] },
  { name: "Cables", any: ["cable", "charging cable", "usb cable", "lightning cable", "aux cord", "hdmi", "charging cord", "data cable", "extension cord"], not: ["charger block", "wall charger", "car charger", "power adapter", "headphone", "earbud"] },
  { name: "Chargers & Adapters", any: ["charger", "charging block", "wall charger", "car charger", "power adapter", "adapter", "type-c charger", "usb-c charger", "wireless charger", "magsafe", "charging dock", "charging pad"], not: ["headphone", "earbud"] },
  { name: "Headphones & Audio", any: ["headphone", "earphone", "earbud", "airpod", "earpod", "headset"] },
  { name: "Speakers", any: ["speaker", "soundbar"], not: ["headphone"] },
  { name: "Power Banks", any: ["power bank", "powerbank", "portable charger"] },
  { name: "Smartwatches", any: ["smartwatch", "smart watch", "apple watch", "galaxy watch", "fitness tracker", "watch band"] },
  { name: "Phones", any: ["iphone", "galaxy", "pixel", "smartphone", "cell phone", "android phone"], not: ["case", "cover", "charger", "cable", "screen", "protector", "headphone", "earbud", "airpod", "earpod", "watch", "band", "holder", "mount", "adapter"] },
  { name: "Batteries", any: ["battery", "batteries", "aaa", "9v", "coin cell", "button cell"], not: ["power bank"] },
  { name: "Smart Home & Lighting", any: ["smart bulb", "smart plug", "led bulb", "light bulb", "flashlight", "alexa", "echo", "smart light", "lamp"] },
  // Memory/storage + computer accessories + misc gadgets fold into the electronics catch-all so they
  // still surface on /electronics under "Other electronics" (matches the 12-category storefront taxonomy).
  { name: "Other Electronics", any: ["sd card", "memory card", "flash drive", "usb drive", "micro sd", "mouse", "keyboard", "webcam", "router", "laptop stand", "hdmi splitter", "usb hub", "card reader"] },
  { name: "Beauty & Personal Care", any: ["shampoo", "conditioner", "lotion", "body wash", " soap", "cream", "sunscreen", "deodorant", "perfume", "cologne", "razor", "shaving", "cosmetic", "makeup", "lipstick", "nail", "hair"] },
  { name: "Health & Wellness", any: ["vitamin", "medicine", "bandage", "first aid", "pain relief", "supplement", "thermometer", "sanitizer"] },
  { name: "Household & Cleaning", any: ["detergent", "cleaner", "bleach", "wipes", "trash bag", "paper towel", "tissue", "sponge", " mop", "broom", "aluminum foil", "foil", "plastic wrap", "hanger", "air freshener", "laundry"] },
  { name: "Kitchen & Dining", any: ["plate", "bowl", " cup", "mug", "utensil", "cookware", "frying pan", " pot", "container", "cutlery", "spoon", "fork", "food storage"] },
  { name: "Snacks & Candy", any: ["chocolate", "candy", "chips", "cookie", "snack", " gum", "mint", "gummy", "biscuit", "cracker"] },
  { name: "Beverages", any: ["water", "soda", "juice", "soft drink", "coffee", " tea", "energy drink", "beverage"] },
  { name: "Baby & Kids", any: ["diaper", "baby", "formula", "pacifier"] },
  { name: "Toys & Games", any: [" toy", "game", "puzzle", "doll", "magnet", "figure", "blocks", "play set", "plush", "stuffed", "slime", "kite", "playing card", "action fig", "building block", "play food", "cutting food"] },
  { name: "Stationery & Office", any: [" pen", "pencil", "notebook", "marker", "highlighter", "binder", "stapler", "folder", "envelope", "sticker", "crayon", "coloring", "color set", "colors set", "colors", "paint", "glitter", "notepad", "sticky note", "eraser", "glue", "tape", "ruler", "chalk", "scissors"] },
  { name: "Party & Seasonal", any: ["balloon", "party", "gift wrap", "decoration", "candle", "ornament", "greeting card", "streamer", "confetti", "wrapping paper"] },
  { name: "Apparel & Accessories", any: [" sock", "socks", " glove", " hat", "scarf", "t-shirt", "tshirt", "underwear", " belt", "sunglasses", "jewelry", "necklace", "bracelet", "earring", " ring ", "hair tie", "scrunchie", "headband", "wallet"] },
  { name: "Home & Decor", any: ["picture frame", "photo frame", " vase", " clock", "curtain", " rug", "pillow", "cushion", "mirror", "decor", "wall art", "artificial flower", "fake flower", "faux flower", "figurine"] },
  { name: "Pet Supplies", any: [" dog ", "cat food", " pet ", "leash", "litter", "pet toy", "dog toy", "cat toy", "pet food"] },
];
const BRAND_CATEGORY = {
  "Beauty & Personal Care": ["dove", "nivea", "olay", "vaseline", "palmolive", "axe", "old spice", "gillette", "colgate", "crest", "sensodyne", "listerine", "head & shoulders", "pantene", "tresemme", "garnier", "loreal", "l'oreal", "maybelline", "neutrogena", "aveeno", "cerave", "eos", "chapstick", "suave", "herbal essences", "cantu", "shea moisture", "veet", "schick", "st ives", "jergens", "cetaphil", "carmex", "secret", "degree", "irish spring", "dial", "caress", "lux", "pond", "fair & lovely"],
  "Household & Cleaning": ["glade", "febreze", "lysol", "clorox", "windex", "tide", "downy", "gain", "ajax", "fabuloso", "pine-sol", "mr clean", "arm & hammer", "bounty", "charmin", "scott", "ziploc", "hefty", "glad", "reynolds", "dawn", "cascade", "swiffer", "pledge", "raid", "off", "angel soft", "cottonelle", "purell", "method", "seventh generation"],
  "Snacks & Candy": ["ferrero", "hershey", "cadbury", "mars", "snickers", "kit kat", "kitkat", "oreo", "lays", "doritos", "pringles", "haribo", "jolly rancher", "skittles", "m&m", "twix", "nutella", "ritz", "cheetos", "goldfish", "trolli", "airheads", "nerds", "starburst", "reeses", "welch", "nabisco", "lindt", "toblerone", "kinder"],
  "Beverages": ["coca-cola", "coca cola", " coke", "pepsi", "sprite", "fanta", "gatorade", "red bull", "monster", "tropicana", "minute maid", "lipton", "nestea", "arizona", "snapple", "powerade", "capri sun", "poland spring"],
  "Batteries": ["duracell", "energizer", "rayovac"],
  "Baby & Kids": ["pampers", "huggies", "johnson", "gerber", "enfamil", "similac", "luvs"],
  "Stationery & Office": ["bic", "sharpie", "crayola", "elmer", "post-it", "papermate", "expo", "ticonderoga"],
  "Health & Wellness": ["tylenol", "advil", "motrin", "band-aid", "bandaid", "centrum", "emergen-c", "robitussin", "pepto", "tums", "zyrtec", "claritin", "benadryl", "vicks", "halls", "airborne"],
  "Headphones & Audio": ["jbl", "beats", "skullcandy", "bose", "airpod"],
  "Chargers & Cables": ["anker", "belkin", "mophie"],
};
function suggestCategory(p) {
  const hay = (" " + (p.name || "") + " " + (p.brand || "") + " " + (p.category || "") + " " + (p.subcategory || "") + " ").toLowerCase();
  for (const r of CATEGORY_RULES) {
    if (r.not && r.not.some((t) => hay.includes(t))) continue;
    if (r.any.some((t) => hay.includes(t))) return r.name;
  }
  for (const cat of Object.keys(BRAND_CATEGORY)) {
    if (BRAND_CATEGORY[cat].some((b) => hay.includes(b))) return cat;
  }
  return null;
}
function categoryFor(p) {
  if (p.publicCategory && String(p.publicCategory).trim()) return String(p.publicCategory).trim(); // staff override wins
  return suggestCategory(p) || p.category || null;
}

// Map a ROS product to the platform connector contract.
function toItem(p) {
  return {
    sourceId: String(p.id),
    sku: p.sku || null,
    barcode: p.barcode || null,
    name: (p.displayName && String(p.displayName).trim()) ? String(p.displayName).trim() : cleanName(p.name),
    brand: p.brand || null,
    description: p.description || null,
    // Image hierarchy: manufacturer/barcode-db → supplier → store-captured photo. Null means the
    // storefront renders its category placeholder — a missing photo never withholds the product.
    imageUrl: p.image || p.supplierImage || p.storePhoto || null,
    // Automatic: staff override (publicCategory) → rule/brand auto-category → raw POS category.
    category: categoryFor(p),
    retailPrice: num(p.retailPrice),
    salePrice: num(p.salePrice),
    costPrice: num(p.costPrice),
    deliverable: !!p.websiteEnabled,
    // Local delivery is ON by default (broad catalog); staff exclude a product by setting it false.
    localDeliveryEnabled: p.localDeliveryEnabled !== false,
    // Nationwide shipping is curated/opt-in — only products staff explicitly flag.
    nationwideShippingEnabled: !!p.nationwideShippingEnabled,
    source: p.source || null,
    onHand: FORCE_STOCK != null ? FORCE_STOCK : Number.isFinite(+p.qty) ? Math.trunc(+p.qty) : 0,
    reorderAt: Number.isFinite(+p.reorderThreshold) ? Math.trunc(+p.reorderThreshold) : null,
    aisle: p.aisle || null,
    shelf: p.shelf || null,
    bin: p.bin || null,
    lastSoldAt: p.lastSale ? safeIso(p.lastSale) : null,
  };
}
function safeIso(v) { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postBatchOnce(cfg, items) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ros-secret": cfg.secret },
    body: JSON.stringify({ locationCode: cfg.locationCode, products: items }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json.detail || json.error || text || "").toString().slice(0, 400);
    const err = new Error("HTTP " + res.status + " " + msg);
    // 5xx and connectivity-ish 400s are worth retrying; a plain 401/403 is not.
    err.retryable = res.status >= 500 || /circuit|too many|reach database|timed out|connection|ingest_failed/i.test(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Retry a batch with exponential backoff. Gives a struggling DB pool time to recover.
async function postBatch(cfg, items, label) {
  const delays = [2000, 5000, 15000, 40000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await postBatchOnce(cfg, items);
    } catch (e) {
      lastErr = e;
      if (e.retryable === false || attempt === delays.length) break;
      const wait = delays[attempt];
      console.warn(`\n  ${label} failed (${e.message.slice(0, 120)}). Retry in ${wait / 1000}s…`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  if (args.batch) cfg.batchSize = args.batch;

  let products = loadProducts().filter((p) => (p.name || "").trim());
  if (args.limit) products = products.slice(0, args.limit);
  if (!products.length) { console.log("No products to sync."); return; }

  const items = products.map(toItem);

  if (args.dryRun) {
    console.log(`DRY RUN — ${items.length} product(s) would be sent to ${cfg.url}`);
    console.log("Sample payload item:\n", JSON.stringify(items[0], null, 2));
    return;
  }

  const totals = { received: 0, created: 0, updated: 0, stockChanged: 0, skipped: 0, errors: 0 };
  const batches = Math.ceil(items.length / cfg.batchSize);
  console.log(`Syncing ${items.length} product(s) in ${batches} batch(es) of ${cfg.batchSize} to ${cfg.url}`);

  let batchNo = 0;
  for (let i = 0; i < items.length; i += cfg.batchSize) {
    batchNo++;
    const slice = items.slice(i, i + cfg.batchSize);
    try {
      const r = await postBatch(cfg, slice, `Batch ${batchNo}/${batches}`);
      for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
      process.stdout.write(".");
    } catch (e) {
      totals.errors += slice.length;
      console.error(`\nBatch ${batchNo}/${batches} gave up: ${e.message}`);
      // If the DB is unreachable, later batches will fail too — stop rather than hammer it.
      if (/circuit|too many|reach database|authentication/i.test(e.message)) {
        console.error("Aborting: the platform can't reach its database. Fix the connection and re-run.");
        break;
      }
    }
    await sleep(150); // be gentle on the connection pool
  }

  console.log(
    `\nDone. received ${totals.received}, created ${totals.created}, updated ${totals.updated}, ` +
    `stock changed ${totals.stockChanged}, skipped ${totals.skipped}, errors ${totals.errors}`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
