# Family Bazar ROS — Server Setup Guide

This is the **shared-backend** version of your Retail Operating System. Instead of living
in one tablet's browser, your data now lives on one computer (a small server), and every
tablet, phone, or PC on the same WiFi sees the **same live data**.

It also adds:
- **AI barcode cataloging** — scan a UPC and the system looks it up and auto-writes the
  product name, description, category, and tags for staff to approve.
- **Clover live sync** — pull items straight from your Clover account.
- **CSV bridge** — import/export the product files NRS and Clover already produce.

---

## 1. One-time setup (about 5 minutes)

### Install Node.js
1. Go to **https://nodejs.org** and download the **LTS** version for your computer.
2. Install it (just click Next through the installer).
3. This gives you the `node` command. You need **version 18 or newer** (the LTS download is fine).

### Start the server
1. Put the `ros-server` folder anywhere on your back-office PC (it already contains
   `server.js` and the `public` folder).
2. Open a terminal in that folder:
   - **Windows:** open the `ros-server` folder, click the address bar, type `cmd`, press Enter.
   - **Mac:** right-click the folder → *New Terminal at Folder*.
3. Type this and press Enter:
   ```
   node server.js
   ```
4. You'll see something like:
   ```
   Family Bazar ROS server is running.
   On THIS computer:   http://localhost:4000
   On tablets (WiFi):  http://192.168.1.25:4000
   ```

### Open it
- On the **same PC**: open `http://localhost:4000` in a browser.
- On a **tablet/phone on the store WiFi**: open the `http://192.168.x.x:4000` address it printed.
  (Bookmark it / "Add to Home Screen" on the entrance tablet.)

Leave that terminal window open while the store is using it. Closing it stops the server.
The little **● live** badge in the top bar turns green when a device is connected to the server.

> **Tip:** To have it start automatically when the PC boots, you can later set it up as a
> Windows service (e.g. with `pm2` or Task Scheduler). Ask me and I'll walk you through it.

---

## 2. Load your products

Any of these work (Staff/Admin → **Settings**, or **Products**):
- **Scan / AI Add** — scan a barcode, review the auto-filled details, Save.
- **Import CSV** — upload your `FamilyBazar-100-products.csv` (or an NRS/Clover export).
- **Sync from Clover** — pull items live (after step 3).

**Product sources & cleanup.** Every product carries a **Source** tag — *Clover, NRS, Manual, Sample,*
or *Other* — shown as a colored badge in the Products list. Clover sync tags items **Clover**; CSV
imports let you pick the source (e.g. **NRS** for a pricebook) and now **upsert by SKU/barcode** so
re-importing updates instead of duplicating. Use **🏷️ Tag sources** to auto-classify everything
(it checks Clover live and flags leftover demo items as **Sample**), then filter by source and use
**🗑 Delete <source>** to remove the samples while keeping Clover + NRS. If you delete a real item by
mistake, just re-run the relevant sync/import to bring it back.

After a Clover import, items arrive with just name/price/SKU. Click **🪄 Enrich all** (Products tab) to
auto-fill **category, image, description, and brand** for everything missing them — it runs in batches
(best with a UPC key + AI key in Settings). Aisle/shelf can't be guessed, so add those per product for
the kiosk; for the website, flag the items and publish.

---

## Analytics & AI assistant

The **Analytics** tab now includes:
- **Cost & Profit columns** in Products (Products tab) — profit and margin %, color-coded.
- **Sales by channel** — revenue and units for Today / 7 days / This month, split into **Total, Clover,
  NRS, Website**. (Populated by the POS + web sales syncs.)
- **Potential profit** stat (inventory retail minus cost).
- **Reorder suggestions** — items at/below reorder level with a suggested order quantity and supplier.
- **Overstock → Promo** — click **Promo** on an overstock item, enter a % off, and ROS sets the sale
  price (then publish to the website to push it live).
- **🤖 AI assistant** (needs an AI key in Settings):
  - **What to stock** — seasonal/occasion buying ideas based on the date, your departments, failed
    searches, and customer requests.
  - **Reorder list** — an AI-prioritized purchase list grouped by supplier.
  - **Promo ideas** — suggested discounts and one-line promos for your overstock.

Clover sync also now **pulls each item's category** (department) into ROS, so products aren't all "Other."

## 3. Turn on the integrations (optional, when you're ready)

Go to **Staff/Admin → Settings**. Keys are stored **on the server only** and are never sent
back to the tablets.

