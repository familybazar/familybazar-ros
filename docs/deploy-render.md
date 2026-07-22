# Phase 4 — Deploy ROS to the cloud (Render)

Goal: a public URL you can share for review. Auth stays OFF for now; we turn it on later.

You do these steps in the browser + terminal — they involve your GitHub and Render accounts, so I can't
do them for you. Follow in order.

---

## A. Put ROS on GitHub (one-time)

Render deploys from a Git repo. ROS isn't one yet.

1. Go to **github.com → New repository**.
   - Name: `familybazar-ros`
   - **Private** (it has your business logic — keep it private)
   - Do **not** add a README/.gitignore/license (the repo already has files)
   - Click **Create repository**. Leave the page open — you'll need the URL.

2. In a terminal, initialise and push (replace `YOURNAME` with your GitHub username):

```
cd /d D:\Automation\ros-server
git init
git add -A
git commit -m "Family Bazar ROS — cloud ready"
git branch -M main
git remote add origin https://github.com/YOURNAME/familybazar-ros.git
git push -u origin main
```

GitHub will ask you to sign in on the push. Secrets and data are git-ignored, so nothing sensitive
uploads — verify the pushed repo does **not** contain `secrets.json` or `data.json`.

---

## B. Create the service on Render

1. Go to **render.com**, sign up / log in (you can use "Sign in with GitHub").
2. **New +  → Blueprint**.
3. Connect your GitHub and pick the **familybazar-ros** repo. Render reads `render.yaml` and proposes a
   web service named `family-bazar-ros` with a 1 GB persistent disk.
4. Click **Apply**. It will ask you to confirm the plan — the disk needs the **Starter** instance
   (~$7/mo + ~$0.25/mo for 1 GB). Add a payment method when prompted.
   - *Cheaper for a quick look:* you can instead create a **free** Web Service (New → Web Service, not
     Blueprint) with start command `node server.js` — but the free tier has **no persistent disk and
     sleeps when idle**, so the catalog resets. Fine for an hour's review, not for the store.

---

## C. Set environment variables (Render dashboard → your service → Environment)

Add these (the disk + `ROS_DATA_DIR` come from `render.yaml` already):

| Key | Value | Notes |
|---|---|---|
| `ROS_PUSH` | `1` | pushes products to the website from the cloud every 5 min |
| `ROS_SECRETS_JSON` | `{"aiApiKey":"...","cloverApiToken":"...","cloverMerchantId":"...","imapUser":"...","imapPass":"...","platformSecret":"..."}` | your real keys — paste as one line |

**Leave `ROS_AUTH` unset** for now (public review build). We'll add it at the final stage.

You enter these yourself — I never handle your keys. `platformSecret` must match the website's
`ROS_SYNC_SECRET`. Click **Save**; Render redeploys.

---

## D. Seed the catalog + verify

1. When the deploy is green, open the Render URL (e.g. `https://family-bazar-ros.onrender.com`).
   The PB dashboard should load (public, no login).
2. It starts empty. On your **local** ROS: Integrations → Data Center → **Backup now**.
3. On the **cloud** ROS: Integrations → Data Center → **Restore** → upload that backup JSON.
4. Check `https://<your-url>/api/health` returns `{"ok":true,...}`.
5. Once the cloud push is confirmed working, **turn OFF** the local Windows Task Scheduler
   `FamilyBazarSync` job so products aren't pushed twice.

---

## E. Later (final stage) — turn on logins

When review is done: set `ROS_AUTH=1` and `ROS_OWNER_PASSWORD=<something strong>` in Render → Environment,
redeploy. The site then requires login and seeds the owner account. Add manager/staff logins under
Settings → Team.

---

## Redeploys

Any `git push` to `main` auto-deploys (Render watches the repo). To ship a change:

```
cd /d D:\Automation\ros-server
git add -A
git commit -m "describe the change"
git push
```
