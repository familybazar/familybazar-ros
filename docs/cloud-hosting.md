# Running ROS in the cloud (Phase 3 — readiness)

The server now runs unchanged on a cloud host. Three things made it cloud-ready:

## 1. Persistent data location

`data.json` and `secrets.json` now live in `ROS_DATA_DIR` (defaults to the app folder locally). On a
cloud host, point it at a **persistent disk** so nothing is lost on restart/redeploy:

```
ROS_DATA_DIR = /var/data      # a mounted persistent disk
```

The folder is auto-created on boot.

## 2. Secrets from environment (no keys in git)

`secrets.json` is now git-ignored. Provide keys to the cloud via env vars, applied over the file on boot:

- **One blob:** `ROS_SECRETS_JSON = {"aiApiKey":"...","cloverApiToken":"...","cloverMerchantId":"...","imapUser":"...","imapPass":"...","platformSecret":"..."}`
- **Or individually:** `ROS_SECRET_aiApiKey`, `ROS_SECRET_imapPass`, `ROS_SECRET_platformSecret`, etc.

## 3. NRS + website connector without the local machine

- **NRS in:** the cloud can't watch a Windows folder, so it uses **NRS-by-Gmail** (IMAP). Set
  `ROS_SECRET_imapUser` / `ROS_SECRET_imapPass` and enable auto-fetch (Integrations → NRS reports by
  Gmail, or it runs every 15 min when the toggle is on).
- **Products out:** the website push (`platform-sync.js`) was a Windows Task Scheduler job. In the
  cloud the server runs it itself every 5 min when `ROS_PUSH=1` (or Settings → auto-push). It reuses the
  exact same connector, reading from `ROS_DATA_DIR`.
  **Turn the local Task Scheduler job OFF once the cloud push is on**, so they don't double-run.

## Env var summary

| Var | Purpose |
|---|---|
| `PORT` | set by the host automatically |
| `ROS_DATA_DIR` | persistent disk mount, e.g. `/var/data` |
| `ROS_PUSH` | `1` = push products to the website from the cloud every 5 min |
| `ROS_AUTH` | `1` = enforce logins (leave unset for the public review build) |
| `ROS_OWNER_PASSWORD` | seeds the owner login on first boot (when auth is on) |
| `ROS_SECRETS_JSON` / `ROS_SECRET_<key>` | API keys & the platform secret |

## Seeding a fresh cloud server with your catalog

A new cloud instance starts with an empty `data.json`. To load your ~6,400 products:

1. On your **local** ROS, open Integrations → Data Center → **Backup now** (downloads a JSON).
2. On the **cloud** ROS, open Integrations → Data Center → **Restore** → upload that JSON.

(Or, instead, run Clover import / NRS CSV import on the cloud to rebuild from the POS.)

## Files added for hosting

- `package.json` — `npm start` → `node server.js`, Node ≥ 18.
- `render.yaml` — one-click Render blueprint with a persistent disk (see `docs/` and Phase 4).
- `.gitignore` — now also ignores `secrets.json`.

Next: **Phase 4** — actually deploy to Render and point a URL at it.