### AI barcode cataloging
1. **Barcode lookup (free, automatic):** ROS checks **Open Food Facts** first — free, no key, no
   daily cap (~15/min), with strong coverage for groceries, snacks, drinks, and household. It only
   falls back to UPCitemdb's 100/day trial if there's no match. A UPCitemdb key (optional) adds
   coverage for non-food items.
2. **AI key (recommended):** choose your provider (Anthropic or OpenAI), paste your API key,
   and optionally set the model. With a key set, scans come back with a clean, written-out
   title, description, category, and tags. Without it, you still get the raw lookup + manual fields.
3. Click **Save AI / lookup keys**. Then try **Products → Scan / AI Add**.

### Clover live sync
1. Create a free **Clover developer account** at **https://www.clover.com/developers**.
2. Create an app, then generate an **API token** for your merchant
   (Clover dashboard → your app → *API tokens*, or use OAuth for production).
3. In ROS Settings, enter your **Merchant ID**, the **API token**, pick your **region**
   (US Production for most US stores), and click **Save Clover settings**.
4. Click **⟳ Sync from Clover now** — it imports/updates items by SKU/UPC.

> NRS has no public API, so for NRS use the **CSV bridge**: export your products from the
> NRS portal (Advanced Data → Export), then **Import CSV** here.

### Website (WooCommerce) — push items to familybazarny.com
Your site runs WordPress + WooCommerce, which has an official REST API. To connect:
1. In WordPress admin go to **WooCommerce → Settings → Advanced → REST API → Add key**.
2. Description: "Family Bazar ROS"; User: an admin; Permissions: **Read/Write**. Click **Generate API key**.
3. Copy the **Consumer key** (`ck_…`) and **Consumer secret** (`cs_…`) — they're shown only once.
4. In ROS → **Settings → Website (WooCommerce)**: paste the **Store URL** (`https://familybazarny.com`),
   the consumer key, and the secret. Click **Save website settings**, then **Test connection**
   (you want the green "Connected" message).

**Publishing items:**
- Flag the products you want online: in **Products**, edit an item and tick **Website** under
  Marketplace Channels — or use the quick checkboxes at the bottom of the **Website** tab.
- Go to the **Website** tab, select items, and click **Publish selected** (or **Publish all flagged**).
- **Go live switch** (Website tab): *Draft (review first)* creates new items as Drafts for you to
  approve in WordPress; *Publish live* sends them straight to the storefront (and re-publishing an
  existing draft takes it live). Switching to live shows a confirmation first.
- The storefront shows only **In stock / Out of stock** (your exact counts stay private).
- Matching is by **SKU**, so publishing the same item again **updates** it instead of duplicating.
- **Images upload automatically:** if a product has an image in ROS, WooCommerce pulls it into your
  media library on publish — no manual upload. Items added via **Scan / AI Add** already include a
  photo. For items without one (e.g. CSV-imported), click **🖼️ Fetch missing images** in the Website
  tab to auto-pull photos from the barcode database, then publish. (A UPCitemdb key in Settings is
  recommended before fetching for many items, since the free trial lookup is rate-limited.) The same
  image isn't re-uploaded on later publishes.
- Flip on **Auto-sync** (top-right of the Website tab) to have ROS push flagged items that are new
  or changed every few minutes, hands-free.

> Categories are mapped to your site's taxonomy automatically (e.g. Grocery/Snacks/Beverages →
> "Food, Candy & Drinks", Household → "Household Supplies", Pet → "Pet Supplies"). Items without a
> matching category are still published — just assign a category in WordPress if needed.

### Website orders → reduce stock
ROS can pull paid online orders and lower your stock so store + web stay in sync.
- In the **Website** tab, the **Web orders → stock** panel has **Sync web orders now** (manual) and
  **Auto-pull orders every few minutes** (hands-off).
- Each order line is matched to a ROS product by **SKU**; the quantity is subtracted and logged as a
  sale (it shows in Inventory history and the Sales metrics). Lines whose SKU isn't in ROS are listed
  as "no SKU match" so you can correct the SKU.
- Only **paid** orders (status *processing* or *completed*) reduce stock; each order is applied once.
- Your WooCommerce API key already has Read access, so no extra setup is needed.

> Note: because the site shows in/out-of-stock only (not exact counts), there's a small window between
> syncs where the same item could oversell. For most low-volume items this is fine; if you want hard
> stock enforcement on the site later, we can switch the site to WooCommerce-managed stock.

