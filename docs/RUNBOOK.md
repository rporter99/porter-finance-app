# Runbook

Day-to-day operations: publishing, setting up phones, installing the automation, and fixing the things that have gone wrong before.

## Publish an app update

1. Edit the files in the repo folder on the Mac.
2. Bump the cache name in `sw.js` (`pf-shell-vNN` → `vNN+1`). Without this, phones keep the old files.
3. Commit and push to `main`:
   ```bash
   git add -A && git commit -m "What changed" && git push origin main
   ```
4. Wait a minute, then confirm the new version is live:
   ```bash
   curl -s "https://<pages-url>/sw.js?x=$RANDOM" | grep -o "pf-shell-v[0-9]*"
   ```
5. Phones update the next time the app opens or comes back to the foreground. If a panel is open or a save is in progress, the app shows an "Update" banner instead of reloading.

## Set up a phone

1. Open the app's URL in Safari, tap Share → **Add to Home Screen** → Add.
2. Open it from the Home Screen (not Safari). Sign in with the Google account that has access to the sheet. If Google shows a permission screen for your email address, allow it; that's what lets later sign-ins be silent.
3. Paste the sheet's link when asked. This happens once per phone.
4. Connections → **This phone** → turn on Face ID lock.
5. Swipe the app away and reopen it: it should go Face ID → Accounts with no taps.

Deleting the icon throws away everything in "What is stored on the phone" (see `DATA-SOURCES.md`); re-adding it means redoing steps 2–4.

## Install or update the automation

1. In the sheet: **Extensions → Apps Script**.
2. Select all in the editor, paste the full contents of `apps-script/Automation.gs`, Save.
3. Choose `setup` from the function menu and Run. Approve the permissions if asked. This creates the hourly and daily triggers and adds any new rows to **Automation Settings** with their defaults.
4. For phone alerts: in the sheet's menu, **Automation → Set up phone alerts (Pushover)** and paste the Pushover user key and app token. **Automation → Send a test alert** confirms it.

Settings live on the **Automation Settings** tab (column B). Each row's column C explains it.

## Automation Settings reference

| Setting | Meaning |
|---|---|
| Large charge alert ($) | Alert for any single charge at least this big |
| New merchant alert minimum ($) | First-ever charge from a merchant, at least this big |
| Low balance accounts / floor | Comma-separated account names and the balance that triggers an alert |
| Remove exact duplicates automatically | Yes/No. Same Transaction ID, identical fields |
| Remove re-imported duplicates automatically | Yes/No. Old transactions downloaded again with new IDs after a bank reconnect |
| Double charge minimum ($) | Smaller repeat charges are not flagged |
| Budget pacing days | Days of the month to check whether categories are on pace to go over |
| Quiet account alert (days) | A busy card with no new transactions for this many days while its balance still updates |
| Ignore accounts for connection alerts | Last-4 digits or exact names to leave out |
| Backups to keep / Quiet hours / Also email alerts | Housekeeping |
| Photo: Accounts / Budget / Transactions / Connections | Optional direct https image links for the header photos |

## Things that have gone wrong, and the fix

**Asked to sign in every launch, or shown the Google account chooser.** The phone has two Google accounts and the app lost its memory of which one to use (usually after re-adding the icon). Sign in once more from the Home Screen app, choosing the right account; it is remembered from then on. The sign-in screen's small gray status line reports whether an account is remembered.

**A bank shows "Needs a fix" / "Check".** Tiller's connection to that bank needs you. Connections → tap the bank → Open Tiller Console → Refresh or Fix. The app can't do this part; Tiller has no API and banks require a human for re-approval.

**A card's balance updates but no new transactions arrive.** The bank feed is stuck even though the connection looks healthy. Refresh the bank in the Tiller Console; if it stays stuck, ask Tiller support to refresh that account. The automation sends a "No new … transactions since …" alert after 5 days (adjustable).

**Hundreds of old transactions reappear after a reconnect.** Tiller re-downloaded history with new IDs. The automation removes them within the hour (copies saved on Removed Duplicates). To check what was removed, filter that tab by the "Removed on" column.

**Budget tabs in the sheet show $0 actuals.** A formula points at a tab that no longer exists. Find it with Edit → Find and replace (search the old tab name across all sheets) and repoint it to Transactions.

**Recent alerts repeat or linger.** Repeats of one alert collapse to the newest; bill alerts disappear once the bill posts; quiet-account alerts disappear once new transactions arrive. Anything else can be swiped away. If one truly looks wrong, check its Key on the Alerts tab.

**Something was deleted that shouldn't have been.** Every row the app or automation removes is on the **Removed Duplicates** tab with all its columns; copy it back to Transactions. Daily backups of the whole sheet are in the Drive folder named in Automation Settings.

**A split or manual value failed with "the sheet changed".** Tiller filled the sheet at the same moment. Nothing was written; refresh and try again.

**The app shows "You're offline" or "Google Sheets is busy".** Pull down to retry. Busy means Google's per-minute quota; it clears within a minute.

**Need to start a phone over.** Delete the Home Screen icon and follow "Set up a phone".

## Cleaning the public repo

Never commit the sheet ID, account names, numbers, balances or email addresses. If one slips in, remove it, then squash the history (orphan branch, single commit, force-push) or delete and recreate the repo, and turn GitHub Pages back on from Settings → Pages (branch `main`, folder `/`).
