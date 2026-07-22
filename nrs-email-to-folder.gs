/**
 * Family Bazar — NRS email → Drive folder (for automatic ROS import)
 * -------------------------------------------------------------------
 * NRS emails you a "Sales History" and an "Inventory Status" CSV each day.
 * This script saves those attachments into a Google Drive folder. Google
 * Drive for Desktop then mirrors that folder onto your PC, and Family Bazar
 * ROS auto-imports any new CSV it finds — fully hands-free.
 *
 * ── ONE-TIME SETUP ──────────────────────────────────────────────────
 * 1. Go to https://script.google.com  →  New project.
 * 2. Delete the sample code, paste ALL of this, and Save.
 * 3. (Optional) tighten SEARCH below with the real NRS sender once you know
 *    it — open one NRS email and copy the "from" address.
 * 4. Click Run ▶ on "saveNrsAttachments". Google will ask you to authorize —
 *    allow it (it only reads your Gmail and writes to your Drive).
 * 5. Click the clock icon (Triggers) → Add Trigger:
 *        Function: saveNrsAttachments
 *        Event source: Time-driven
 *        Type: Hour timer → Every hour   (or Day timer at your NRS email time)
 * 6. Install "Google Drive for Desktop" on the store PC and sign in.
 *    Find where the "NRS Reports" folder appears (e.g. G:\My Drive\NRS Reports).
 *    Right-click it → "Available offline" (so files download to disk).
 * 7. In ROS → Inventory → NRS auto-import folder → paste that PC path →
 *    "Set folder", and turn ON "Watch & auto-import".
 *
 * That's it. Each day the two CSVs arrive by email → land in Drive → sync to
 * the PC → ROS imports them (sales subtract stock, inventory sets stock).
 */

// ── CONFIG ──────────────────────────────────────────────────────────
const DRIVE_FOLDER = 'NRS Reports';   // Drive folder to save into (auto-created)
const SEARCH = 'from:no-reply@nrsplus.com has:attachment filename:csv newer_than:2d';
// (Locked to your NRS sender. Both the Sales and Inventory CSVs come from this address.)

// ── SCRIPT ──────────────────────────────────────────────────────────
function saveNrsAttachments(){
  const folder = getFolder_(DRIVE_FOLDER);
  const label  = getLabel_('ROS-Saved');
  const threads = GmailApp.search(SEARCH + ' -label:ROS-Saved', 0, 50);
  let saved = 0;
  threads.forEach(function(t){
    t.getMessages().forEach(function(m){
      // Date-stamp from the email date so each day's report is kept (and ROS can
      // date the sales to the correct report day, not the import day).
      const datePrefix = Utilities.formatDate(m.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      m.getAttachments().forEach(function(a){
        const orig = a.getName();
        if (!/\.csv$/i.test(orig)) return;
        const name = datePrefix + '_' + orig;
        if (folder.getFilesByName(name).hasNext()) return;   // this day's file already saved
        folder.createFile(a.copyBlob()).setName(name);
        saved++;
      });
    });
    t.addLabel(label);   // don't process this thread again
  });
  console.log('Saved ' + saved + ' CSV file(s) to "' + DRIVE_FOLDER + '".');
}

function getFolder_(name){
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function getLabel_(name){
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
