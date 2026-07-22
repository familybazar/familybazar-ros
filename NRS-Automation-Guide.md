# Automating NRS Daily Reports into Family Bazar ROS

**Goal:** NRS emails your two daily CSVs (Sales History + Inventory Status) to
`familybazar1145@gmail.com`. We want them to land on the store PC and get imported
into ROS **automatically, with zero clicks each day.**

## How the automation works (the chain)

```
NRS email (no-reply@nrsplus.com)
        │  arrives in Gmail every day
        ▼
Google Apps Script  ──▶  saves the CSV attachments into a Google Drive folder
        │                (runs on a timer, e.g. every hour)
        ▼
Google Drive for Desktop  ──▶  mirrors that Drive folder onto the PC (real files)
        ▼
ROS "NRS auto-import"  ──▶  scans the folder every 60s, imports new CSVs:
                            • Sales History → subtracts stock, adds revenue
                            • Inventory Status → sets exact stock counts
```

Everything above runs on its own once set up. You never touch it again.

---

## Part A — Google Apps Script (Gmail → Drive)  ~5 min, one time

1. Open **https://script.google.com** and sign in as **familybazar1145@gmail.com**.
2. Click **New project**. Delete the sample code.
3. Open the file **`nrs-email-to-folder.gs`** (in your ROS folder), copy **all** of it,
   and paste it into the script editor. Click the **Save** icon (💾).
4. Click **Run ▶** (with `saveNrsAttachments` selected in the dropdown).
   - Google shows an authorization prompt → **Review permissions** →
     choose the Family Bazar account → **Advanced** → **Go to (project) (unsafe)** →
     **Allow**. (This is normal for your own script; it only reads your Gmail and
     writes to your Drive.)
   - After it runs, check the log (**Execution log**). It should say
     `Saved N CSV file(s) to "NRS Reports"`.
5. Set it to run automatically:
   - Click the **clock icon** (Triggers) on the left → **Add Trigger**.
   - Function: **saveNrsAttachments**
   - Event source: **Time-driven**
   - Type: **Hour timer → Every hour** (or **Day timer** set to just after the time
     NRS usually emails you).
   - **Save**.

✅ From now on, every NRS email's CSVs are copied into a Google Drive folder called
**"NRS Reports"**, date-stamped like `2026-07-06_Sales History.csv`.

---

## Part B — Google Drive for Desktop (Drive → PC)  ~5 min, one time

1. Download **Google Drive for Desktop**: https://www.google.com/drive/download/
2. Install it, sign in as **familybazar1145@gmail.com**.
3. It adds a drive letter (usually **G:**). Open **G:\My Drive** — you'll see the
   **NRS Reports** folder the script created.
4. **IMPORTANT — make the files real on disk** (so ROS can read them):
   - Right-click the **NRS Reports** folder → **Offline access** → **Available offline.**
   - (Or set Drive for Desktop → Settings → Google Drive → **Mirror files**, which keeps
     everything physically on the PC.)
   - If you skip this, Drive only "streams" the files and ROS sees an empty folder.
5. Note the full path, e.g. **`G:\My Drive\NRS Reports`**.

---

## Part C — Point ROS at that folder  ~1 min, one time

1. In ROS open **Integrations → NRS auto-import → Manage** (or Inventory → NRS panel).
2. **Watched folder path:** paste `G:\My Drive\NRS Reports`
3. Turn **Auto-import CSVs** ON. **Save.**
4. Click **Scan now** once to confirm it works.

ROS scans this folder every 60 seconds. When a new CSV appears it:
- imports **Sales History** (subtracts stock, records revenue dated to the report day),
- imports **Inventory Status** (sets exact stock counts),
- moves the file to a `processed/` subfolder and remembers it (by content hash) so it's
  never imported twice.

---

## Done — daily flow from now on

Each day, with **no action from you**:
NRS emails → Apps Script saves to Drive → Drive for Desktop syncs to the PC →
ROS imports within a minute. Your dashboard and stock stay current automatically.

The only requirements are that the **store PC is on** (or on whenever you want the
import to happen) and the **ROS server is running**.

---

## Troubleshooting

- **ROS says "folder not found" / nothing imports:** the path is wrong or the files
  are still "streamed." Re-check the exact `G:\My Drive\NRS Reports` path and make the
  folder **Available offline** (Part B step 4).
- **Script saved 0 files:** open one NRS email and confirm the sender is
  `no-reply@nrsplus.com`. If it differs, update the `SEARCH` line in the script with the
  real address. Also make sure the email actually has **.csv** attachments (not a PDF).
- **Same day imported twice / numbers doubled:** shouldn't happen — ROS dedupes by file
  content, and the script date-stamps each file. If you ever re-imported manually, use
  **NRS → Clear NRS sales** then let it re-import.
- **Want it faster than hourly:** set the Apps Script trigger to **Every 15 minutes**.
- **PC is often off:** run the ROS server (and this whole chain) on a PC that stays on,
  or a mini-PC, so the daily import never gets missed.

---

## Alternative (no Google Drive app): pull Gmail directly in ROS

If you'd rather not install Google Drive for Desktop, I can build a Gmail **IMAP fetch**
directly into the ROS server: you'd create a Gmail **App Password** (Google Account →
Security → 2-Step Verification → App passwords), enter it in ROS → Integrations, and the
server would check Gmail every few minutes, download the NRS CSVs straight into the
watched folder, and mark them read — no Drive, no Apps Script. Say the word and I'll add it.
