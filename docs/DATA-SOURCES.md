# Data sources

Everything the app shows comes from one Google Sheet maintained by Tiller, plus a few tabs the app and its automation add. Columns are always found by their heading, never by position, so Tiller can reorder them.

## Tabs the app reads

| Tab | What it provides | Notes |
|---|---|---|
| **Transactions** | Every transaction. Date, Description, Amount, Category, Account, Account #, Transaction ID, Full Description, Date Added, plus custom columns Note, Reviewed, Ask | Only the last 13 months are loaded by default; "Load older" fetches the rest. The boundary row is remembered on the phone and re-checked weekly. |
| **Accounts** | Account name, number, institution, type, class, group, hide flag, last update, last balance | Tiller keeps two header blocks on this tab; the app uses the right-hand one (last occurrence of each heading). |
| **Categories** | Category, Group, Type, Hide From Reports, and the monthly budget columns ("Jan 2026", …) | Category names are matched exactly, including trailing spaces, because Tiller does the same. |
| **Balance History** | Dated balances per account | Used for the net-worth change this month and for savings-goal pace (balance ~90 days ago). |
| **Alerts** | Written by the automation: When, Type, Title, Message, Key | Shown under "Recent alerts" on the To do tab for 7 days; repeats collapse to the newest; resolved bill/quiet alerts are hidden. |
| **Suggested Rules** | AutoCat suggestions from the automation | Approve adds a row to AutoCat and categorizes matching uncategorized transactions. |
| **Automation Settings** | Setting / Value pairs | Thresholds for the automation, the ignore list for connection alerts, and optional header photo links. |
| **Goals** | Goal, Target, Target Date (YYYY-MM), Account #, Account | Created by the app on first save. |
| **AutoCat** | Tiller's own rules | Read only for its headings when approving a suggestion. |

## Columns the app adds

- **Note** and **Reviewed** on Transactions (added by hand originally).
- **Ask** on Transactions: added automatically at the far right if missing. "Yes" puts a transaction in the review queue for the other person.
- A **Goals** tab, created on the first saved goal.

Tiller ignores extra columns and tabs.

## What the app writes

| Write | Where | Safeguards |
|---|---|---|
| Category, Note, Reviewed, Ask | Transactions cells | Row re-located by Transaction ID right before the write; one batch request. |
| Fix category names / approve a rule | Transactions Category cells | `setFieldBatch` re-reads the ID and current value and only writes where both still match. |
| Split a transaction | Transactions: original row edited, a copy inserted below | Matches Tiller's own format (`split:<ID>[1]`, `[2]`); insert, copy and the changed cells go in one request; both IDs verified after. |
| Delete duplicates | Transactions rows | Re-reads the sheet, backs each row up to **Removed Duplicates**, re-checks IDs, snapshots the whole ID column, deletes bottom-up, then verifies the column equals the snapshot minus the deleted rows. Only exact copies (same ID and identical fields) are ever deleted automatically. |
| Savings goals | Goals tab | Name verified before overwriting a row. |
| Manual account values | Balance History, new row at the top | Copied from the account's latest row with a fresh Balance ID and today's date/time, the way Tiller's Manual Accounts tool writes it. |
| AutoCat rule | AutoCat tab, appended row | Only Category and Description Contains are filled. |

## What the automation writes (Apps Script)

- **Alerts** tab: one row per alert, with a Key used to avoid repeats.
- **Removed Duplicates** tab: full copies of any rows it deletes (exact duplicates and re-imported duplicates).
- **Suggested Rules** tab: weekly AutoCat suggestions.
- Daily backups of the whole spreadsheet to a Drive folder.

## What is stored on the phone

All in the browser's local storage for the home-screen app (lost if the icon is deleted and re-added):

| Key | Purpose |
|---|---|
| `pf_sheet_id` | The sheet's ID, pasted once from its link |
| `pf_login_hint` | Email of the Google account used, so silent sign-in never asks |
| `pf_returning` | Whether a sign-in has succeeded before |
| `pf_lock_cred` | Face ID passkey for the local lock |
| `pf_cutoff_row` | Where the last 13 months end on Transactions (a row number) |
| `pf_dismissed_alerts` | Alerts swiped away on the To do tab |
| `pf_token` (session only) | The current access token, about an hour |

No sheet data is cached on the phone.

## External services

- **Google OAuth** (`accounts.google.com`): sign-in. Scope: Google Sheets plus `openid email` for the login hint.
- **Google Sheets API** (`sheets.googleapis.com`): all reads and writes.
- **Google tokeninfo** (`www.googleapis.com`): fallback to identify the account if the id_token is missing.
- **Pushover**: phone notifications from the automation. Keys live in the script's properties, never in code.
- **Tiller Console** (`my.tiller.com`): linked from the To do tab for refreshing or fixing bank connections. Tiller has no public API.
- **Optional header photos**: any direct https image link entered on Automation Settings.
