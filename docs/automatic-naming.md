# Catalog publication & background enrichment

**The rule: publish every active POS product first. Improve its name, barcode, image and metadata
continuously afterward.**

Lifecycle:

```
POS product → ROS sync → immediate website publication → background cleanup & enrichment → automatic website update
```

Data quality never blocks publication. A weak name, missing barcode, missing image, missing size,
broad category or a failed external lookup are all **enrichment work**, not reasons to withhold a
product a customer could buy in the store.

## What decides publication

Operational availability only:

- active in POS/ROS (not archived, deleted or inactive);
- a valid sellable record (has a name);
- price greater than zero (current storefront rule).

Explicitly **not** used: name score, barcode availability, image availability, enrichment success,
category confidence.

`publishLock` on a product is the one manual override — set it and the automation leaves that
product's published state alone, in either direction.

## Naming

`name` (the register name) is never modified — POS matching depends on it. Only `displayName` is
written, from the best evidence available:

1. verified manufacturer / barcode-database title;
2. structured invoice title;
3. trusted supplier mapping;
4. safely cleaned POS name;
5. original POS name.

Step 5 guarantees there is always something publishable. If every enrichment source fails, the
cleaned POS name ships and the product goes live anyway.

A name is never replaced by a lower-scoring one, so hand-written names and earlier good evidence
survive later passes. `nameLocked` skips a product entirely.

### Normalize, never invent

The system may correct casing, punctuation, spacing, obvious spelling errors and known shorthand
(`rzrs`→Razors, `pk`→Pack). It may **not** add brand, variant, scent, size, count, pack quantity,
compatibility or trademark claims that the source data doesn't support.

This is why `Dove` stays `Dove` rather than becoming `Dove Beauty Bar Original 2-Pack` — and it is
now published as `Dove` rather than held back. An imperfect true name beats an invented better one.

The earlier AI prompt contained `make a sensible best guess`, which produced `Naseline`,
`Kindr Bueno` and `Baseline Baby` in the catalog. That instruction has been removed.

## Images

Published with the best available source: manufacturer image → barcode-database image → supplier
image → store-captured photo → category placeholder. A product with no photo still publishes, with
the placeholder.

## Data-quality flags

Internal only. They drive the work queue and the dashboard; they never affect public availability.

| Flag | Meaning |
|---|---|
| `MISSING_BARCODE` | no barcode on the record |
| `MISSING_IMAGE` | no photo from any source |
| `WEAK_DISPLAY_NAME` | name score below the weak threshold (default 80) |
| `MISSING_SIZE_OR_COUNT` | no size/count in the title |
| `CATEGORY_UNVERIFIED` | category is broad or unset |
| `BRAND_UNKNOWN` | no brand recorded |
| `BARCODE_LOOKUP_FAILED` | external lookup returned nothing / errored |
| `POSSIBLE_DUPLICATE` | another product normalizes to the same name |
| `POS_ONLY_DATA` | nothing beyond register data has been confirmed |
| `ENRICHMENT_PENDING` | not yet processed |

`nameScore` is a catalog-health and enrichment-priority metric. Nothing else.

## The background processor

Runs every 2 minutes, unattended, forever.

1. **Publish pass** — instant, no network. Every eligible product is marked published on every tick,
   so a product synced from Clover or NRS is live within two minutes of arriving.
2. **Enrichment pass** — 20 products per tick, in priority order:
   never-processed → failed lookups due for retry (after 72h, up to 8 attempts) → weak or incomplete
   records not revisited in 30 days. In-stock products first within each tier.
3. Better evidence updates the already-published product in place.

A product is never unpublished because enrichment failed or its score is low. One failing product
never stops the run (failure isolation), and batching keeps the free lookup APIs happy.

## Dashboard — Products tab → 🩺 Catalog health

Shows total products, published count, fully enriched count, queue depth, and a count per flag.
Click any flag to list those products for bulk work. Every row shows 🟢 when it's live — flagged
products stay live.

Controls:

- **Run automatically** — the 2-minute timer. Leave on.
- **Flag name as weak below** — enrichment priority threshold. Has no effect on publication.
- **Enrich next batch** — process 20 now instead of waiting.
- **Publish all eligible now** — instant catch-up pass over the whole catalog.

## Note on previously hidden products

Publication is now derived automatically, so any product a staff member had un-published in the
Website tab will be republished unless it has `publishLock` set. If specific products should stay
off the website, set `publishLock` on them.
