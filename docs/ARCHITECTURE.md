# Architecture

Porter Finances is a personal-finance web app for two people, installed on their iPhones from Safari ("Add to Home Screen"). It reads and writes a Tiller-powered Google Sheet directly from the phone. There is no server of our own.

## The pieces

```
iPhone (home-screen web app)                 Google                      Google Sheet
┌───────────────────────────┐   OAuth    ┌──────────────┐           ┌──────────────────────┐
│ index.html / styles.css   │──────────▶ │ accounts.    │           │ Transactions         │
│ app.js (all logic)        │ ◀───token─ │ google.com   │           │ Accounts             │
│ sw.js (offline shell)     │            └──────────────┘           │ Categories           │
│ config.js (client ID)     │   Sheets API (read/write, HTTPS)      │ Balance History      │
│                           │──────────────────────────────────────▶│ Alerts, Goals, …     │
└───────────────────────────┘                                       └──────────▲───────────┘
        ▲                                                                      │ hourly / 7 AM
        │ Pushover notification                                     ┌──────────┴───────────┐
        └───────────────────────────────────────────────────────────│ Apps Script          │
                                                                    │ (Automation.gs)      │
                                                                    └──────────────────────┘
```

- **Web app** (`index.html`, `styles.css`, `app.js`, `config.js`, `sw.js`, `manifest.webmanifest`, `icons/`, `images/`): plain HTML, CSS and JavaScript with no build step and no framework. Hosted as static files on GitHub Pages.
- **Google sign-in**: OAuth redirect flow in the browser. The access token lives in `sessionStorage` only and expires in about an hour; a silent re-sign-in (`prompt=none`) refreshes it. The account's email is kept on the phone as a `login_hint` so the silent sign-in never has to ask which Google account to use.
- **Google Sheets API**: every read and write goes straight from the phone to `sheets.googleapis.com` with the user's token. Nothing is proxied or stored elsewhere.
- **Apps Script automation** (`apps-script/Automation.gs`): pasted by hand into the sheet's script editor. Runs hourly and daily to remove duplicates, watch bank connections, bills, large charges, budgets and so on. Sends alerts through Pushover (or email) and logs them to an "Alerts" tab that the app displays.
- **Service worker** (`sw.js`): caches only the app shell (HTML, CSS, JS, icons, photos) so it opens instantly. It never caches sheet data. The cache name (`pf-shell-vNN`) is bumped on every release; when a new version takes over, the app reloads itself once (unless something is mid-edit).

## How the app is organised

`app.js` is one file in a single closure. Reading top to bottom:

1. **Config and helpers**: constants, date/number formatting (`toDateKey`, `fmt`, `fmt0`), `esc()` for HTML escaping (every string from the sheet passes through it).
2. **Auth**: `getToken`, `startSignIn`, `handleRedirect`, `rememberAccount`.
3. **Sheet source** (`sheetSource`): `load()` reads everything in a few batched requests and returns a plain data object; the write methods (`setFields`, `setFieldBatch`, `splitTransaction`, `saveGoal`, `deleteDuplicates`, `approveRule`, `updateManualBalance`, …) each re-locate their target row by Transaction ID before writing. A `DEMO_SOURCE` in `demo-data.js` has the same shape for previews.
4. **State**: one `state` object (current tab, filters, open panels, loaded data). `render()` redraws the current tab from state.
5. **Loading**: `loadData()` with the write/load race protection (`trackWrites`, `writeSeq`, `reloadQueued`).
6. **Screens**: `renderHome` (Accounts), `renderBudget` (+ `renderBudgetDetail`, `renderChartFull`), `renderTx` (+ hero, controls, list), `renderConnections` (the To do tab, + bank detail). Each builds an HTML string and sets `innerHTML`.
7. **Panels and flows**: transaction panel (category, note, Ask, Split), review queue, goal form, manual-value form, Face ID lock, pull-to-refresh.
8. **Events**: `bind()` attaches one delegated click handler per screen; `start()` runs the sign-in / sheet-link / lock sequence.

## Data flow for one edit

Tap a transaction → panel opens with its category list → choose a category → `savePanel` updates the in-memory transaction and re-renders immediately → `source.setFields` locates the row by Transaction ID (the sheet gains rows as Tiller fills it), writes the cell(s) with one `values:batchUpdate` → on failure the local change is rolled back and a toast explains. Loads that overlap a write are discarded and re-run after it, so a stale read never undoes a fresh edit.

## Security model

- The sheet is private to the two Google accounts. Google sign-in is the real protection; the Face ID lock is a convenience lock on the phone only.
- The public repo contains no sheet ID, account names, numbers, balances or email addresses. The sheet link is pasted once per phone and kept in `localStorage`.
- Content Security Policy allows scripts only from the app itself, connections only to Google's Sheets and token endpoints, and images from the app or https (for optional header photos).
- The app never stores passwords or bank credentials. Tiller holds the bank connections; the app only links out to the Tiller Console.
- Writes are limited to specific cells (Category, Note, Reviewed, Ask), appended rows (Goals, Balance History, AutoCat, Removed Duplicates) and the guarded duplicate deletion described in `DATA-SOURCES.md`.

## Hosting and versions

GitHub Pages serves the `main` branch of the public repo at the app's URL. Publishing is a git push; the site updates within a minute or two. Phones pick up a new version the next time the app opens or returns to the foreground. See `RUNBOOK.md`.