### In-store POS sales → reduce stock
Keep your shelf counts honest by feeding register sales back into ROS. Open the **Inventory** tab —
the **POS sales → stock** panel handles both systems:

**Clover (live):**
- Uses the same Clover Merchant ID + API token you set for item sync (Settings → Clover).
- Click **Sync Clover sales now**, or turn on **Auto-pull Clover sales** to do it every few minutes.
- ROS reads your **paid** Clover orders, matches each line to a product by **SKU or barcode**, subtracts
  the units, and logs the sale. Each order is applied once. Unmatched lines are flagged "no match".

**NRS (CSV — manual or automated):**
- NRS has no public API, so it works from a sales CSV. You can do it **manually** — click **Import NRS
  sales CSV** and pick the file — or set up the **automated folder watch** below.
- ROS auto-detects the columns — it needs a **quantity** column plus a **barcode/UPC** or **SKU** column
  (any common header names work). Click **CSV template** to see the expected shape.
- Each row subtracts that many units from the matched product and logs it to stock history.

**NRS automated import (folder watch):**
1. You need a **per-item sales CSV** from NRS. Turn on **Advanced Data** (NRS premium add-on) — it lets
   you export sales by item to CSV/Excel from the POS or the *My NRS Store* portal.
2. In ROS → Inventory → **NRS auto-import folder**, note the folder path shown (default
   `…\ros-server\nrs-inbox`), or set your own with **Set folder**. Turn on **Watch & auto-import**.
3. Put your NRS sales CSVs into that folder. Every minute ROS imports any new file, subtracts the sold
   units, logs them, and moves the file to a `processed` subfolder. Identical files are skipped, so you
   won't double-count. The panel shows a log of what was imported.
4. **To make it fully hands-off:** have NRS email the sales report to your inbox, then add an email rule
   that saves the attachment into the watch folder automatically (e.g. a Gmail filter + Google Drive
   for desktop, or a Power Automate / Zapier "save attachment to folder" step). Once a file lands, ROS
   does the rest — no clicks. (Tell me your email setup and I'll help wire this part.)

> Tip: export **incremental** reports (e.g. one file per day), not a running cumulative total, so each
> import reflects only that period's sales.

> Both paths create "Stock decrease" events, so POS sales show up in **Inventory history** and the
> **Sales metrics** on the dashboard. Refunds aren't auto-added back yet — adjust those manually via
> the product's **Stock** button if needed.

### Google Shopping feed (free listings)
ROS serves a product feed at **`/feed/google.xml`** containing your published website items.
- In the **Website** tab → **Google Shopping feed**, click **View feed** or **Download feed**, and
  you'll see the feed URL.
- In **Google Merchant Center → Products → Feeds**, add a **scheduled fetch** pointing to that URL.
  Google must be able to reach it from the internet — so this works once ROS is **hosted in the cloud**.
  On the local-only server, use **Download feed** and upload the file manually in Merchant Center.
- Items appear in the feed only after they're **published to the website** (they need a live product
  page) and have a price. Photos and barcodes (GTIN) are included automatically when present.

---

## 4. Backups
Settings → **Export backup (JSON)** saves a full copy. Keep one off the PC (USB/Drive).
To move to a new computer: copy the `ros-server` folder (including `data.json`).

---

## 5. Moving to the cloud later (so it works outside the store)
The server is plain Node with no special dependencies, so it runs as-is on any host
(Render, Railway, Fly.io, a small VPS, etc.). The steps are: push the `ros-server` folder
to the host, set the `PORT` it gives you, and run `node server.js`. Your data file and keys
move with it. When you're ready, tell me your preferred host and I'll give you exact steps
plus a login/password layer (the local version has no password because it's WiFi-only).

---

## Files in this folder
| File | What it is |
|------|-----------|
| `server.js` | The server. Run it with `node server.js`. |
| `public/index.html` | The app (kiosk + admin) the server serves. |
| `data.json` | Your live data. Created automatically. **This is your store.** |
| `secrets.json` | Your API keys/tokens. Created automatically. **Keep private.** |
| `SETUP-GUIDE.md` | This guide. |

## Security notes
- The local server has **no password** — anyone on your store WiFi can open it. That's fine
  for in-store use; don't expose port 4000 to the public internet without adding a login first.
- `secrets.json` holds your keys in plain text on the PC. Keep the PC itself secured.
- Never paste API keys into a chat or email — enter them only in the Settings screen.
