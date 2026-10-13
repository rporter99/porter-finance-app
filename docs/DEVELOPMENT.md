# Development

How to work on the app without breaking it.

## Repo layout

```
index.html              markup for all screens and panels
styles.css              all styling (light + dark via prefers-color-scheme)
app.js                  all logic, one closure
config.js               Google OAuth client ID (public by design); sheet ID is NOT here
demo-data.js            made-up data and a fake source, used with ?demo
sw.js                   service-worker shell cache; bump CACHE every release
manifest.webmanifest    home-screen install settings
icons/                  app icon (icon.svg is the source; PNGs are derived)
images/                 the four header photos
apps-script/Automation.gs   the sheet automation, pasted into Apps Script by hand
docs/                   these documents
CLAUDE.md               working notes and conventions for AI-assisted changes
```

No build step, no dependencies, no framework. Edit the files, publish by pushing.

## Preview with made-up data

Open the app with `?demo` on the URL and it uses `demo-data.js` instead of Google: no sign-in, no sheet. This is how every change is tested before publishing.

On macOS, the local preview server can't read `~/Documents`, so copy the folder to a scratch location first and serve from there (any static server on port 8080 works), then open `http://localhost:8080/index.html?demo`. Resize the browser to a phone width (375×812) and check both light and dark mode. Re-copy after each edit; if a stylesheet looks stale, reload it with cache disabled.

For screenshots without a visible browser, headless Chrome works: `--headless=new --window-size=500,900 --blink-settings=preferredColorScheme=1 --screenshot=out.png "http://localhost:8080/preview.html?demo&tab=budget"`, where `preview.html` is `index.html` plus a small script that clicks the requested tab.

## Checks before publishing

- **Syntax**: `app.js`, `demo-data.js` and `Automation.gs` must parse. On the Mac without Node, this works: `osascript -l JavaScript -e "new Function($.NSString.stringWithContentsOfFileEncodingError('app.js',4,null).js)"`.
- **Automation logic**: the pure functions at the bottom of `Automation.gs` (duplicates, re-imports, near-duplicates, bills, pacing, connections, quiet accounts, rules) are exercised by a small JXA test script that loads that section and asserts expected results. Keep the "Pure logic below" marker in place; the tests depend on it.
- **Demo walk-through**: every screen, open and close each panel, one category change, one split, one goal save, one manual value, the review queue to the end.
- Bump `CACHE` in `sw.js`.

## Conventions that matter

- **Columns by heading.** Never index a column by position. `txCols`, `R('Heading')` on Accounts (last occurrence), and the Categories/Balance History lookups all go by name.
- **Escape everything from the sheet.** Any string that ends up in HTML or an attribute goes through `esc()`. Transaction descriptions are attacker-controlled text from banks.
- **Writes re-locate the row.** Tiller inserts rows at the top of Transactions whenever it fills, so a row number from a load is only a hint. Verify the Transaction ID at that row, or search for it, before writing.
- **Tracked writes.** Every write method is listed in `WRITES` so the `trackWrites` proxy can count in-flight writes; a load that overlaps one is discarded and re-queued. Add new write methods to that list. Any purely local change to transaction data should call `dataChanged()` so the cached Connections checks recompute.
- **Match Tiller's formats.** Splits use `split:<ID>[n]`; manual balances are new Balance History rows with serial-number dates; the automation's `findDuplicates` must stay identical to the app's.
- **One source of truth for a check.** `budgetStatus`, `findDuplicates`, `categoryIssues`, `connectionGroups` are used by both the badge and the screens; don't fork them.
- **Keep motion optional.** Animations live in CSS and are disabled under `prefers-reduced-motion`; the count-up respects it too.
- **Dark mode.** Every color is a CSS variable with a dark override. Text on the accent color uses `--on-accent`.
- **Nothing personal in the repo.** See `RUNBOOK.md` → "Cleaning the public repo".

## Adding a feature: the usual shape

1. Data: extend `load()` to read what you need (add it to the batch, parse by heading) and add any new write method to `sheetSource`, `DEMO_SOURCE` and `WRITES`.
2. State: add fields to `state` with a one-line comment.
3. Render: build HTML in the screen's render function; use `secLabel`, `emptyHtml`, `icon()` and the existing row classes so it matches.
4. Events: add to that screen's delegated click handler in `bind()`.
5. Styles: append to `styles.css` with a short section comment; include dark-mode colors.
6. Demo data: make the feature visible in `?demo`.
7. Test in the preview, bump the cache, note the behavior in `CLAUDE.md`, publish.

## Apps Script changes

Edit `apps-script/Automation.gs` in the repo, run the JXA tests, then paste the whole file into the sheet's script editor and run `setup` if settings rows or triggers changed. New settings go in the `SETTINGS` array with a default and a one-line description; `setup` adds missing rows without touching existing values.

## Content Security Policy

Set in `index.html`. Scripts: self only (no inline). Styles: self plus inline (the app sets a few inline widths). Connections: Google Sheets and token endpoints only. Images: self, data: and https: (for optional header photos). Adding any other external resource means updating the policy deliberately.
