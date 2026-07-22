# ROS → PB UI migration (Phase 2)

The new PB UI (`preview.html`) is now the **primary ROS**, served at `/`. The old UI is still there at
`/classic` as a fallback.

## What was ported into the PB UI

Three operational screens now exist as sidebar items, wired to the same backend endpoints the old UI used:

- **Catalog Health** — published count, the ten enrichment flags with counts, click a flag to list its
  products, auto-naming toggle, weak-name threshold, "enrich next batch", "publish all eligible".
- **Receiving** — upload a supplier invoice (PDF/photo) → auto-extract → review lines (pack, cases,
  case cost, units-in) → match products → approve & post to inventory with case-pack math; undo posting.
- **Fulfillment** — the live web pickup/delivery/repair queue: KPI counts, filter chips, cards with
  accept → preparing → ready & notify → picked up, discount-at-register hints, pickup-slot chips, and a
  customer profile drawer (tags, activity) reachable from each card.

Also: the sidebar shows the real logged-in user (or "Guest" while auth is off) and, for owners, a
"preview as" role switch.

## Roles in the PB UI

Staff see: Overview, Products, Catalog Health, Inventory, Receiving, Fulfillment. Manager and Owner see
everything. (When auth is off for the review build, everyone is an owner-level guest.)

## Now fully ported (parity pass)

Everything operational is in the PB UI:

- **Products** — Fill images, Image coverage checker, Enrich all, edit/stock/scan (scan opens `/classic`).
- **Integrations** — every connector (AI, Clover, WooCommerce, Twilio, SendGrid, NRS folder) **plus
  NRS-by-Gmail** (IMAP settings + "Fetch now"). Data Center: Clover import, NRS product CSV import,
  NRS inventory CSV import, pull website signups, Clover sales sync, WooCommerce order sync, remove web
  duplicates, tag product sources, exports, backup.
- **Sales** — the by-day breakdown panel (verify NRS/Clover/Web totals; $0 days flagged) at 14/30/90 days.
- **Catalog Health, Receiving, Fulfillment** — the three operational screens.

`/classic` remains as a fallback and still hosts the barcode Scan / AI import wizard and the loyalty
program-terms form (reached via "Configure →").

## Verifying it loads

Because the PB UI is now the default, a JavaScript error would blank the main screen. To check before
relying on it:

```
cd /d D:\Automation\ros-server
node check-preview.js
```

It prints `OK` or the exact line of any syntax error. If the browser page is ever blank, open the
classic UI at `http://localhost:4000/classic` and press F12 → Console to see the error.

## Test checklist

1. `node server.js`, open `http://localhost:4000` → PB dashboard loads.
2. Catalog Health → counts show; click a flag → product list; "Enrich next batch" runs.
3. Receiving → upload a real invoice → lines appear → approve & post → stock updates.
4. Fulfillment → a website pickup shows as a card → Accept → Ready & notify → Picked up.
5. `/classic` still opens the old UI.
