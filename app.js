(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has('demo');
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const PAGE_SIZE = 150;
  const STALE_MS = 5 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const state = {
    tab: 'home',
    data: null,          // { accounts, categories, txns, netWorthStart }
    loadedAt: 0,
    loading: false,
    search: '',
    account: '',
    month: '',           // 'YYYY-MM' on the Transactions screen; '' means all months
    sort: 'date',
    limit: PAGE_SIZE,
    editing: null,
    budgetCat: null,     // category open on the Budget screen, if any
    chartFull: false,    // full spending chart open on the Budget screen
    chartOpen: null,     // category expanded in the full chart
    review: null,        // review queue state while it's open
    fullHistory: false,  // true once older-than-13-months history has been loaded
    filtersOpen: false,
    showHealthy: false,
    chartRange: 'month',
    goalEditing: null,
    show: '',            // Transactions view: '' all, 'uncat', 'asked'
    picking: false,
    pendingAsk: false,
    splitting: null,     // transaction open in the split form   // Ask toggle in the open transaction panel, not saved until ✓
    budgetMonth: '',     // 'YYYY-MM' picked on the Budget screen; '' means this month
    connBank: null,      // bank open on the Connections screen, if any
    deleting: false,
    fixing: false,
    ruleBusy: null,
  };

  // ---------- Formatting helpers ----------

  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmt = (n) => money.format(n).replace('-', '−');
  const fmt0 = (n) => money0.format(Math.round(n)).replace('-', '−');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function localKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Google Sheets dates arrive as serial numbers (days since 1899-12-30).
  function toDateKey(v) {
    if (typeof v === 'number' && isFinite(v)) {
      return new Date((Math.floor(v) - 25569) * 86400000).toISOString().slice(0, 10);
    }
    if (typeof v === 'string' && v.trim()) {
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const d = new Date(v);
      if (!isNaN(d)) return localKey(d);
    }
    return '';
  }

  function dayLabel(key) {
    const today = new Date();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    if (key === localKey(today)) return 'Today';
    if (key === localKey(yest)) return 'Yesterday';
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (y !== today.getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString('en-US', opts);
  }

  function ago(ms) {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return `${Math.round(mins / 60)} hr ago`;
  }

  const truthy = (v) => v === true || /^(true|yes|hide|hidden|x)$/i.test(String(v ?? '').trim());
  const colLetter = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  // ---------- Auth (Google OAuth, redirect flow) ----------
  // The access token lives only in this browser session and expires after about an hour.

  const TOKEN_KEY = 'pf_token';
  const STATE_KEY = 'pf_oauth_state';
  const RETURNING_KEY = 'pf_returning';

  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  function getToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
      if (t && t.exp > Date.now() + 60000) return t.value;
    } catch (_) { /* ignore */ }
    return null;
  }

  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
  }

  // The sign-in redirect reloads the page, so remember which screen and filters were open.
  const UI_KEY = 'pf_ui';
  function saveUi() {
    try {
      sessionStorage.setItem(UI_KEY, JSON.stringify({
        tab: state.tab, budgetMonth: state.budgetMonth, month: state.month, account: state.account, sort: state.sort,
      }));
    } catch (_) { /* ignore */ }
  }
  function restoreUi() {
    try {
      const ui = JSON.parse(sessionStorage.getItem(UI_KEY) || 'null');
      sessionStorage.removeItem(UI_KEY);
      if (ui && TITLES[ui.tab]) Object.assign(state, ui);
    } catch (_) { /* ignore */ }
    $('tx-sort').value = state.sort;
  }

  function startSignIn(silent) {
    saveUi();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(STATE_KEY, nonce);
    const params = new URLSearchParams({
      client_id: CFG.clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state: nonce,
    });
    if (silent) params.set('prompt', 'none');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
  }

  // Returns { ok: true } after a successful sign-in redirect, { error } on failure, or null if not a redirect.
  function handleRedirect() {
    const hash = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(hash)) return null;
    history.replaceState(null, '', location.pathname + location.search);
    const p = new URLSearchParams(hash);
    const expected = localStorage.getItem(STATE_KEY);
    localStorage.removeItem(STATE_KEY);
    if (!expected || p.get('state') !== expected) return { error: "Sign-in couldn't be verified. Try again." };
    const err = p.get('error');
    if (err) {
      if (['interaction_required', 'login_required', 'consent_required'].includes(err)) return { error: null, needsTap: true };
      return { error: err === 'access_denied' ? 'Sign-in was cancelled.' : 'Sign-in failed. Try again.' };
    }
    if (!(p.get('scope') || '').includes(SCOPE)) {
      return { error: 'The app needs permission to use your Google Sheets. Sign in again and allow access.' };
    }
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
      value: p.get('access_token'),
      exp: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
    }));
    localStorage.setItem(RETURNING_KEY, '1');
    return { ok: true };
  }

  class AuthError extends Error {}
  class NeedSheetError extends Error {}

  // The sheet's ID isn't in the public code: each phone is given the sheet's link once.
  const SHEET_KEY = 'pf_sheet_id';
  const CUTOFF_KEY = 'pf_cutoff_row';   // where the last 13 months end on the Transactions tab (just a row number)
  const sheetId = () => { try { return localStorage.getItem(SHEET_KEY) || CFG.spreadsheetId || ''; } catch (_) { return CFG.spreadsheetId || ''; } };
  function parseSheetId(text) {
    const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(text) || /^\s*([A-Za-z0-9_-]{25,})\s*$/.exec(text);
    return m ? m[1] : '';
  }

  // ---------- Google Sheets data source ----------

  async function api(path, opts = {}, tries = 0) {
    const token = getToken();
    if (!token) throw new AuthError('Signed out');
    if (!sheetId()) throw new NeedSheetError('No sheet');
    let res;
    try {
      res = await fetch(SHEETS_API + encodeURIComponent(sheetId()) + path, {
        ...opts,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        cache: 'no-store',
      });
    } catch (_) {
      throw new Error(navigator.onLine === false ? 'You’re offline. Pull down to try again when you’re connected.'
        : 'Couldn’t reach Google. Pull down to try again.');
    }
    // Google sometimes answers "busy" (429, its quota resets each minute) or has a hiccup (5xx).
    // Reads are safe to retry: after 2, 5 and 12 seconds.
    if ((res.status === 429 || res.status >= 500) && tries < 3 && (opts.method || 'GET') === 'GET') {
      await new Promise((r) => setTimeout(r, [2000, 5000, 12000][tries]));
      return api(path, opts, tries + 1);
    }
    if (res.status === 429) throw new Error('Google Sheets is busy right now. Wait a minute and try again.');
    if (res.status === 401) { clearToken(); throw new AuthError('Signed out'); }
    if (res.status === 403 || res.status === 404) {
      throw new Error("This Google account doesn't have access to the finances sheet.");
    }
    if (!res.ok) throw new Error(`Google Sheets returned an error (${res.status}). Try again.`);
    return res.json();
  }

  async function batchGet(ranges, render = 'UNFORMATTED_VALUE') {
    const out = [];
    for (let i = 0; i < ranges.length; i += 50) {   // keeps each request URL short
      const q = ranges.slice(i, i + 50).map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
      const json = await api(`/values:batchGet?${q}&valueRenderOption=${render}&dateTimeRenderOption=SERIAL_NUMBER`);
      out.push(...json.valueRanges.map((v) => v.values || []));
    }
    return out;
  }

  const TX_REQUIRED = ['Date', 'Description', 'Amount', 'Category', 'Account'];
  const TX_OPTIONAL = ['Transaction ID', 'Full Description', 'Date Added', 'Note', 'Reviewed', 'Account #', 'Ask'];
  const GOALS_TAB = 'Goals';
  const GOAL_HEADERS = ['Goal', 'Target', 'Target Date', 'Account #', 'Account'];
  // The app loads the last 13 months (this month plus the 12 before it) unless older history is asked for.
  const historyStart = () => { const d = new Date(); return localKey(new Date(d.getFullYear() - 1, d.getMonth(), 1)); };
  const LOG_TAB = 'Removed Duplicates';
  const ALERTS_TAB = 'Alerts';
  const RULES_TAB = 'Suggested Rules';
  const SETTINGS_TAB = 'Automation Settings';

  // Duplicate transactions are rows sharing a Transaction ID. A group is "safe" to clean up
  // only when every copy has the same date, amount, account, description and full description,
  // and the copies don't carry two different categories or notes. Anything else goes to "review"
  // and is never deleted by the app. The kept copy is the categorized one (then one with a note), then the one Tiller
  // added first, then the lower one in the sheet (Tiller adds new rows at the top).
  function findDuplicates(txns) {
    const byId = new Map();
    for (const t of txns) {
      if (!t.id) continue;
      if (!byId.has(t.id)) byId.set(t.id, []);
      byId.get(t.id).push(t);
    }
    const same = (a, b) => a.date === b.date && a.amount === b.amount && a.account === b.account &&
      a.desc === b.desc && a.fullDesc === b.fullDesc;
    const safe = [];
    const review = [];
    for (const [id, copies] of byId) {
      if (copies.length < 2) continue;
      const cats = new Set(copies.map((t) => t.category).filter(Boolean));
      const notes = new Set(copies.map((t) => t.note || '').filter(Boolean));
      const identical = cats.size <= 1 && notes.size <= 1 && copies.every((t) => same(t, copies[0]));
      const keep = copies.slice().sort((a, b) =>
        (b.category ? 1 : 0) - (a.category ? 1 : 0) ||
        (b.note ? 1 : 0) - (a.note ? 1 : 0) ||
        (a.added ?? Infinity) - (b.added ?? Infinity) ||
        b.row - a.row)[0];
      (identical ? safe : review).push({ id, keep, remove: copies.filter((t) => t !== keep), copies });
    }
    return { safe, review };
  }

  const sheetSource = {
    txCols: null,

    async load(opts = {}) {
      // Which tabs exist (the automation tabs are optional).
      const meta = await api('?fields=sheets.properties(sheetId,title,gridProperties.columnCount)');
      this.sheetIds = Object.fromEntries(meta.sheets.map((x) => [x.properties.title, x.properties.sheetId]));
      const txGrid = (meta.sheets.find((x) => x.properties.title === 'Transactions') || {}).properties;
      const has = (t) => t in this.sheetIds;

      const [txH, acH, catH, bhH] = (await batchGet([
        'Transactions!1:1', 'Accounts!1:1', 'Categories!1:1', "'Balance History'!1:1",
      ], 'FORMATTED_VALUE')).map((v) => v[0] || []);

      // Ask column: added at the far right the first time (Tiller ignores extra columns).
      const missing = ['Ask'].filter((n) => !txH.includes(n));
      if (missing.length && txGrid) {
        try {
          // Use the first column right of the headings, unless something is already in it;
          // then add a brand-new column at the far right instead.
          const cols = txGrid.gridProperties.columnCount;
          let at = txH.length;
          if (at < cols) {
            const [below] = await batchGet([`Transactions!${colLetter(at)}2:${colLetter(at)}`]);
            if (below.some((r) => String(r[0] ?? '').trim() !== '')) at = cols;
          }
          const extra = at + missing.length - cols;
          if (extra > 0) {
            await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [
              { appendDimension: { sheetId: txGrid.sheetId, dimension: 'COLUMNS', length: extra } }] }) });
          }
          await api(`/values/${encodeURIComponent(`Transactions!${colLetter(at)}1`)}?valueInputOption=RAW`, {
            method: 'PUT', body: JSON.stringify({ values: [missing] }),
          });
          while (txH.length < at) txH.push('');
          txH.push(...missing);
        } catch (e) {
          if (e instanceof AuthError) throw e;
          // View-only access or a busy moment: carry on without the Ask column this time.
        }
      }

      // Transactions: find the columns we need by their headings.
      const tx = {};
      for (const name of [...TX_REQUIRED, ...TX_OPTIONAL]) {
        const i = txH.indexOf(name);
        if (i < 0 && TX_REQUIRED.includes(name)) throw new Error(`Couldn't find the "${name}" column on the Transactions tab.`);
        tx[name] = i < 0 ? null : colLetter(i);
      }
      this.txCols = tx;
      this.txHeaders = txH;

      // Find the last row that belongs to the last 13 months, so older rows aren't downloaded.
      // (If the sheet isn't sorted by date, this simply loads everything.)
      const cutoff = opts.full ? null : historyStart();
      let lastRow = null, hasOlder = false;
      if (cutoff) ({ lastRow, hasOlder } = await this.findCutoffRow(tx.Date, cutoff));
      const txRanges = this.txRanges(lastRow);

      // Categories: name, group, type, hidden flag, plus every monthly budget column ("Jan 2025", "Feb 2025", …).
      const now = new Date();
      const catNeed = ['Category', 'Group', 'Type', 'Hide From Reports'];
      const catIdx = catNeed.map((n) => catH.indexOf(n));
      if (catIdx[0] < 0) throw new Error("Couldn't find the Category column on the Categories tab.");
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const budgetCols = [];
      catH.forEach((h, i) => {
        const m = /^([A-Za-z]{3})\w*\s+(\d{4})$/.exec(String(h).trim());
        const mi = m ? MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase()) : -1;
        if (mi >= 0) budgetCols.push({ key: `${m[2]}-${String(mi + 1).padStart(2, '0')}`, i });
      });
      const catRanges = [...catIdx.filter((i) => i >= 0), ...budgetCols.map((b) => b.i)]
        .map((i) => `Categories!${colLetter(i)}2:${colLetter(i)}`);

      const acRange = `Accounts!A2:${colLetter(Math.max(acH.length - 1, 0))}`;

      const bhNeed = ['Date', 'Account ID', 'Balance'];
      const bhIdx = bhNeed.map((n) => bhH.indexOf(n));
      const bhRanges = bhIdx.every((i) => i >= 0) ? bhIdx.map((i) => `'Balance History'!${colLetter(i)}2:${colLetter(i)}`) : [];

      const extraRanges = [
        has(ALERTS_TAB) ? `'${ALERTS_TAB}'!A2:D41` : null,
        has(RULES_TAB) ? `'${RULES_TAB}'!A2:E` : null,
        has(SETTINGS_TAB) ? `'${SETTINGS_TAB}'!A2:B60` : null,
        has(GOALS_TAB) ? `'${GOALS_TAB}'!A2:E` : null,
      ];
      const all = await batchGet([...txRanges, ...catRanges, acRange, ...bhRanges, ...extraRanges.filter(Boolean)]);
      let x = all.length - extraRanges.filter(Boolean).length;
      const alertRows = extraRanges[0] ? all[x++] : [];
      const ruleRows = extraRanges[1] ? all[x++] : [];
      const settingRows = extraRanges[2] ? all[x++] : [];
      const goalRows = extraRanges[3] ? all[x++] : [];
      const setting = (name) => String((settingRows.find((r) => String(r[0] ?? '').trim() === name) || [])[1] ?? '');
      const ignore = setting('Ignore accounts for connection alerts').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
      const txns = this.parseTransactions(all.slice(0, txRanges.length)).filter((t) => !cutoff || t.date >= cutoff);
      let k = txRanges.length;
      const catColsData = catIdx.map((i) => (i >= 0 ? all[k++].map((r) => r[0]) : []));
      const budgetData = budgetCols.map((b) => ({ key: b.key, vals: all[k++].map((r) => r[0]) }));
      const acRows = all[k++];
      const bhCols = bhRanges.length ? [all[k++], all[k++], all[k++]].map((rows) => rows.map((r) => r[0])) : null;

      // Categories
      const [cName, cGroup, cType, cHide] = catColsData;
      const categories = [];
      for (let i = 0; i < cName.length; i++) {
        // Keep the exact name, trailing spaces included: Tiller matches category names exactly,
        // so "Electricity " and "Electricity" are different categories to it.
        const name = String(cName[i] ?? '');
        if (!name.trim()) continue;
        categories.push({
          name,
          group: String(cGroup[i] ?? '').trim() || 'Other',
          type: String(cType[i] ?? '').trim(),
          hidden: truthy(cHide[i]),
          budgets: Object.fromEntries(budgetData.map((b) => [b.key, Math.abs(Number(b.vals[i]) || 0)])),
        });
      }

      // Accounts. Tiller's Accounts tab holds two separate lists side by side:
      // your settings on the left (A–D) and Tiller's account data on the right,
      // in a different row order. The right-hand list already reflects your
      // Class, Group and Hide choices, so only that list is read.
      const R = (n) => acH.lastIndexOf(n);
      const accounts = [];
      for (const r of acRows) {
        const name = String(r[R('Account')] ?? '').trim();
        if (!name) continue;
        const type = String(r[R('Type')] ?? '').toLowerCase();
        const cls = String(r[R('Class')] ?? '');
        const liability = /liab/i.test(cls) || (!cls && /credit|loan|mortgage/.test(type));
        const raw = Number(r[R('Last Balance')]) || 0;
        accounts.push({
          id: String(r[R('Account Id')] ?? ''),
          name,
          number: String(r[R('Account #')] ?? '').trim(),
          institution: String(r[R('Institution')] ?? '').trim(),
          type,
          liability,
          group: String(r[R('Group')] ?? '').trim() || defaultGroup(type, liability),
          hidden: truthy(r[R('Hide')]),
          balance: liability ? -Math.abs(raw) : raw,
          updated: toDateKey(r[R('Last Update')]),
        });
      }

      // Net worth at the start of this month, from Balance History.
      let netWorthStart = null;
      if (bhCols) {
        const monthStart = localKey(new Date(now.getFullYear(), now.getMonth(), 1));
        const latest = {};
        const [bDate, bId, bBal] = bhCols;
        for (let i = 0; i < bDate.length; i++) {
          const d = toDateKey(bDate[i]);
          const id = String(bId[i] ?? '');
          if (!d || !id || d >= monthStart) continue;
          if (!latest[id] || latest[id].d < d) latest[id] = { d, v: Number(bBal[i]) || 0 };
        }
        // Accounts with no balance before this month (for example one reconnected to a new
        // Tiller connection mid-month) count as unchanged, not as new money.
        let sum = 0, found = 0;
        for (const a of accounts) {
          if (a.hidden) continue;
          if (!latest[a.id]) { sum += a.balance; continue; }
          sum += a.liability ? -Math.abs(latest[a.id].v) : latest[a.id].v;
          found++;
        }
        if (found) netWorthStart = sum;
      }

      // Each account's balance about 90 days ago, to judge whether savings goals are on pace.
      const balAgo = {};
      if (bhCols) {
        const cutoff90 = localKey(new Date(Date.now() - 90 * 86400000));
        const best = {};
        const [bDate, bId, bBal] = bhCols;
        for (let i = 0; i < bDate.length; i++) {
          const d = toDateKey(bDate[i]);
          const id = String(bId[i] ?? '');
          if (!d || !id || d > cutoff90) continue;
          if (!best[id] || best[id].d < d) best[id] = { d, v: Number(bBal[i]) || 0 };
        }
        for (const [id, b] of Object.entries(best)) balAgo[id] = b;
      }

      // Savings goals from the Goals tab.
      const goals = goalRows.map((r, i) => ({
        row: i + 2, name: String(r[0] ?? '').trim(), target: Math.abs(Number(r[1]) || 0),
        date: typeof r[2] === 'number' ? toDateKey(r[2]).slice(0, 7) : String(r[2] ?? '').trim().slice(0, 7),
        number: String(r[3] ?? '').trim(),
      })).filter((g) => g.name && g.target);

      // Alerts written by the sheet's automation script (newest first).
      const alerts = alertRows.filter((r) => typeof r[0] === 'number').map((r) => ({
        when: r[0], type: String(r[1] ?? ''), title: String(r[2] ?? ''), message: String(r[3] ?? ''),
      }));
      // AutoCat rule suggestions still waiting for a decision.
      const rules = ruleRows.map((r, i) => ({
        row: i + 2, status: String(r[0] ?? '').trim(), category: String(r[1] ?? ''), keyword: String(r[2] ?? '').trim(),
        count: Number(r[3]) || 0, uncategorized: Number(r[4]) || 0,
      })).filter((r) => !r.status && r.keyword && r.category);

      return { accounts, categories, txns, netWorthStart, alerts, rules, ignore, hasNote: !!tx.Note, hasReviewed: !!tx.Reviewed,
        historyFrom: cutoff, hasOlder, goals, balAgo, hasAsk: !!tx.Ask };
    },

    txRanges(lastRow) {
      const c = this.txCols;
      return [...TX_REQUIRED, ...TX_OPTIONAL].filter((n) => c[n]).map((n) => `Transactions!${c[n]}2:${c[n]}${lastRow || ''}`);
    },

    parseTransactions(cols) {
      const c = this.txCols;
      const data = {};
      let k = 0;
      for (const n of [...TX_REQUIRED, ...TX_OPTIONAL]) if (c[n]) data[n] = cols[k++].map((r) => r[0]);
      const txns = [];
      const len = Math.max(...Object.values(data).map((a) => a.length));
      const str = (n, i) => (data[n] ? String(data[n][i] ?? '') : '');
      for (let i = 0; i < len; i++) {
        const date = toDateKey(data.Date[i]);
        const amount = Number(data.Amount[i]);
        if (!date || !isFinite(amount)) continue;
        txns.push({
          row: i + 2,
          id: str('Transaction ID', i),
          date,
          desc: str('Description', i),
          fullDesc: str('Full Description', i),
          amount,
          category: str('Category', i),
          account: str('Account', i),
          number: str('Account #', i),
          added: data['Date Added'] && typeof data['Date Added'][i] === 'number' ? data['Date Added'][i] : null,
          note: str('Note', i),
          reviewed: str('Reviewed', i).trim() !== '',
          ask: str('Ask', i).trim() !== '',
        });
      }
      return txns;
    },

    // Deletes duplicate copies for the given Transaction IDs, carefully:
    //  1. Re-reads the sheet and re-runs the duplicate check, so only copies that are
    //     still exact duplicates right now are touched, and one copy is always kept.
    //  2. Saves a full copy of every row it will delete to the "Removed Duplicates" tab.
    //  3. Re-checks the IDs in those exact rows immediately before deleting them.
    //  4. Deletes bottom-up, then confirms every ID still has its kept copy.
    async deleteDuplicates(ids) {
      const c = this.txCols;
      if (!c['Transaction ID']) throw new Error("Your Transactions tab has no Transaction ID column, so duplicates can't be checked.");
      const wanted = new Set(ids);

      const fresh = this.parseTransactions(await batchGet(this.txRanges()));
      // At most 200 rows per tap keeps each request small; tap again for more.
      const targets = findDuplicates(fresh).safe.filter((g) => wanted.has(g.id)).flatMap((g) => g.remove).slice(0, 200);
      if (!targets.length) throw new Error('Those duplicates are already gone or have changed. Nothing was deleted.');

      const meta = await api('?fields=sheets.properties(sheetId,title)');
      const txSheet = meta.sheets.find((s) => s.properties.title === 'Transactions');
      if (!txSheet) throw new Error("Couldn't find the Transactions tab. Nothing was deleted.");

      // Back up the full rows first. RAW keeps every value as plain text.
      const lastCol = colLetter(this.txHeaders.length - 1);
      const idIdx = this.txHeaders.indexOf('Transaction ID');
      const rows = await batchGet(targets.map((t) => `Transactions!A${t.row}:${lastCol}${t.row}`), 'FORMATTED_VALUE');
      rows.forEach((r, i) => {
        if (String(r[0]?.[idIdx] ?? '') !== targets[i].id) throw new Error('The sheet changed while checking. Nothing was deleted. Refresh and try again.');
      });
      if (!meta.sheets.some((s) => s.properties.title === LOG_TAB)) {
        await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LOG_TAB } } }] }) });
        await api(`/values/${encodeURIComponent(`'${LOG_TAB}'!A1`)}?valueInputOption=RAW`, {
          method: 'PUT', body: JSON.stringify({ values: [['Removed on', ...this.txHeaders]] }),
        });
      }
      const stamp = new Date().toLocaleString('en-US');
      await api(`/values/${encodeURIComponent(`'${LOG_TAB}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', body: JSON.stringify({ values: rows.map((r) => [stamp, ...(r[0] || [])]) }),
      });

      // Last check right before deleting: snapshot every Transaction ID; each target row must
      // still hold the expected ID.
      const idCol = c['Transaction ID'];
      const [snap] = await batchGet([`Transactions!${idCol}2:${idCol}`]);
      const snapIds = snap.map((r) => String(r[0] ?? ''));
      targets.forEach((t) => {
        if (snapIds[t.row - 2] !== t.id) throw new Error('The sheet changed while checking. Nothing was deleted. Refresh and try again.');
      });

      const requests = targets.map((t) => t.row).sort((a, b) => b - a).map((row) => ({
        deleteDimension: { range: { sheetId: txSheet.properties.sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } },
      }));
      await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });

      // Confirm exactly the target rows went: the ID column must equal the snapshot minus them.
      const [after] = await batchGet([`Transactions!${idCol}2:${idCol}`]);
      const present = new Set(after.map((r) => String(r[0] ?? '')));
      const missing = [...new Set(targets.map((t) => t.id))].filter((id) => !present.has(id));
      if (missing.length) {
        throw new Error(`Deleted, but ${missing.length} transaction${missing.length === 1 ? ' is' : 's are'} now missing entirely. Copies are saved in the ${LOG_TAB} tab of your sheet.`);
      }
      const gone = new Set(targets.map((t) => t.row - 2));
      const expected = snapIds.filter((_, i) => !gone.has(i));
      const afterIds = after.map((r) => String(r[0] ?? ''));
      while (expected.length && !expected[expected.length - 1]) expected.pop();
      while (afterIds.length && !afterIds[afterIds.length - 1]) afterIds.pop();
      if (expected.length !== afterIds.length || expected.some((id, i) => id !== afterIds[i])) {
        const lost = [...new Set(expected)].filter((id) => id && !present.has(id));
        if (lost.length) {
          throw new Error(`The sheet changed while deleting, and ${lost.length} other transaction${lost.length === 1 ? '' : 's'} may have been removed. Check Tiller or your Drive backup. IDs: ${lost.slice(0, 5).join(', ')}`);
        }
      }
      return targets.length;
    },

    // The last row dated on or after the cutoff. The whole Date column (30,000+ cells) is read
    // at most once a week; in between, only a window around the remembered row is read, and
    // it is trusted only if the boundary sits clearly inside it (recent rows above, 200+ older
    // rows below). Anything unexpected falls back to the full read.
    async findCutoffRow(col, cutoff) {
      const scan = (rows, first) => {
        let last = null, hasOlder = false, olderAfter = 0;
        rows.forEach((r, i) => {
          const k = toDateKey(r[0]);
          if (!k) return;
          if (k >= cutoff) { last = first + i; olderAfter = 0; } else { hasOlder = true; olderAfter++; }
        });
        return { last, hasOlder, olderAfter };
      };
      let saved = null;
      try { saved = JSON.parse(store.get(CUTOFF_KEY) || 'null'); } catch (_) { /* ignore */ }
      if (saved && saved.sheet === sheetId() && Date.now() - saved.at < 7 * 86400000) {
        const from = Math.max(2, saved.row - 500), to = saved.row + 2500;
        const [rows] = await batchGet([`Transactions!${col}${from}:${col}${to}`]);
        const w = scan(rows, from);
        const topKey = rows.length ? toDateKey(rows[0][0]) : '';
        if (w.last && w.olderAfter >= 200 && (from === 2 || topKey >= cutoff)) {
          store.set(CUTOFF_KEY, JSON.stringify({ ...saved, row: w.last }));
          return { lastRow: w.last, hasOlder: true };
        }
      }
      const [dates] = await batchGet([`Transactions!${col}2:${col}`]);
      const f = scan(dates, 2);
      const lastRow = f.last || 1;
      store.set(CUTOFF_KEY, JSON.stringify({ sheet: sheetId(), row: lastRow, at: Date.now() }));
      return { lastRow, hasOlder: f.hasOlder };
    },

    // Approves an AutoCat suggestion: adds the rule to the bottom of the AutoCat tab,
    // marks the suggestion approved, then categorizes existing uncategorized matches.
    async approveRule(rule, txns) {
      await this.checkRuleRow(rule);
      const [head] = await batchGet(['AutoCat!1:1'], 'FORMATTED_VALUE');
      const h = (head[0] || []).map(String);
      const ci = h.indexOf('Category'), di = h.indexOf('Description Contains');
      if (ci < 0 || di < 0 || !('AutoCat' in this.sheetIds)) throw new Error("Couldn't find the AutoCat tab's Category and Description Contains columns.");
      const cells = h.map((_, i) => ({ userEnteredValue: { stringValue: i === ci ? rule.category : i === di ? rule.keyword : '' } }));
      await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{
        appendCells: { sheetId: this.sheetIds.AutoCat, rows: [{ values: cells }], fields: 'userEnteredValue' },
      }] }) });
      await this.setRuleStatus(rule, 'Approved');
      const kw = rule.keyword.toLowerCase();
      const items = txns.filter((t) => !t.category && t.id && t.desc.toLowerCase().includes(kw))
        .map((t) => ({ id: t.id, row: t.row, from: '', to: rule.category }));
      return items.length ? this.fixCategories(items) : 0;
    },

    async dismissRule(rule) {
      await this.checkRuleRow(rule);
      await this.setRuleStatus(rule, 'Dismissed');
    },

    // The suggestion must still be in the same row and still waiting.
    async checkRuleRow(rule) {
      const [r] = await batchGet([`'${RULES_TAB}'!A${rule.row}:C${rule.row}`], 'FORMATTED_VALUE');
      const v = r[0] || [];
      if (String(v[2] ?? '').trim() !== rule.keyword || String(v[0] ?? '').trim()) {
        throw new Error('That suggestion changed. Tap ↻ and try again.');
      }
    },

    async setRuleStatus(rule, status) {
      await api(`/values/${encodeURIComponent(`'${RULES_TAB}'!A${rule.row}`)}?valueInputOption=RAW`, {
        method: 'PUT', body: JSON.stringify({ values: [[status]] }),
      });
    },

    // Rewrites category names to their exact spelling. Each row is re-checked first:
    // it must still hold the same Transaction ID and the same old category.
    async fixCategories(items) {
      return this.setFieldBatch('Category', items);
    },

    // Writes one column for many transactions. Each row is re-checked first: it must still
    // hold the same Transaction ID and the expected old value ({ id, row, from, to }).
    async setFieldBatch(field, items) {
      const c = this.txCols;
      if (!c['Transaction ID'] || !c[field] || !items.length) return 0;
      const [ids, vals] = await batchGet([`Transactions!${c['Transaction ID']}2:${c['Transaction ID']}`, `Transactions!${c[field]}2:${c[field]}`]);
      const rowOf = new Map();
      ids.forEach((r, i) => { const id = String(r[0] ?? ''); if (id && !rowOf.has(id)) rowOf.set(id, i + 2); });
      const data = [];
      for (const it of items) {
        let row = it.row;
        if (String(ids[row - 2]?.[0] ?? '') !== it.id) row = rowOf.get(it.id);
        if (!row || String(vals[row - 2]?.[0] ?? '') !== it.from) continue;
        data.push({ range: `Transactions!${c[field]}${row}`, values: [[it.to]] });
      }
      if (!data.length) return 0;
      await api('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
      return data.length;
    },

    // Adds, changes or removes a savings goal on the Goals tab (created the first time).
    async saveGoal(goal) {
      if (!(GOALS_TAB in this.sheetIds)) {
        await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: GOALS_TAB } } }] }) });
        await api(`/values/${encodeURIComponent(`${GOALS_TAB}!A1`)}?valueInputOption=RAW`, {
          method: 'PUT', body: JSON.stringify({ values: [GOAL_HEADERS] }),
        });
        const meta = await api('?fields=sheets.properties(sheetId,title)');
        this.sheetIds = Object.fromEntries(meta.sheets.map((x) => [x.properties.title, x.properties.sheetId]));
      }
      const values = goal.deleted ? ['', '', '', '', ''] : [goal.name, goal.target, goal.date, goal.number, goal.accountName];
      if (goal.row) {
        const [cur] = await batchGet([`${GOALS_TAB}!A${goal.row}`], 'FORMATTED_VALUE');
        if (String(cur[0]?.[0] ?? '').trim() !== goal.original) throw new Error('That goal changed on the sheet. Tap ↻ and try again.');
        await api(`/values/${encodeURIComponent(`${GOALS_TAB}!A${goal.row}:E${goal.row}`)}?valueInputOption=RAW`, {
          method: 'PUT', body: JSON.stringify({ values: [values] }),
        });
      } else {
        await api(`/values/${encodeURIComponent(`${GOALS_TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
          method: 'POST', body: JSON.stringify({ values: [values] }),
        });
      }
    },

    // Writes the new category into the sheet. Tiller can insert rows, so we
    // confirm the row still holds this transaction before writing.
    // Finds the transaction's current row: Tiller inserts rows, so the row it was
    // loaded from may have moved. Checks the Transaction ID (or description + amount).
    async locate(t) {
      const c = this.txCols;
      const byId = t.id && c['Transaction ID'];
      const [cur, curAmt] = await batchGet([`Transactions!${byId ? c['Transaction ID'] : c.Description}${t.row}`, `Transactions!${c.Amount}${t.row}`]);
      const v = cur[0]?.[0];
      if (byId ? String(v ?? '') === t.id : String(v ?? '') === t.desc && Number(curAmt[0]?.[0]) === t.amount) return t.row;
      if (!byId) throw new Error('This transaction moved in the sheet. Refresh and try again.');
      const [ids] = await batchGet([`Transactions!${c['Transaction ID']}2:${c['Transaction ID']}`]);
      const i = ids.findIndex((r) => String(r[0] ?? '') === t.id);
      if (i < 0) throw new Error("Couldn't find this transaction in the sheet. Refresh and try again.");
      return i + 2;
    },

    // Splits one transaction into two rows the way Tiller does: the original row keeps the first
    // part and becomes "split:<ID>[1]"; a copy right below gets the second part as "split:<ID>[2]".
    // (Splitting a split row again adds the next number.) Everything else — date, account,
    // descriptions, Date Added — is copied, so Tiller and the duplicate checks treat it like
    // Tiller's own splits. The insert and both rows are written in one all-or-nothing request.
    async splitTransaction(t, parts) {
      const c = this.txCols;
      if (!c['Transaction ID'] || !c.Amount || !c.Category) throw new Error("Your Transactions tab is missing a column needed to split.");
      const row = await this.locate(t);
      const width = this.txHeaders.length;
      const idIdx = this.txHeaders.indexOf('Transaction ID');
      const amtIdx = this.txHeaders.indexOf('Amount');
      const catIdx = this.txHeaders.indexOf('Category');
      const [[orig = []]] = await batchGet([`Transactions!A${row}:${colLetter(width - 1)}${row}`], 'FORMULA');
      if (String(orig[idIdx] ?? '') !== t.id) throw new Error('The sheet changed while splitting. Nothing was changed. Refresh and try again.');
      if (Math.round(Number(orig[amtIdx]) * 100) !== Math.round((parts[0].amount + parts[1].amount) * 100)) {
        throw new Error("The parts don't add up to the transaction amount. Nothing was changed.");
      }

      // New split IDs.
      const m = /^split:(.+)\[(\d+)\]$/.exec(t.id);
      let id1 = t.id, id2;
      if (m) {
        const [ids] = await batchGet([`Transactions!${c['Transaction ID']}2:${c['Transaction ID']}`]);
        const used = ids.map((r) => /^split:(.+)\[(\d+)\]$/.exec(String(r[0] ?? ''))).filter((x) => x && x[1] === m[1]).map((x) => Number(x[2]));
        id2 = `split:${m[1]}[${Math.max(...used, 1) + 1}]`;
      } else {
        id1 = `split:${t.id}[1]`;
        id2 = `split:${t.id}[2]`;
      }

      const cell = (v) => {
        if (v === '' || v === null || v === undefined) return {};
        if (typeof v === 'number') return { userEnteredValue: { numberValue: v } };
        if (typeof v === 'boolean') return { userEnteredValue: { boolValue: v } };
        if (String(v).startsWith('=')) return { userEnteredValue: { formulaValue: String(v) } };
        return { userEnteredValue: { stringValue: String(v) } };
      };
      const copy = Array.from({ length: width }, (_, i) => orig[i] ?? '');
      const fresh = copy.slice();
      fresh[idIdx] = id2;
      fresh[amtIdx] = parts[1].amount;
      fresh[catIdx] = parts[1].category;
      for (const name of ['Note', 'Reviewed', 'Ask']) { const i = this.txHeaders.indexOf(name); if (i >= 0) fresh[i] = ''; }
      const first = copy.slice();
      first[idIdx] = id1;
      first[amtIdx] = parts[0].amount;
      first[catIdx] = parts[0].category;

      const sheetId = this.sheetIds.Transactions;
      const rowData = (vals) => ({ values: vals.map(cell) });
      await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [
        { insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 }, inheritFromBefore: true } },
        { updateCells: { range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: width },
          rows: [rowData(fresh)], fields: 'userEnteredValue' } },
        { updateCells: { range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: width },
          rows: [rowData(first)], fields: 'userEnteredValue' } },
      ] }) });

      // Confirm both rows landed where expected.
      const [check] = await batchGet([`Transactions!${c['Transaction ID']}${row}:${c['Transaction ID']}${row + 1}`]);
      if (String(check[0]?.[0] ?? '') !== id1 || String(check[1]?.[0] ?? '') !== id2) {
        throw new Error('The split was written, but the sheet changed at the same moment. Check this transaction on the Transactions tab.');
      }
      t.id = id1;
    },

    // Writes cells for one transaction, by column heading, e.g. { Category: 'Groceries', Note: '…' }.
    async setFields(t, fields) {
      if (!Object.keys(fields).length) return;
      const c = this.txCols;
      for (const k of Object.keys(fields)) if (!c[k]) throw new Error(`Your Transactions tab has no "${k}" column.`);
      const row = await this.locate(t);
      const data = Object.entries(fields).map(([k, v]) => ({ range: `Transactions!${c[k]}${row}`, values: [[v]] }));
      await api('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
      t.row = row;
    },
  };

  function defaultGroup(type, liability) {
    if (/credit/.test(type)) return 'Credit cards';
    if (/loan|mortgage/.test(type)) return 'Loans';
    if (/invest|brokerage|retire/.test(type)) return 'Investments';
    if (/depository|checking|savings|cash/.test(type)) return 'Cash';
    return liability ? 'Liabilities' : 'Other';
  }

  // Writes are counted so a load that overlaps one (and may have read the sheet before the write
  // landed) is thrown away and done again once the writes finish.
  const WRITES = ['splitTransaction', 'setFields', 'setFieldBatch', 'fixCategories', 'saveGoal', 'deleteDuplicates', 'approveRule', 'dismissRule'];
  let writing = 0, writeSeq = 0, reloadQueued = false;
  function trackWrites(src) {
    return new Proxy(src, {
      get(obj, key) {
        const v = obj[key];
        if (typeof v !== 'function') return v;
        if (!WRITES.includes(key)) return v.bind(obj);
        return async (...args) => {
          writing++; writeSeq++;
          try { return await v.apply(obj, args); } finally {
            writing--; writeSeq++;
            if (!writing && reloadQueued && !state.loading) { reloadQueued = false; loadData({ quiet: true }); }
          }
        };
      },
    });
  }
  const source = trackWrites(DEMO ? window.DEMO_SOURCE : sheetSource);

  // ---------- Loading ----------

  // Returns 'ok', 'queued' (another load or a write was running; it will run again after),
  // 'auth', 'sheet' or 'error'.
  async function loadData({ quiet } = {}) {
    if (state.loading) { reloadQueued = true; return 'queued'; }
    state.loading = true;
    $('refresh-btn').classList.add('spinning');
    if (!state.data && !quiet) renderLoading();
    const seq = writeSeq;
    try {
      const data = await source.load({ full: state.fullHistory });
      if (state.data && (writing || seq !== writeSeq)) { reloadQueued = true; return 'queued'; }
      state.data = data;
      state.data.txns.forEach((t, i) => { t.idx = i; });
      state.loadedAt = Date.now();
      hideBanner();
      fillFilters();
      render();
      return 'ok';
    } catch (e) {
      if (e instanceof NeedSheetError) {
        showSheetSetup();
        return 'sheet';
      }
      if (e instanceof AuthError) {
        if (state.data) showBanner('Your sign-in expired.', 'Sign in', () => startSignIn(false));
        else showSignIn();
        return 'auth';
      }
      showBanner(e.message || "Couldn't load your data.", 'Retry', () => loadData());
      if (!state.data) $('view-' + state.tab).innerHTML = '';
      return 'error';
    } finally {
      state.loading = false;
      $('refresh-btn').classList.remove('spinning');
      if (reloadQueued && !writing) { reloadQueued = false; setTimeout(() => loadData({ quiet: true }), 0); }
    }
  }

  // ---------- Rendering ----------

  const TITLES = { home: 'Accounts', budget: 'Budget', tx: 'Transactions', connections: 'Connections' };

  function render() {
    $('title').textContent = TITLES[state.tab];
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    for (const t of Object.keys(TITLES)) $('view-' + t).hidden = t !== state.tab;
    if (!state.data) return;
    if (state.tab === 'home') renderHome();
    if (state.tab === 'budget') renderBudget();
    if (state.tab === 'tx') renderTx();
    if (state.tab === 'connections') renderConnections();
    updateConnectionsBadge();
  }

  function renderLoading() {
    $('view-' + state.tab).innerHTML = '<div class="loading">Loading your data…</div>';
  }

  const ASSET_ORDER = ['Bank Accounts', 'Investments'];
  const LIABILITY_ORDER = ['Credit Cards'];

  function renderClass(title, accts, order) {
    if (!accts.length) return '';
    const groups = new Map();
    for (const a of accts) {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a);
    }
    const sum = (list) => list.reduce((s, a) => s + a.balance, 0);
    const rank = (g) => { const i = order.findIndex((o) => o.toLowerCase() === g.toLowerCase()); return i < 0 ? 99 : i; };
    const names = [...groups.keys()].sort((x, y) => rank(x) - rank(y) || Math.abs(sum(groups.get(y))) - Math.abs(sum(groups.get(x))));
    const total = sum(accts);

    let html = `<div class="class-head"><span>${title}</span><span>${fmt0(total)}</span></div>`;
    for (const g of names) {
      const list = groups.get(g).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
      html += `<div class="section-label"><span>${esc(g)}</span><span>${fmt0(sum(list))}</span></div><div class="card">`;
      for (const a of list) {
        const sub = [a.institution, a.number].filter(Boolean).join(' · ');
        html += `<button class="row acct-row" data-acct="${esc(acctKey(a.name, a.number))}"><div class="name"><div>${esc(a.name)}</div>
          <div class="muted small">${esc(sub)}</div></div>
          <div class="amt">${fmt(a.balance)} <span class="chev">›</span></div></button>`;
      }
      html += '</div>';
    }
    return html;
  }

  // ---------- Savings goals ----------
  // Each goal follows one account's balance. "On pace" compares the last ~90 days of growth
  // with what's needed per month to reach the target by its date.

  const goalAccount = (g) => state.data.accounts.find((a) => a.number === g.number && !a.hidden) ||
    state.data.accounts.find((a) => a.number === g.number);

  function goalStatus(g) {
    const a = goalAccount(g);
    const current = a ? a.balance : 0;
    const now = new Date();
    const [y, m] = (g.date || '').split('-').map(Number);
    const monthsLeft = y ? Math.max(0, (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth()) + 1) : 0;
    const remaining = Math.max(0, g.target - current);
    const needed = monthsLeft ? remaining / monthsLeft : remaining;
    const ago = a ? state.data.balAgo?.[a.id] : undefined;
    const [ay, am, ad] = ago ? ago.d.split('-').map(Number) : [];
    const monthsAgo = ago ? Math.max(1, (now - new Date(ay, am - 1, ad)) / 86400000 / 30.44) : 0;
    const rate = ago ? (current - ago.v) / monthsAgo : null;
    let status = 'none';
    if (current >= g.target) status = 'done';
    else if (rate !== null) status = rate >= needed ? 'pace' : 'behind';
    return { a, current, monthsLeft, needed, status };
  }

  function goalsHtml() {
    const goals = state.data.goals || [];
    let h = `<div class="section-label"><span>Savings goals</span></div>`;
    if (!goals.length) {
      return h + `<div class="card"><button class="row goal-add" id="goal-add"><div class="name"><div>Set a savings goal</div>
        <div class="muted small">Track progress toward a target, like a vacation or emergency fund</div></div><span class="chev">›</span></button></div>`;
    }
    h += '<div class="card">';
    for (const g of goals) {
      const st = goalStatus(g);
      const pct = Math.min(100, (st.current / g.target) * 100);
      const when = g.date ? `by ${monthLabel(g.date).replace(/ (\d{4})$/, ' $1')}` : '';
      const note = st.status === 'done' ? 'Goal reached' : st.status === 'pace' ? 'on pace'
        : `${fmt0(st.needed)}/mo needed`;
      h += `<button class="goal-row" data-goal="${g.row}"><div class="budget-top"><span>${esc(g.name)}</span>
        <span>${fmt0(st.current)} <span class="of">of ${fmt0(g.target)}</span> <span class="chev">›</span></span></div>
        <div class="bar ${st.status === 'behind' ? 'warn' : ''}"><i style="width:${pct}%"></i></div>
        <div class="muted small goal-sub">${esc(st.a ? st.a.name.trim() : 'Account not found')}${when ? ' · ' + when : ''} · ${note}</div></button>`;
    }
    return h + `</div><button class="btn-soft btn-block goal-add-btn" id="goal-add">+ Add a goal</button>`;
  }

  function openGoalForm(g) {
    state.goalEditing = g || null;
    const accts = state.data.accounts.filter((a) => !a.hidden && !a.liability && a.number);
    $('goal-title').textContent = g ? 'Edit goal' : 'New savings goal';
    $('goal-name').value = g ? g.name : '';
    $('goal-target').value = g ? g.target : '';
    $('goal-date').value = g ? g.date : '';
    $('goal-account').innerHTML = accts.map((a) => `<option value="${esc(a.number)}">${esc(a.name.trim())} (${esc(a.number.replace(/\D/g, '').slice(-4))})</option>`).join('');
    if (g) $('goal-account').value = g.number;
    $('goal-delete').hidden = !g;
    $('goal-error').hidden = true;
    $('goal-backdrop').hidden = false;
    $('goal-sheet').hidden = false;
  }

  function closeGoalForm() {
    $('goal-backdrop').hidden = true;
    $('goal-sheet').hidden = true;
    state.goalEditing = null;
  }

  async function submitGoal(deleted) {
    const g = state.goalEditing;
    const name = $('goal-name').value.trim();
    const target = Math.abs(Number(String($('goal-target').value).replace(/[$,]/g, '')));
    const date = $('goal-date').value;
    const number = $('goal-account').value;
    if (!deleted && (!name || !target || !number)) {
      $('goal-error').textContent = 'Enter a name, a target amount and an account.';
      $('goal-error').hidden = false;
      return;
    }
    if (deleted && !window.confirm(`Delete the goal “${g.name}”?`)) return;
    const acct = state.data.accounts.find((a) => a.number === number);
    closeGoalForm();
    toast('Saving…', 0);
    try {
      await source.saveGoal({ row: g ? g.row : null, original: g ? g.name : '', name, target, date, number,
        accountName: acct ? acct.name.trim() : '', deleted: !!deleted });
      toast(deleted ? 'Goal deleted' : 'Goal saved');
    } catch (e) {
      toast(e instanceof AuthError ? 'Your sign-in expired, so the goal wasn’t saved.' : (e.message || "Couldn't save the goal."), 4000);
    }
    await loadData({ quiet: true });
  }

  function renderHome() {
    const accts = state.data.accounts.filter((a) => !a.hidden);
    const net = accts.reduce((s, a) => s + a.balance, 0);
    const start = state.data.netWorthStart;
    let change = '';
    if (start !== null) {
      const d = net - start;
      change = `<div class="${d >= 0 ? 'pos' : 'neg'} small">${d >= 0 ? '+' : '−'}${fmt0(Math.abs(d))} this month</div>`;
    }

    let html = `<div class="hero photo photo-accounts"><div class="label">Net worth</div><div class="big">${fmt0(net)}</div>${change}</div>`;
    html += goalsHtml();
    html += renderClass('Assets', accts.filter((a) => !a.liability), ASSET_ORDER);
    html += renderClass('Liabilities', accts.filter((a) => a.liability), LIABILITY_ORDER);
    if (!accts.length) html += '<div class="empty">No accounts found on the Accounts tab.</div>';
    html += `<div class="footnote">Updated ${ago(state.loadedAt)}${DEMO ? ' · demo data' : ''}</div>`;
    $('view-home').innerHTML = html;
  }

  const thisMonth = () => localKey(new Date()).slice(0, 7);
  const WARN_AT = 0.85;   // yellow once this share of the budget is spent
  const OVER_BY = 10;     // red once spending is this many dollars over budget
  // 'over' (red) at $10+ over budget; 'warn' (yellow) from 85% used up to that point;
  // '' (green) while on track. Spending within $1 of the budget counts as on track:
  // a bill paid in full is done, not a warning. With no budget, any spending counts as over it.
  const budgetStatus = (spent, budget) => {
    budget = budget > 0 ? budget : 0;
    if (spent >= budget + OVER_BY) return 'over';
    if (budget && Math.abs(budget - spent) <= 1) return '';
    if (!budget) return spent > 0.005 ? 'warn' : '';
    return spent >= budget * WARN_AT ? 'warn' : '';
  };

  // Budget for a category in a month ('YYYY-MM'), from that month's column on the Categories tab.
  const budgetFor = (c, month) => (c.budgets ? c.budgets[month] || 0 : c.budget || 0);
  const budgetMonth = () => state.budgetMonth || thisMonth();

  // Months to offer on the Budget screen: any month with a budget or transactions, up to this one.
  function budgetMonths() {
    const now = thisMonth();
    const keys = new Set(state.data.txns.map((t) => t.date.slice(0, 7)));
    for (const c of state.data.categories) for (const k of Object.keys(c.budgets || {})) keys.add(k);
    keys.add(now);
    // Months before the loaded history would show $0 spent, so they're offered via "Load months before…" instead.
    const from = state.fullHistory || !state.data.historyFrom ? '' : state.data.historyFrom.slice(0, 7);
    return [...keys].filter((k) => k <= now && k >= from).sort().reverse();
  }

  function budgetMonthSelect() {
    const cur = budgetMonth();
    return `<select id="budget-month" class="month-select" aria-label="Month">${budgetMonths()
      .map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${monthLabel(k)}</option>`).join('')}${olderOption()}</select>`;
  }

  function renderBudget() {
    if (state.budgetCat) { renderBudgetDetail(state.budgetCat); return; }
    if (state.chartFull) { renderChartFull(); return; }
    const month = budgetMonth();
    const spent = {};
    for (const t of state.data.txns) {
      if (t.date.startsWith(month)) spent[t.category] = (spent[t.category] || 0) - t.amount;
    }
    const items = state.data.categories
      .filter((c) => /expense/i.test(c.type) && !c.hidden)
      .map((c) => ({ ...c, budget: budgetFor(c, month), spent: spent[c.name] || 0 }))
      .filter((c) => c.budget > 0 || Math.abs(c.spent) >= 0.01);

    const totalBudget = items.reduce((s, c) => s + c.budget, 0);
    const totalSpent = items.reduce((s, c) => s + c.spent, 0);
    const left = totalBudget - totalSpent;
    const [y, m] = month.split('-').map(Number);
    const monthName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' });
    let when = 'Month complete';
    if (month === thisMonth()) {
      const now = new Date();
      const daysLeft = new Date(y, m, 0).getDate() - now.getDate();
      when = daysLeft === 0 ? 'Last day of the month' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} to go`;
    }
    let html = `<div class="hero photo photo-budget budget-hero">
      <div class="big">${fmt0(totalSpent)} <span class="muted small" style="font-weight:400">of ${fmt0(totalBudget)}</span></div>
      <div class="small ${budgetStatus(totalSpent, totalBudget) === 'over' ? 'neg' : 'muted'}">${left >= 0 ? fmt0(left) + ' left' : fmt0(-left) + ' over'} · ${when}</div></div>`;
    html += budgetMonthSelect();
    html += donutHtml(month);

    // Spending with no category isn't in any budget line; show it so the totals stay honest.
    const uncat = state.data.txns.filter((t) => !t.category && t.amount < 0 && t.date.startsWith(month));
    if (uncat.length) {
      const total = -uncat.reduce((s, t) => s + t.amount, 0);
      html += `<div class="card uncat-card"><div class="row"><div class="name"><div>Needs a category</div>
        <div class="muted small">${uncat.length} transaction${uncat.length === 1 ? '' : 's'} not counted in any budget</div></div>
        <div class="amt">${fmt0(total)}</div></div>
        ${reviewQueue().length ? '<button class="btn-mini" id="budget-review">Review</button>' : ''}</div>`;
    }

    const groups = new Map();
    for (const c of items) {
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group).push(c);
    }
    for (const g of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      html += `<div class="section-label">${esc(g)}</div><div class="card">`;
      for (const c of groups.get(g).sort((a, b) => a.name.localeCompare(b.name))) {
        const status = budgetStatus(c.spent, c.budget);
        const over = status === 'over';
        const w = c.budget ? Math.min(100, Math.max(0, (c.spent / c.budget) * 100)) : (c.spent > 0 ? 100 : 0);
        html += `<button class="budget-item" data-cat="${esc(c.name)}"><div class="budget-top"><span>${esc(c.name)}</span>
          <span class="${over ? 'neg' : ''}">${fmt0(c.spent)} <span class="of">/ ${fmt0(c.budget)}</span> <span class="chev">›</span></span></div>
          <div class="bar ${over ? 'over' : status}"><i style="width:${w}%"></i></div></button>`;
      }
      html += '</div>';
    }
    if (!items.length) html += `<div class="empty">No budget or spending for ${monthName} on the Categories tab.</div>`;
    $('view-budget').innerHTML = html;
  }

  // Spending by expense category for the month, or the year up to that month, largest first.
  function spendingByCategory(month) {
    const from = state.chartRange === 'year' ? month.slice(0, 4) + '-01' : month;
    const types = new Map(state.data.categories.map((c) => [c.name, c]));
    const sums = new Map();
    for (const t of state.data.txns) {
      const m = t.date.slice(0, 7);
      if (m < from || m > month) continue;
      const c = types.get(t.category);
      if (!c || c.hidden || !/expense/i.test(c.type)) continue;
      sums.set(t.category, (sums.get(t.category) || 0) - t.amount);
    }
    return [...sums].filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
  }

  const chartLabel = (month) => (state.chartRange === 'year' ? `${month.slice(0, 4)} so far`
    : new Date(+month.slice(0, 4), +month.slice(5, 7) - 1, 1).toLocaleDateString('en-US', { month: 'long' }));

  const rangeSeg = () => {
    const year = state.chartRange === 'year';
    return `<div class="seg"><button data-range="month" class="${year ? '' : 'on'}">Month</button><button data-range="year" class="${year ? 'on' : ''}">Year</button></div>`;
  };

  // Donut arcs for [{ v, cls, name }] slices, starting at 12 o'clock.
  function arcsHtml(slices, total, attrs) {
    let offset = 25;
    return slices.map((sl) => {
      const len = (sl.v / total) * 100;
      const dash = Math.max(len - (slices.length > 1 ? 0.6 : 0), 0.1);
      const arc = `<circle class="arc ${sl.cls}" cx="21" cy="21" r="15.915" stroke-dasharray="${dash} ${100 - dash}" stroke-dashoffset="${offset}"${attrs(sl)}></circle>`;
      offset -= len;
      return arc;
    }).join('');
  }

  // Small chart on the Budget screen: top 5 categories plus Other. Tapping it opens the full chart.
  function donutHtml(month) {
    const rows = spendingByCategory(month);
    if (!rows.length) return '';
    const total = rows.reduce((s, r) => s + r[1], 0);
    const top = rows.slice(0, 5);
    const other = rows.slice(5).reduce((s, r) => s + r[1], 0);
    const slices = top.map(([name, v], i) => ({ name, v, cls: `p${i + 1}` }));
    if (other > 0.5) slices.push({ name: 'Other', v: other, cls: 'p6' });
    const arcs = arcsHtml(slices, total, () => '');
    const label = chartLabel(month);
    const legend = slices.map((sl) => `<div class="leg-row">
      <span><i class="dot ${sl.cls}"></i>${esc(sl.name.trim())}</span><span>${Math.round((sl.v / total) * 100)}%</span></div>`).join('');
    return `<div class="card donut-card" id="chart-open" role="button" aria-label="Show all categories"><div class="donut-head">
      ${rangeSeg()}</div>
      <div class="donut-body"><svg viewBox="0 0 42 42" class="donut" role="img" aria-label="Spending by category">
        <circle class="track" cx="21" cy="21" r="15.915"></circle>${arcs}
        <text x="21" y="21" class="donut-total">${fmt0(total)}</text><text x="21" y="26.5" class="donut-sub">${esc(label)}</text></svg>
      <div class="legend">${legend}</div></div></div>`;
  }

  // Full chart: every category, largest first. Tapping a category (or its slice) shows its
  // transactions right under it.
  function renderChartFull() {
    const month = budgetMonth();
    const rows = spendingByCategory(month);
    const total = rows.reduce((s, r) => s + r[1], 0);
    const open = state.chartOpen && rows.some(([n]) => n === state.chartOpen) ? state.chartOpen : null;
    const slices = rows.map(([name, v], i) => ({ name, v, cls: `c${i % 12}` }));
    const sel = open && slices.find((sl) => sl.name === open);
    const arcs = arcsHtml(slices, total, (sl) => ` data-chart-cat="${esc(sl.name)}"${open && sl.name !== open ? ' opacity="0.25"' : ''}`);
    const from = state.chartRange === 'year' ? month.slice(0, 4) + '-01' : month;
    let html = `<button class="back-btn" id="chart-back">‹ Budget</button>`;
    html += budgetMonthSelect();
    html += `<div class="card donut-card"><div class="donut-head">${rangeSeg()}</div>`;
    if (!rows.length) {
      $('view-budget').innerHTML = html + `<div class="empty">No spending in ${esc(chartLabel(month))}.</div></div>`;
      return;
    }
    html += `<svg viewBox="0 0 42 42" class="donut donut-big" role="img" aria-label="Spending by category">
        <circle class="track" cx="21" cy="21" r="15.915"></circle>${arcs}
        <text x="21" y="${sel ? 20 : 21.2}" class="donut-total">${fmt0(sel ? sel.v : total)}</text>
        <text x="21" y="${sel ? 24 : 25.4}" class="donut-sub">${esc(sel ? sel.name.trim().slice(0, 22) : chartLabel(month))}</text>
        ${sel ? `<text x="21" y="27.4" class="donut-sub">${Math.round((sel.v / total) * 100)}% of ${fmt0(total)}</text>` : ''}</svg>`;
    html += `<div class="muted small center">${rows.length} categor${rows.length === 1 ? 'y' : 'ies'} · tap one to see its transactions</div></div><div class="card">`;
    for (const sl of slices) {
      const isOpen = sl.name === open;
      html += `<button class="all-cat${isOpen ? ' open' : ''}" data-chart-cat="${esc(sl.name)}">
        <i class="dot ${sl.cls}"></i><span class="all-name">${esc(sl.name.trim())}</span>
        <span class="all-amt">${fmt0(sl.v)}</span><span class="all-pct">${Math.round((sl.v / total) * 100)}%</span></button>`;
      if (isOpen) {
        const list = state.data.txns.filter((t) => t.category === sl.name && t.date.slice(0, 7) >= from && t.date.slice(0, 7) <= month)
          .sort((a, b) => b.date.localeCompare(a.date) || a.row - b.row);
        html += `<div class="all-tx">${list.map((t) => txRowHtml(t, dayLabel(t.date))).join('')}</div>`;
      }
    }
    $('view-budget').innerHTML = html + '</div>';
  }

  // One category's transactions for the chosen month, opened by tapping it on the Budget screen.
  function renderBudgetDetail(name) {
    const month = budgetMonth();
    const cat = state.data.categories.find((c) => c.name === name) || { name, budget: 0 };
    const budget = budgetFor(cat, month);
    const list = state.data.txns
      .filter((t) => t.category === name && t.date.startsWith(month))
      .sort((a, b) => b.date.localeCompare(a.date) || a.row - b.row);
    const spent = -list.reduce((s, t) => s + t.amount, 0);
    const isOver = budget > 0 && spent > budget + 0.005;
    const over = budgetStatus(spent, budget) === 'over';
    const w = budget ? Math.min(100, Math.max(0, (spent / budget) * 100)) : (spent > 0 ? 100 : 0);
    const label = monthLabel(month);

    let html = `<button class="back-btn" id="budget-back">‹ Budget</button>
      <div class="hero photo photo-budget"><div class="label">${esc(name)} · ${label}</div>
      <div class="big ${over ? 'neg' : ''}">${fmt0(spent)} <span class="muted small" style="font-weight:400">of ${fmt0(budget)}</span></div>
      <div class="small ${over ? 'neg' : 'muted'}">${budget ? (isOver ? fmt0(spent - budget) + ' over' : fmt0(budget - spent) + ' left') : 'No budget set'} · ${list.length} transaction${list.length === 1 ? '' : 's'}</div>
      <div class="bar progress-total ${budgetStatus(spent, budget)}"><i style="width:${w}%"></i></div></div>`;
    html += budgetMonthSelect();
    html += list.length ? txGroupsHtml(list, false) : `<div class="empty">No ${esc(name)} transactions in ${label}.</div>`;
    $('view-budget').innerHTML = html;
  }

  function txRowHtml(t, sub) {
    return `<button class="tx" data-idx="${t.idx}">
        <div class="name" style="min-width:0"><div>${esc(t.desc)}</div>
        <div class="small"><span class="tag ${t.category ? '' : 'uncat'}">${esc(t.category || 'Needs category')}</span>${t.ask ? '<span class="tag uncat">Asked</span>' : ''}<span class="muted"> · ${esc(sub)}</span></div>
        ${t.note ? `<div class="tx-note">${esc(t.note)}</div>` : ''}</div>
        <div class="amt ${t.amount > 0 ? 'pos' : ''}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</div></button>`;
  }

  // Transactions in cards under date headings, or account headings when byAccount.
  function txGroupsHtml(list, byAccount) {
    let html = '';
    let head = null;
    for (const t of list) {
      const h = byAccount ? t.account || 'No account' : t.date;
      if (h !== head) {
        if (head !== null) html += '</div>';
        head = h;
        html += `<div class="section-label">${esc(byAccount ? h : dayLabel(h))}</div><div class="card">`;
      }
      html += txRowHtml(t, byAccount ? dayLabel(t.date) : t.account);
    }
    if (head !== null) html += '</div>';
    return html;
  }

  const monthLabel = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  // Accounts are told apart by number, since two accounts can share a name.
  // Accounts are matched by account number, so an account Tiller renamed after a reconnect
  // keeps its whole history. Accounts without a number fall back to their name.
  const acctKey = (name, number) => (number ? `#${number}` : `@${name}`);
  const acctLabel = (key) => {
    if (key.startsWith('@')) return key.slice(1).trim();
    const number = key.slice(1);
    const a = state.data.accounts.find((x) => x.number === number && !x.hidden) || state.data.accounts.find((x) => x.number === number);
    const t = !a && state.data.txns.find((x) => x.number === number);
    const name = (a && a.name) || (t && t.account) || '';
    const last4 = number.replace(/\D/g, '').slice(-4);
    return name ? `${name.trim()} (${last4})` : `Account ${last4}`;
  };
  const OLDER = '__older';
  const olderOption = () => (state.data.hasOlder && !state.fullHistory
    ? `<option value="${OLDER}">Load months before ${monthLabel(state.data.historyFrom.slice(0, 7))}…</option>` : '');

  function fillFilters() {
    const months = [...new Set(state.data.txns.map((t) => t.date.slice(0, 7)))].sort().reverse();
    const msel = $('tx-month');
    msel.innerHTML = '<option value="">All months</option>' + months.map((k) => `<option value="${k}">${monthLabel(k)}</option>`).join('') + olderOption();
    if (!months.includes(state.month)) state.month = '';
    msel.value = state.month;

    const sel = $('tx-account');
    const keys = [...new Set(state.data.txns.filter((t) => t.account).map((t) => acctKey(t.account, t.number)))]
      .sort((a, b) => acctLabel(a).localeCompare(acctLabel(b)));
    if (state.account && !keys.includes(state.account)) keys.unshift(state.account);   // opened from Accounts
    sel.innerHTML = '<option value="">All accounts</option>' + keys.map((k) => `<option value="${esc(k)}">${esc(acctLabel(k))}</option>`).join('');
    sel.value = state.account;
    $('tx-sort').value = state.sort;
  }

  function loadOlderHistory() {
    state.fullHistory = true;
    toast('Loading older history…', 0);
    loadData({ quiet: true }).then((r) => toast(r === 'ok' ? 'Older history loaded' : '', 2000));
  }

  // Small chips under the search box showing which filters are on; × clears one.
  function activeChipsHtml() {
    const chips = [];
    const SHOW = { uncat: 'Needs category', asked: 'Asked' };
    if (state.show) chips.push(['show', SHOW[state.show]]);
    if (state.month) chips.push(['month', monthLabel(state.month)]);
    if (state.account) chips.push(['account', acctLabel(state.account)]);
    if (state.sort === 'account') chips.push(['sort', 'By account']);
    return chips.map(([k, label]) => `<button class="fchip" data-clear="${k}">${esc(label)} <span aria-hidden="true">×</span></button>`).join('');
  }

  function renderTxControls() {
    $('tx-filter-panel').hidden = !state.filtersOpen;
    $('filter-btn').classList.toggle('on', state.filtersOpen);
    const n = (state.month ? 1 : 0) + (state.account ? 1 : 0) + (state.sort === 'account' ? 1 : 0) + (state.show ? 1 : 0);
    $('tx-show').value = state.show;
    $('filter-count').textContent = n ? String(n) : '';
    $('filter-count').hidden = !n;
    $('tx-active').innerHTML = activeChipsHtml();
    $('tx-active').hidden = !n;
  }

  // Opens the Transactions tab showing one account's transactions (tapped on Accounts).
  function openAccount(key) {
    state.account = key;
    state.month = '';
    state.search = '';
    $('tx-search').value = '';
    $('search-clear').hidden = true;
    state.limit = PAGE_SIZE;
    state.tab = 'tx';
    fillFilters();
    render();
    window.scrollTo(0, 0);
  }

  function filteredTx() {
    const q = state.search.trim().toLowerCase();
    let list = state.data.txns.filter((t) => {
      if (state.account && acctKey(t.account, t.number) !== state.account) return false;
      if (state.show === 'uncat' && t.category) return false;
      if (state.show === 'asked' && !t.ask) return false;
      if (state.month && !t.date.startsWith(state.month)) return false;
      if (!q) return true;
      return t.desc.toLowerCase().includes(q) || t.category.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q) ||
        t.account.toLowerCase().includes(q) || (-t.amount).toFixed(2).includes(q);
    });
    list = list.slice().sort((a, b) =>
      state.sort === 'account'
        ? a.account.localeCompare(b.account) || b.date.localeCompare(a.date) || a.row - b.row
        : b.date.localeCompare(a.date) || a.row - b.row);
    return list;
  }

  // Banner summary for the month picked in the filter, or this month when none is picked.
  function renderTxHero() {
    const month = state.month || thisMonth();
    const uncat = state.data.txns.filter((t) => t.date.startsWith(month) && !t.category).length;
    const queue = reviewQueue().length;
    const monthName = monthLabel(month);
    $('tx-hero').innerHTML = `<div class="hero photo photo-transactions"><div class="label">${monthName}</div>
      ${uncat ? `<div class="big">${uncat}</div>` : ''}
      <div class="small ${uncat ? 'warn' : ''}">${uncat ? `need${uncat === 1 ? 's' : ''} categorizing` : 'All categorized'}</div>
      ${queue ? `<button class="hero-btn" id="review-open">Review ${queue}</button>` : ''}</div>`;
  }

  function renderTx() {
    renderTxHero();
    renderTxControls();
    const list = filteredTx();
    const shown = list.slice(0, state.limit);
    let html = '';
    // Totals whenever a search or filter narrows the list.
    if (state.search.trim() || state.month || state.account || state.show) {
      const out = list.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
      const inn = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
      html += `<div class="tx-total"><b>${list.length} transaction${list.length === 1 ? '' : 's'}</b>
        <span>${out ? `${fmt(out)} out` : ''}${out && inn ? ' · ' : ''}${inn ? `<span class="pos">+${fmt(inn)} in</span>` : ''}</span></div>`;
    }
    html += list.length ? txGroupsHtml(shown, state.sort === 'account') : `<div class="empty">No transactions match.</div>`;
    if (list.length > shown.length) html += `<button class="show-more" id="show-more">Show more (${list.length - shown.length} left)</button>`;
    if (state.data.hasOlder && !state.fullHistory && list.length <= shown.length) {
      html += `<button class="show-more" id="load-older">Load transactions before ${monthLabel(state.data.historyFrom.slice(0, 7))}</button>`;
    }
    $('tx-list').innerHTML = html;
  }

  // ---------- Connections ----------
  // Health of each bank connection, judged from each account's "Last Update" on the
  // Accounts tab. Only accounts that show on Tiller's Balances tab (not hidden) count.

  const TILLER_CONSOLE = 'https://my.tiller.com';
  const CONN_OK_DAYS = 2;    // updated within 2 days: OK
  const CONN_FIX_DAYS = 7;   // 7+ days: needs a fix; in between: check

  function daysSince(key) {
    if (!key) return null;
    const [y, m, d] = key.split('-').map(Number);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((today - new Date(y, m - 1, d)) / 86400000);
  }

  // Manually entered accounts (home value, business value, …) have no bank to refresh.
  const isManual = (a) => a.id.startsWith('manual:') || (!a.institution && !a.number);

  // Accounts listed under "Ignore accounts for connection alerts" on the Automation Settings
  // tab (last 4 digits or exact names) are left out, matching the sheet's script.
  function isIgnored(a) {
    const digits = a.number.replace(/\D/g, '');
    const name = a.name.trim().toLowerCase();
    return (state.data.ignore || []).some((x) => (/^\d{3,}$/.test(x) ? digits.endsWith(x) : name === x));
  }

  // The Connections checks scan every transaction, so each result is kept until the data
  // changes: a new load (new state.data) or any save (writeSeq moves on every write).
  const memo = { data: null, seq: -1, v: {} };
  function cached(name, fn) {
    if (memo.data !== state.data || memo.seq !== writeSeq) { memo.data = state.data; memo.seq = writeSeq; memo.v = {}; }
    return name in memo.v ? memo.v[name] : (memo.v[name] = fn());
  }
  const duplicates = () => cached('dups', () => findDuplicates(state.data.txns));

  function connectionGroups() { return cached('groups', connectionGroupsNow); }
  function connectionGroupsNow() {
    const banks = new Map();
    for (const a of state.data.accounts) {
      if (a.hidden || isManual(a) || isIgnored(a)) continue;
      const key = a.institution || a.name;
      if (!banks.has(key)) banks.set(key, []);
      banks.get(key).push({ ...a, days: daysSince(a.updated) });
    }
    return [...banks].map(([name, accts]) => {
      // The stalest account decides: a broken login stops all of its accounts.
      const days = Math.max(...accts.map((a) => (a.days === null ? 9999 : a.days)));
      const status = days <= CONN_OK_DAYS ? 'ok' : days < CONN_FIX_DAYS ? 'check' : 'fix';
      return { name, accts, days, status };
    }).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  }

  const agoDays = (d) => (d === null || d >= 9999 ? 'never updated' : d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);
  const STATUS_TAG = { ok: '<span class="tag ok">OK</span>', check: '<span class="tag check">Check</span>', fix: '<span class="tag fix">Needs a fix</span>' };

  // When Tiller last filled the sheet: the newest "Date Added" on the Transactions tab.
  // Sheet dates are serial numbers in the sheet's own time zone (Los Angeles), so they
  // are shown as-is rather than converted from the phone's time zone.
  // "Date Added" only moves when new transactions arrive, and quiet days (weekends) add
  // nothing even when AutoFill runs every 6 hours, so only warn after 2 days.
  const FILL_LATE_HOURS = 48;

  function sheetSerialNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 86400000 + 25569;
  }

  function lastFilledHtml() {
    const serials = state.data.txns.map((t) => t.added).filter((v) => typeof v === 'number');
    if (!serials.length) return '';
    const last = serials.reduce((m, v) => (v > m ? v : m), -Infinity);
    const d = new Date(Math.round((last - 25569) * 86400000));
    const when = d.toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const hours = (sheetSerialNow() - last) * 24;
    const ago = hours < 1 ? 'less than an hour ago' : hours < 48 ? `${Math.floor(hours)} hr ago` : `${Math.floor(hours / 24)} days ago`;
    const late = hours > FILL_LATE_HOURS;
    return `<div class="filled ${late ? 'late' : ''}"><span>Sheet last filled</span><b>${when.replace(',', '').replace(/, (\d)/, ' at $1')} PT</b>
      <span class="small">${ago}${late ? ' · Nothing new in 2 days. Check that AutoFill is on.' : ''}</span></div>`;
  }

  // Transactions whose category matches a budget category except for spaces or capitals.
  // Tiller matches names exactly, so these are left out of budgets until fixed.
  // Old categories that are no longer on the Categories tab are
  // deliberately ignored.
  function categoryIssues() { return cached('cats', categoryIssuesNow); }
  function categoryIssuesNow() {
    const exact = new Set(state.data.categories.map((c) => c.name));
    const loose = new Map(state.data.categories.map((c) => [c.name.trim().toLowerCase(), c.name]));
    const fixable = [];
    for (const t of state.data.txns) {
      if (!t.category || !t.id || exact.has(t.category)) continue;
      const to = loose.get(t.category.trim().toLowerCase());
      if (to) fixable.push({ t, to });
    }
    return { fixable };
  }

  function sheetCheckHtml(issues) {
    const { fixable } = issues;
    if (!fixable.length) return '';
    let h = `<div class="section-label">Sheet check</div><div class="card">`;
    if (fixable.length) {
      h += `<div class="row"><div class="name"><div class="wrap">${fixable.length} transaction${fixable.length === 1 ? ' uses' : 's use'} a category name that's slightly off</div>
        <div class="muted small wrap">An extra space or capital letter, so Tiller leaves ${fixable.length === 1 ? 'it' : 'them'} out of budgets</div></div>
        <span class="tag check">Fixable</span></div>`;
    }
    h += '</div>';
    if (fixable.length) {
      h += `<button class="btn-soft btn-block" id="cat-fix"${state.fixing ? ' disabled' : ''}>${state.fixing ? 'Fixing…' : `Fix ${fixable.length} category name${fixable.length === 1 ? '' : 's'}`}</button>`;
    }
    return h;
  }

  async function fixCategoryNames() {
    if (state.fixing) return;
    const items = categoryIssues().fixable;
    if (!items.length) return;
    if (!window.confirm(`Change ${items.length} transaction${items.length === 1 ? '' : 's'} to the exact category name${items.length === 1 ? '' : 's'} from your Categories tab?`)) return;
    state.fixing = true;
    renderConnections();
    try {
      const n = await source.fixCategories(items.map(({ t, to }) => ({ id: t.id, row: t.row, from: t.category, to })));
      toast(`Fixed ${n} transaction${n === 1 ? '' : 's'}`, 3000);
    } catch (e) {
      if (e instanceof AuthError) showBanner('Your sign-in expired, so nothing was changed.', 'Sign in', () => startSignIn(false));
      else showBanner(e.message || "Couldn't fix the category names.");
    } finally {
      state.fixing = false;
      await loadData({ quiet: true });
    }
  }

  function updateConnectionsBadge() {
    const btn = document.querySelector('.tabbar button[data-tab="connections"]');
    if (!btn || !state.data) return;
    const dups = duplicates();
    const cats = categoryIssues();
    const attention = connectionGroups().some((g) => g.status === 'fix') ||
      dups.safe.length > 0 || dups.review.length > 0 || cats.fixable.length > 0;
    btn.classList.toggle('badge', attention);
  }

  function renderConnections() {
    if (state.connBank) { renderBankDetail(state.connBank); return; }
    const groups = connectionGroups();
    const fix = groups.filter((g) => g.status === 'fix');
    const check = groups.filter((g) => g.status === 'check');
    const ok = groups.filter((g) => g.status === 'ok');
    const manual = state.data.accounts.filter((a) => !a.hidden && isManual(a));
    const dups = duplicates();

    const parts = [];
    if (fix.length) parts.push(`${fix.length} need${fix.length === 1 ? 's' : ''} a fix`);
    if (check.length) parts.push(`${check.length} to check`);
    let html = `<div class="hero photo photo-connections"><div class="label">Bank connections</div>
      <div class="big">${parts.length ? parts.join(' · ') : 'All healthy'}</div></div>
      <div class="card conn-card">${lastFilledHtml()}
      <a class="btn-primary btn-link conn-console" href="${TILLER_CONSOLE}" target="_blank" rel="noopener noreferrer">Open Tiller Console</a></div>`;

    html += alertsHtml();
    if (dups.safe.length || dups.review.length) html += duplicatesHtml(dups);
    html += rulesHtml();
    html += sheetCheckHtml(categoryIssues());

    const section = (title, list) => {
      if (!list.length) return '';
      let h = `<div class="section-label">${title}</div><div class="card">`;
      for (const g of list) {
        h += `<button class="row conn-bank" data-bank="${esc(g.name)}"><div class="name"><div>${esc(g.name)}</div>
          <div class="muted small">${g.accts.length} account${g.accts.length === 1 ? '' : 's'} · ${agoDays(g.days)}</div></div>
          <div>${STATUS_TAG[g.status]} <span class="chev">›</span></div></button>`;
      }
      return h + '</div>';
    };
    html += section('Needs a fix', fix) + section('Check', check);
    if (ok.length) {
      html += `<div class="section-label">Healthy</div><div class="card"><button class="row" id="toggle-healthy"><div class="name">
        <div>${ok.length} bank${ok.length === 1 ? '' : 's'} updating normally</div>
        <div class="muted small wrap">${esc(ok.map((g) => g.name).join(', '))}</div></div>
        <span class="chev${state.showHealthy ? ' open' : ''}">›</span></button></div>`;
      if (state.showHealthy) html += section('', ok).replace('<div class="section-label"></div>', '');
    }
    if (manual.length) {
      html += `<div class="section-label">Manual entries</div><div class="card"><div class="row"><div class="name">
        <div class="wrap">${esc(manual.map((a) => a.name.trim()).join(', '))}</div>
        <div class="muted small">You update these by hand in Tiller</div></div><span class="tag manual">Manual</span></div></div>`;
    }
    html += lockHtml();
    html += `<div class="footnote">OK: updated within ${CONN_OK_DAYS} days · Check: ${CONN_OK_DAYS + 1}–${CONN_FIX_DAYS - 1} days · Needs a fix: ${CONN_FIX_DAYS}+ days</div>`;
    $('view-connections').innerHTML = html;
    bindAlertSwipes();
  }

  const serialToText = (v) => new Date(Math.round((v - 25569) * 86400000))
    .toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Alerts from the last 7 days, from the sheet's automation script.
  // Connection and sheet-filling alerts are left out: the live status at the top of this
  // screen already shows them, and clears as soon as they're fixed.
  const LIVE_TYPES = new Set(['connection', 'fill']);
  const DISMISSED_KEY = 'pf_dismissed_alerts';
  const alertKey = (a) => `${a.when}|${a.title}`;
  function dismissedAlerts() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch (_) { return new Set(); }
  }
  function dismissAlert(key) {
    const keep = new Set((state.data.alerts || []).map(alertKey));   // forget alerts that have aged out
    const set = new Set([...dismissedAlerts()].filter((k) => keep.has(k)));
    set.add(key);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set])); } catch (_) { /* ignore */ }
  }

  function alertsHtml() {
    const hidden = dismissedAlerts();
    const recent = (state.data.alerts || [])
      .filter((a) => sheetSerialNow() - a.when <= 7 && !LIVE_TYPES.has(a.type) && !hidden.has(alertKey(a)))
      .slice(0, 6);
    if (!recent.length) return '';
    let h = `<div class="section-label"><span>Recent alerts</span><span class="hint-sm">Swipe left to dismiss</span></div><div class="card">`;
    for (const a of recent) {
      h += `<div class="row alert-row" data-alert="${esc(alertKey(a))}"><div class="name"><div class="wrap"><b>${esc(a.title)}</b></div>
        <div class="muted small wrap">${esc(a.message).replace(/\n/g, '<br>')}</div>
        <div class="muted small">${serialToText(a.when)}</div></div>
        <button class="alert-x" aria-label="Dismiss alert">×</button></div>`;
    }
    return h + '</div>';
  }

  function removeAlertRow(row) {
    dismissAlert(row.dataset.alert);
    row.style.transition = 'transform 0.2s, opacity 0.2s';
    row.style.transform = 'translateX(-100%)';
    row.style.opacity = '0';
    setTimeout(() => renderConnections(), 200);
  }

  // Swipe an alert left to dismiss it.
  function bindAlertSwipes() {
    document.querySelectorAll('#view-connections .alert-row').forEach((row) => {
      let x0 = null, y0 = 0, dx = 0;
      row.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; row.style.transition = 'none'; }, { passive: true });
      row.addEventListener('touchmove', (e) => {
        if (x0 === null) return;
        const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
        if (Math.abs(my) > Math.abs(mx)) { dx = 0; row.style.transform = ''; return; }   // scrolling, not swiping
        dx = Math.min(0, mx);
        row.style.transform = `translateX(${dx}px)`;
      }, { passive: true });
      row.addEventListener('touchend', () => {
        x0 = null;
        if (dx < -80) { removeAlertRow(row); return; }
        row.style.transition = 'transform 0.2s';
        row.style.transform = '';
      });
    });
  }

  function rulesHtml() {
    const rules = state.data.rules || [];
    if (!rules.length) return '';
    let h = `<div class="section-label">Suggested AutoCat rules</div><div class="card">`;
    rules.forEach((r, i) => {
      const busy = state.ruleBusy === i;
      h += `<div class="row rule-row"><div class="name"><div class="wrap">${esc(r.keyword)} → <b>${esc(r.category.trim())}</b></div>
        <div class="muted small">Seen ${r.count} times${r.uncategorized ? ` · ${r.uncategorized} uncategorized now` : ''}</div></div>
        <div class="rule-btns"><button class="btn-mini" data-rule="${i}" data-act="approve"${busy ? ' disabled' : ''}>${busy ? '…' : 'Approve'}</button>
        <button class="btn-mini ghost" data-rule="${i}" data-act="dismiss"${busy ? ' disabled' : ''}>Dismiss</button></div></div>`;
    });
    return h + `</div><div class="footnote">Approving adds the rule to your AutoCat tab and categorizes matching transactions that have no category.</div>`;
  }

  async function ruleAction(i, act) {
    const rule = (state.data.rules || [])[i];
    if (!rule || state.ruleBusy != null) return;
    state.ruleBusy = i;
    renderConnections();
    try {
      if (act === 'approve') {
        const n = await source.approveRule(rule, state.data.txns);
        toast(`Rule added${n ? ` · ${n} transaction${n === 1 ? '' : 's'} categorized` : ''}`, 3000);
      } else {
        await source.dismissRule(rule);
        toast('Suggestion dismissed');
      }
    } catch (e) {
      if (e instanceof AuthError) showBanner('Your sign-in expired, so nothing was changed.', 'Sign in', () => startSignIn(false));
      else showBanner(e.message || "Couldn't update the rule.");
    } finally {
      state.ruleBusy = null;
      await loadData({ quiet: true });
    }
  }

  function duplicatesHtml(dups) {
    const n = dups.safe.reduce((s, g) => s + g.remove.length, 0);
    let h = `<div class="section-label">Duplicate transactions</div><div class="card dup-card">`;
    for (const g of dups.safe) {
      const t = g.keep;
      h += `<div class="row"><div class="name"><div>${esc(t.desc)}</div>
        <div class="muted small">${dayLabel(t.date)} · ${esc(t.account)} · ${g.copies.length} copies</div></div>
        <div class="amt">${fmt(t.amount)}</div></div>`;
    }
    for (const g of dups.review) {
      const t = g.copies[0];
      h += `<div class="row"><div class="name"><div>${esc(t.desc)}</div>
        <div class="muted small">Same ID, but the copies differ. Check these in your sheet.</div></div>
        <span class="tag check">Review</span></div>`;
    }
    h += '</div>';
    if (n) {
      h += `<button class="btn-danger" id="dup-delete"${state.deleting ? ' disabled' : ''}>${state.deleting ? 'Deleting…' : `Delete ${n} duplicate${n === 1 ? '' : 's'}`}</button>
        <div class="footnote">One copy of each is kept. Deleted rows are saved to the “${LOG_TAB}” tab in your sheet.</div>`;
    }
    return h;
  }

  function renderBankDetail(name) {
    const g = connectionGroups().find((x) => x.name === name);
    if (!g) { state.connBank = null; renderConnections(); return; }
    let html = `<button class="back-btn" id="conn-back">‹ Connections</button>
      <div class="hero photo photo-connections conn-summary"><div class="big-sm">${esc(g.name)}</div>
      <div class="small">${STATUS_TAG[g.status]} <span class="muted">last update ${agoDays(g.days)}</span></div></div>
      <div class="section-label">Accounts</div><div class="card">`;
    for (const a of g.accts.sort((x, y) => (y.days ?? 9999) - (x.days ?? 9999))) {
      html += `<div class="row"><div class="name"><div>${esc(a.name)}</div><div class="muted small">${esc(a.number)}</div></div>
        <div class="muted small">${agoDays(a.days)}</div></div>`;
    }
    html += '</div>';
    if (g.status === 'ok') {
      html += `<div class="footnote">This connection is updating normally.</div>`;
    } else {
      html += `<div class="section-label">How to fix</div><div class="card steps">
        <div class="step"><span class="num">1</span><span>Tap <b>Open Tiller Console</b> below.</span></div>
        <div class="step"><span class="num">2</span><span>Go to <b>Accounts</b> and find ${esc(g.name)}.</span></div>
        <div class="step"><span class="num">3</span><span>${g.status === 'check'
          ? 'Tap <b>Refresh</b> next to it, or <b>Refresh Accounts</b> at the top.'
          : 'Tap the orange <b>Fix</b> button, or the gear then <b>Edit credentials</b>, and sign in to your bank again.'}</span></div>
        <div class="step"><span class="num">4</span><span>Tiller's AutoFill brings new data into your sheet within about 6 hours. Tap ↻ at the top to see it here.</span></div></div>
        <a class="btn-primary btn-link" href="${TILLER_CONSOLE}" target="_blank" rel="noopener noreferrer">Open Tiller Console</a>`;
    }
    $('view-connections').innerHTML = html;
  }

  async function deleteDuplicates() {
    if (state.deleting) return;
    const dups = duplicates().safe;
    const n = dups.reduce((s, g) => s + g.remove.length, 0);
    if (!n) return;
    const ok = window.confirm(`Delete ${n} duplicate transaction${n === 1 ? '' : 's'}?\n\nOne copy of each is kept, and the deleted rows are saved to the “${LOG_TAB}” tab.`);
    if (!ok) return;
    state.deleting = true;
    renderConnections();
    try {
      const removed = await source.deleteDuplicates(dups.map((g) => g.id));
      toast(`Deleted ${removed} duplicate${removed === 1 ? '' : 's'}`, 3000);
    } catch (e) {
      if (e instanceof AuthError) showBanner('Your sign-in expired, so nothing was deleted.', 'Sign in', () => startSignIn(false));
      else showBanner(e.message || "Couldn't delete the duplicates.");
    } finally {
      state.deleting = false;
      await loadData({ quiet: true });
    }
  }

  // ---------- Pull to refresh ----------
  // Pull down from the top of any screen to reload from the sheet.
  function bindPullToRefresh() {
    const ptr = $('ptr');
    let y0 = null, dy = 0;
    const blocked = () => $('app').hidden || !$('sheet').hidden || !$('review').hidden || !$('lock').hidden;
    document.addEventListener('touchstart', (e) => {
      if (window.scrollY > 0 || blocked() || state.loading) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      if (!dy) return;
      const h = Math.min(dy * 0.5, 70);
      ptr.style.height = h + 'px';
      ptr.classList.toggle('ready', h >= 55);
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (y0 === null) return;
      const go = ptr.classList.contains('ready');
      y0 = null;
      ptr.style.height = '0';
      ptr.classList.remove('ready');
      if (go) loadData({ quiet: true });
    });
  }

  // ---------- Review queue ----------
  // Uncategorized transactions that nobody has reviewed yet, newest first. Saving sets the
  // category (and note) and stamps the Reviewed column, so both phones share one queue.

  const reviewQueue = () => state.data.txns.filter((t) => (!t.category && !t.reviewed) || t.ask)
    .sort((a, b) => (b.ask ? 1 : 0) - (a.ask ? 1 : 0) || b.date.localeCompare(a.date) || a.row - b.row);

  const merchant = (d) => String(d).toLowerCase().replace(/[#*]/g, ' ').split(/\s+/)
    .filter((w) => w && !/\d/.test(w)).join(' ').replace(/[^a-z0-9&' ]/g, '').trim();

  // Likely categories: what this merchant was categorized as before, then your most used ones.
  function suggestCategories(t) {
    const valid = new Set(state.data.categories.filter((c) => !c.hidden).map((c) => c.name));
    const count = (list) => {
      const m = new Map();
      list.forEach((x) => { if (x.category && valid.has(x.category)) m.set(x.category, (m.get(x.category) || 0) + 1); });
      return [...m].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    };
    const k = merchant(t.desc);
    const fromMerchant = k ? count(state.data.txns.filter((x) => x !== t && merchant(x.desc) === k)) : [];
    const yearAgo = localKey(new Date(Date.now() - 365 * 86400000));
    const popular = count(state.data.txns.filter((x) => x.date >= yearAgo));
    const chips = [...new Set([...fromMerchant, ...popular])].slice(0, 4);
    return { chips, best: fromMerchant[0] || '' };
  }

  function openReview() {
    const list = reviewQueue();
    state.review = { list, i: 0, chosen: null, saving: false };
    if (list.length) state.review.chosen = list[0].category || suggestCategories(list[0]).best || null;
    $('review').hidden = false;
    document.body.classList.add('no-scroll');
    renderReview();
  }

  function closeReview() {
    state.review = null;
    $('review').hidden = true;
    document.body.classList.remove('no-scroll');
    render();
  }

  function renderReview() {
    const r = state.review;
    if (!r) return;
    const t = r.list[r.i];
    let html = `<div class="review-top"><button class="text-btn" id="rv-done">‹ Done</button><b>Review</b>
      <span class="muted small">${t ? `${r.i + 1} of ${r.list.length}` : ''}</span></div>
      <div class="bar rv-prog"><i style="width:${r.list.length ? (r.i / r.list.length) * 100 : 100}%"></i></div>`;
    if (!t) {
      html += `<div class="rv-empty"><div class="big-sm">All caught up</div>
        <div class="muted">Nothing is waiting for a category.</div>
        <button class="btn-primary" id="rv-finish">Done</button></div>`;
      $('review').innerHTML = html;
      return;
    }
    const { chips } = suggestCategories(t);
    if (r.chosen && !chips.includes(r.chosen)) chips.unshift(r.chosen);
    html += `<div class="card rv-card" id="rv-card">
      <div class="muted small">${esc(dayLabel(t.date))} · ${esc(t.account)}</div>
      <div class="rv-desc">${esc(t.desc)}</div>
      <div class="rv-amt ${t.amount > 0 ? 'pos' : ''}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</div>
      ${t.ask ? `<div class="ask-box"><b>Question</b><div>${esc(t.note || 'No question written yet.')}</div></div>` : ''}
      <div class="section-label">Category</div>
      <div class="chips">${chips.map((c) => `<button class="chip ${c === r.chosen ? 'on' : ''}" data-chip="${esc(c)}">${esc(c.trim())}</button>`).join('')}
        <button class="chip more" id="rv-more">More…</button></div>
      ${state.data.hasNote ? `<div class="section-label">Note</div><textarea id="rv-note" rows="2" placeholder="Add a note (optional)">${esc(t.note || '')}</textarea>` : ''}
    </div>
    <div class="rv-btns"><button class="btn-soft" id="rv-skip">Skip</button>
      <button class="btn-primary" id="rv-save"${r.chosen && !r.saving ? '' : ' disabled'}>${r.saving ? 'Saving…' : t.ask ? 'Answered ✓' : 'Save ✓'}</button></div>
    <div class="footnote">Swipe right to save · left to skip${t.ask && t.category ? '' : '<br><button class="text-btn small" id="rv-none">Mark reviewed without a category</button>'}</div>`;
    $('review').innerHTML = html;
    bindSwipe($('rv-card'));
  }

  function reviewNext() {
    const r = state.review;
    r.i++;
    const nxt = r.list[r.i];
    r.chosen = nxt ? nxt.category || suggestCategories(nxt).best || null : null;
    renderReview();
  }

  function reviewPick(t, name) {
    if (!state.review) return;
    state.review.chosen = name;
    renderReview();
  }

  async function reviewSave(withCategory) {
    const r = state.review;
    const t = r && r.list[r.i];
    if (!t || r.saving || (withCategory && !r.chosen)) return;
    const note = state.data.hasNote ? ($('rv-note')?.value || '').trim() : t.note;
    const fields = {};
    if (withCategory && r.chosen !== t.category) fields.Category = r.chosen;
    if (t.ask) fields.Ask = '';
    if (state.data.hasReviewed) fields.Reviewed = localKey(new Date());
    if (state.data.hasNote && note !== (t.note || '')) fields.Note = note;
    r.saving = true;
    renderReview();
    try {
      await source.setFields(t, fields);
      if (withCategory) t.category = r.chosen;
      t.ask = false;
      if ('Note' in fields) t.note = note;
      t.reviewed = true;
      r.saving = false;
      reviewNext();
    } catch (e) {
      r.saving = false;
      renderReview();
      toast(e instanceof AuthError ? 'Your sign-in expired, so that wasn’t saved.' : (e.message || "Couldn't save."), 4000);
    }
  }

  // Swipe the card: right saves, left skips.
  function bindSwipe(el) {
    if (!el) return;
    let x0 = null, dx = 0;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; dx = 0; el.style.transition = 'none'; }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (x0 === null) return;
      dx = e.touches[0].clientX - x0;
      el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    }, { passive: true });
    el.addEventListener('touchend', () => {
      el.style.transition = 'transform 0.2s';
      el.style.transform = '';
      if (dx > 90 && state.review.chosen) reviewSave(true);
      else if (dx < -90 && !state.review.saving) reviewNext();
      x0 = null;
    });
  }

  // ---------- Face ID lock ----------
  // A passkey on this phone (Face ID, or the phone passcode as backup) must be used to open
  // the app after 5 minutes away. It's a lock on this device; Google sign-in still protects the data.

  const LOCK_KEY = 'pf_lock_cred';
  const ACTIVE_KEY = 'pf_last_active';
  const LOCK_AFTER_MS = 5 * 60 * 1000;
  const lockSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  const lockEnabled = () => !!store.get(LOCK_KEY);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const markActive = () => store.set(ACTIVE_KEY, String(Date.now()));

  function showLock() {
    $('lock').hidden = false;
    $('lock-error').hidden = true;
    document.body.classList.add('locked');
  }

  async function unlock() {
    try {
      await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: unb64(store.get(LOCK_KEY)), transports: ['internal'] }],
        userVerification: 'required', timeout: 60000,
      } });
      $('lock').hidden = true;
      document.body.classList.remove('locked');
      markActive();
    } catch (e) {
      $('lock-error').textContent = "Face ID didn't unlock the app. Tap to try again.";
      $('lock-error').hidden = false;
    }
  }

  async function enableLock() {
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Porter Finances', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Porter Finances lock', displayName: 'Porter Finances' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
      } });
      store.set(LOCK_KEY, b64(cred.rawId));
      markActive();
      toast('Face ID lock is on', 2500);
    } catch (e) {
      toast("Face ID lock wasn't turned on.", 3000);
    }
    render();
  }

  function disableLock() {
    store.del(LOCK_KEY);
    toast('Face ID lock is off', 2500);
    render();
  }

  function lockHtml() {
    if (!lockSupported()) return '';
    const on = lockEnabled();
    return `<div class="section-label">This phone</div><div class="card"><div class="row"><div class="name">
      <div>Face ID lock</div><div class="muted small wrap">${on ? 'On · asks after 5 minutes away' : 'Off'}</div></div>
      <button class="btn-mini${on ? ' ghost' : ''}" id="${on ? 'lock-off' : 'lock-on'}">${on ? 'Turn off' : 'Turn on'}</button></div></div>`;
  }

  // ---------- Recategorize sheet ----------

  function openSheet(t, picking) {
    state.editing = t;
    state.picking = !!picking;          // choosing a category for the review queue, not saving it
    const noteBox = $('tx-note');
    noteBox.hidden = picking || !state.data.hasNote;
    noteBox.value = t.note || '';
    state.pendingAsk = !!t.ask;
    renderExtras(t);
    $('sheet-title').textContent = t.desc;
    $('sheet-sub').textContent = `${fmt(t.amount)} · ${dayLabel(t.date)} · ${t.account}`;
    $('cat-search').value = '';
    renderCats();
    $('sheet-backdrop').hidden = false;
    $('sheet').hidden = false;
  }

  // Ask flag in the transaction panel. Like the note, it is only saved with the ✓ button
  // (or by choosing a category); Cancel throws both away.
  function renderExtras(t) {
    const canSplit = !!(t.id && t.amount && source.splitTransaction);
    const show = !state.picking && (state.data.hasAsk || canSplit);
    $('tx-extras').hidden = !show;
    if (show) {
      $('ask-row').hidden = !state.data.hasAsk;
      $('ask-toggle').textContent = state.pendingAsk ? 'Asked ✓' : 'Ask';
      $('ask-toggle').classList.toggle('on', state.pendingAsk);
      $('split-row').hidden = !canSplit;
    }
    updateSheetSave();
  }

  // ---------- Split a transaction into two categories (the same way Tiller does) ----------

  function catOptionsHtml(selected) {
    const typeRank = (c) => (/expense/i.test(c.type) ? 0 : /income/i.test(c.type) ? 1 : 2);
    const cats = state.data.categories.filter((c) => !c.hidden || c.name === selected)
      .sort((a, b) => typeRank(a) - typeRank(b) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    let html = `<option value=""${selected ? '' : ' selected'}>Choose a category</option>`, group = null;
    for (const c of cats) {
      if (c.group !== group) { if (group !== null) html += '</optgroup>'; group = c.group; html += `<optgroup label="${esc(group.trim())}">`; }
      html += `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(c.name.trim())}</option>`;
    }
    return html + (group !== null ? '</optgroup>' : '');
  }

  function openSplit(t) {
    closeSheet();
    state.splitting = t;
    $('split-title').textContent = t.desc;
    $('split-total').textContent = `${fmt(t.amount)} · ${dayLabel(t.date)} · ${t.account.trim()}`;
    $('split-amt1').value = '';
    $('split-cat1').innerHTML = catOptionsHtml(t.category);
    $('split-cat2').innerHTML = catOptionsHtml('');
    $('split-error').hidden = true;
    $('split-save').disabled = false;
    updateSplit();
    $('split-backdrop').hidden = false;
    $('split-sheet').hidden = false;
    $('split-amt1').focus();
  }

  function closeSplit() {
    state.splitting = null;
    $('split-backdrop').hidden = true;
    $('split-sheet').hidden = true;
  }

  // The second part is whatever is left of the total.
  function splitParts() {
    const t = state.splitting;
    const total = Math.round(Math.abs(t.amount) * 100);
    const a = Math.round(Number(String($('split-amt1').value).replace(/[$,\s]/g, '')) * 100);
    return { total, a, b: total - a, ok: a > 0 && a < total };
  }

  function updateSplit() {
    const { b, ok } = splitParts();
    $('split-amt2').textContent = ok ? fmt(b / 100) : '—';
  }

  async function submitSplit() {
    const t = state.splitting;
    if (!t) return;
    const { a, b, ok } = splitParts();
    const c1 = $('split-cat1').value, c2 = $('split-cat2').value;
    const err = !ok ? `Enter an amount between $0.01 and ${fmt(Math.abs(t.amount) - 0.01)} for the first part.`
      : !c1 || !c2 ? 'Choose a category for both parts.' : '';
    if (err) { $('split-error').textContent = err; $('split-error').hidden = false; return; }
    const sign = t.amount < 0 ? -1 : 1;
    $('split-save').disabled = true;
    closeSplit();
    toast('Splitting…', 0);
    try {
      await source.splitTransaction(t, [{ amount: sign * a / 100, category: c1 }, { amount: sign * b / 100, category: c2 }]);
      toast(`Split into ${c1.trim()} and ${c2.trim()}`, 3000);
    } catch (e) {
      if (e instanceof AuthError) showBanner('Your sign-in expired, so nothing was split.', 'Sign in', () => startSignIn(false));
      else toast(e.message || "Couldn't split the transaction.", 5000);
    }
    await loadData({ quiet: true });
  }

  // What the panel would change on the sheet: { Note, Ask } entries that differ from now.
  function panelChanges(t) {
    const fields = {};
    if (state.picking || !t) return fields;
    const note = $('tx-note').value.trim();
    if (state.data.hasNote && note !== (t.note || '')) fields.Note = note;
    if (state.data.hasAsk && state.pendingAsk !== !!t.ask) fields.Ask = state.pendingAsk ? 'Yes' : '';
    return fields;
  }

  function updateSheetSave() {
    $('sheet-save').hidden = !Object.keys(panelChanges(state.editing)).length;
  }

  function toggleAsk() {
    state.pendingAsk = !state.pendingAsk;
    renderExtras(state.editing);
    if (state.pendingAsk && !$('tx-note').value.trim()) $('tx-note').focus();
  }

  // Saves the panel's note and Ask changes, plus a category if one was chosen.
  async function savePanel(t, fields) {
    if (!Object.keys(fields).length) return;
    const before = { note: t.note, ask: t.ask, category: t.category };
    if ('Note' in fields) t.note = fields.Note;
    if ('Ask' in fields) t.ask = !!fields.Ask;
    if ('Category' in fields) t.category = fields.Category;
    render();
    toast('Saving…', 0);
    try {
      await source.setFields(t, fields);
      toast('Category' in fields ? `Changed to ${fields.Category}` : 'Ask' in fields ? (t.ask ? 'Question saved' : 'Question removed') : (t.note ? 'Note saved' : 'Note removed'));
    } catch (e) {
      Object.assign(t, before);
      render();
      if (e instanceof AuthError) {
        toast('');
        showBanner('Your sign-in expired, so the change wasn’t saved.', 'Sign in', () => startSignIn(false));
      } else {
        toast(e.message || "Couldn't save the change.", 4000);
      }
    }
  }

  function closeSheet() {
    state.editing = null;
    state.picking = false;
    $('sheet-backdrop').hidden = true;
    $('sheet').hidden = true;
  }

  function renderCats() {
    const q = $('cat-search').value.trim().toLowerCase();
    const cur = state.editing?.category;
    const typeRank = (c) => (/expense/i.test(c.type) ? 0 : /income/i.test(c.type) ? 1 : 2);
    const cats = state.data.categories
      .filter((c) => (!c.hidden || c.name === cur) && (!q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)))
      .sort((a, b) => typeRank(a) - typeRank(b) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    let html = '';
    let group = null;
    for (const c of cats) {
      if (c.group !== group) {
        if (group !== null) html += '</div>';
        group = c.group;
        html += `<div class="cat-group">${esc(group)}</div><div class="cat-opts">`;
      }
      const isCur = c.name === cur;
      html += `<button class="cat-opt ${isCur ? 'current' : ''}" data-cat="${esc(c.name)}"><span>${esc(c.name)}</span><span>${isCur ? '✓' : ''}</span></button>`;
    }
    if (group !== null) html += '</div>';
    $('cat-list').innerHTML = html || '<div class="empty">No matching categories.</div>';
  }

  function chooseCategory(name) {
    if (state.picking) { const t = state.editing; closeSheet(); reviewPick(t, name); return; }
    const t = state.editing;
    if (!t) return;
    const fields = panelChanges(t);
    if (name !== t.category) fields.Category = name;
    closeSheet();
    savePanel(t, fields);
  }

  function saveSheet() {
    const t = state.editing;
    if (!t) return;
    const fields = panelChanges(t);
    closeSheet();
    savePanel(t, fields);
  }

  // ---------- Small UI bits ----------

  let toastTimer;
  function toast(msg, ms = 2200) {
    clearTimeout(toastTimer);
    $('toast').textContent = msg;
    $('toast').hidden = !msg;
    if (msg && ms) toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
  }

  function showBanner(msg, label, action) {
    const b = $('banner');
    b.innerHTML = `<span>${esc(msg)}</span>`;
    if (label) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.onclick = action;
      b.appendChild(btn);
    }
    b.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; }

  function showSheetSetup(error) {
    $('app').hidden = true;
    $('signin').hidden = true;
    $('sheet-setup').hidden = false;
    $('sheet-setup-error').hidden = !error;
    $('sheet-setup-error').textContent = error || '';
  }

  async function connectSheet() {
    const id = parseSheetId($('sheet-link').value);
    if (!id) { showSheetSetup('That doesn\u2019t look like a Google Sheets link. Copy it from Share \u2192 Copy link in Google Sheets.'); return; }
    try { localStorage.setItem(SHEET_KEY, id); } catch (_) { /* ignore */ }
    $('sheet-setup').hidden = true;
    showApp();
    const result = await loadData();
    if (result === 'auth') return;   // the sign-in screen is showing; keep the sheet link
    if (!state.data) {
      try { localStorage.removeItem(SHEET_KEY); } catch (_) { /* ignore */ }
      hideBanner();
      showSheetSetup("Couldn't open that sheet. Check the link, and that this Google account has access to it.");
    }
  }

  function showSignIn(error) {
    $('app').hidden = true;
    $('signin').hidden = false;
    $('signin-error').hidden = !error;
    $('signin-error').textContent = error || '';
  }

  function showApp() {
    $('signin').hidden = true;
    $('app').hidden = false;
    render();
  }

  // ---------- Events ----------

  function bind() {
    $('signin-btn').onclick = () => {
      if (!CFG.clientId || CFG.clientId.startsWith('PASTE')) {
        showSignIn("This app isn't connected to Google yet. Finish the setup steps first.");
        return;
      }
      startSignIn(false);
    };
    $('refresh-btn').onclick = () => loadData({ quiet: true });
    $('sheet-connect').onclick = connectSheet;
    document.querySelectorAll('.tabbar button').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.tab === 'budget') { state.budgetCat = null; state.chartFull = false; }
        if (b.dataset.tab === 'connections') state.connBank = null;
        state.tab = b.dataset.tab;
        render();
        window.scrollTo(0, 0);
      };
    });

    let searchTimer;
    $('tx-search').oninput = (e) => {
      $('search-clear').hidden = !e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = e.target.value; state.limit = PAGE_SIZE; renderTx(); }, 150);
    };
    // × in the search box: empty it and show every transaction again.
    $('search-clear').onclick = () => {
      clearTimeout(searchTimer);
      $('tx-search').value = '';
      $('search-clear').hidden = true;
      $('tx-search').blur();
      state.search = '';
      state.limit = PAGE_SIZE;
      renderTx();
    };
    $('tx-account').onchange = (e) => { state.account = e.target.value; state.limit = PAGE_SIZE; renderTx(); };
    $('tx-month').onchange = (e) => {
      if (e.target.value === OLDER) { e.target.value = state.month; loadOlderHistory(); return; }
      state.month = e.target.value; state.limit = PAGE_SIZE; renderTx();
    };
    $('filter-btn').onclick = () => { state.filtersOpen = !state.filtersOpen; renderTxControls(); };
    $('tx-show').onchange = (e) => { state.show = e.target.value; state.limit = PAGE_SIZE; renderTx(); };
    $('tx-extras').onclick = (e) => {
      const t = state.editing;
      if (!t) return;
      if (e.target.closest('#ask-toggle')) toggleAsk();
      if (e.target.closest('#split-open')) openSplit(t);
    };
    $('tx-active').onclick = (e) => {
      const c = e.target.closest('[data-clear]');
      if (!c) return;
      if (c.dataset.clear === 'month') state.month = '';
      if (c.dataset.clear === 'show') state.show = '';
      if (c.dataset.clear === 'account') state.account = '';
      if (c.dataset.clear === 'sort') state.sort = 'date';
      state.limit = PAGE_SIZE;
      fillFilters();
      renderTx();
    };
    $('view-home').onclick = (e) => {
      if (e.target.closest('#goal-add')) { openGoalForm(null); return; }
      const goal = e.target.closest('[data-goal]');
      if (goal) { openGoalForm((state.data.goals || []).find((g) => String(g.row) === goal.dataset.goal)); return; }
      const row = e.target.closest('.acct-row');
      if (row) openAccount(row.dataset.acct);
    };
    $('tx-sort').onchange = (e) => { state.sort = e.target.value; state.limit = PAGE_SIZE; renderTx(); };
    $('tx-list').onclick = (e) => {
      if (e.target.closest('#show-more')) { state.limit += PAGE_SIZE; renderTx(); return; }
      if (e.target.closest('#load-older')) { loadOlderHistory(); return; }
      const btn = e.target.closest('.tx');
      if (btn) openSheet(state.data.txns[Number(btn.dataset.idx)]);
    };

    $('view-budget').onchange = (e) => {
      if (e.target.id !== 'budget-month') return;
      if (e.target.value === OLDER) { loadOlderHistory(); return; }
      state.budgetMonth = e.target.value; renderBudget();
    };
    $('view-budget').onclick = (e) => {
      if (e.target.closest('#budget-review')) { openReview(); return; }
      const rng = e.target.closest('[data-range]');
      if (rng) { state.chartRange = rng.dataset.range; renderBudget(); return; }
      if (e.target.closest('#chart-open')) { state.chartFull = true; state.chartOpen = null; renderBudget(); window.scrollTo(0, 0); return; }
      if (e.target.closest('#chart-back')) { state.chartFull = false; renderBudget(); window.scrollTo(0, 0); return; }
      const slice = e.target.closest('[data-chart-cat]');
      if (slice) {
        const name = slice.dataset.chartCat;
        state.chartOpen = state.chartOpen === name ? null : name;
        renderBudget();
        if (state.chartOpen && slice.tagName === 'circle') {
          const row = [...document.querySelectorAll('.all-cat')].find((b) => b.dataset.chartCat === name);
          if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      if (e.target.closest('#budget-back')) { state.budgetCat = null; renderBudget(); window.scrollTo(0, 0); return; }
      const item = e.target.closest('.budget-item');
      if (item) { state.budgetCat = item.dataset.cat; renderBudget(); window.scrollTo(0, 0); return; }
      const tx = e.target.closest('.tx');
      if (tx) openSheet(state.data.txns[Number(tx.dataset.idx)]);
    };

    $('view-connections').onclick = (e) => {
      if (e.target.closest('#conn-back')) { state.connBank = null; renderConnections(); window.scrollTo(0, 0); return; }
      if (e.target.closest('#dup-delete')) { deleteDuplicates(); return; }
      if (e.target.closest('#cat-fix')) { fixCategoryNames(); return; }
      if (e.target.closest('#toggle-healthy')) { state.showHealthy = !state.showHealthy; renderConnections(); return; }
      const x = e.target.closest('.alert-x');
      if (x) { removeAlertRow(x.closest('.alert-row')); return; }
      if (e.target.closest('#lock-on')) { enableLock(); return; }
      if (e.target.closest('#lock-off')) { disableLock(); return; }
      const rb = e.target.closest('[data-rule]');
      if (rb) { ruleAction(Number(rb.dataset.rule), rb.dataset.act); return; }
      const bank = e.target.closest('.conn-bank');
      if (bank) { state.connBank = bank.dataset.bank; renderConnections(); window.scrollTo(0, 0); }
    };

    $('tx-hero').onclick = (e) => { if (e.target.closest('#review-open')) openReview(); };
    $('review').onclick = (e) => {
      if (e.target.closest('#rv-done') || e.target.closest('#rv-finish')) { closeReview(); return; }
      if (e.target.closest('#rv-skip')) { if (!state.review.saving) reviewNext(); return; }
      if (e.target.closest('#rv-save')) { reviewSave(true); return; }
      if (e.target.closest('#rv-none')) { reviewSave(false); return; }
      if (e.target.closest('#rv-more')) { openSheet(state.review.list[state.review.i], true); return; }
      const chip = e.target.closest('[data-chip]');
      if (chip) { state.review.chosen = chip.dataset.chip; renderReview(); }
    };
    $('lock-btn').onclick = unlock;
    bindPullToRefresh();
    // Blur the screen in the app switcher, and ask for Face ID after 5 minutes away.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        document.body.classList.add('privacy');
        if (!document.body.classList.contains('locked')) markActive();
      } else {
        document.body.classList.remove('privacy');
        if (lockEnabled() && Date.now() - Number(store.get(ACTIVE_KEY) || 0) > LOCK_AFTER_MS) showLock();
      }
    });

    $('goal-cancel').onclick = closeGoalForm;
    $('goal-backdrop').onclick = closeGoalForm;
    $('split-backdrop').onclick = closeSplit;
    $('split-cancel').onclick = closeSplit;
    $('split-save').onclick = submitSplit;
    $('split-amt1').oninput = updateSplit;
    $('goal-save').onclick = () => submitGoal(false);
    $('goal-delete').onclick = () => submitGoal(true);

    $('sheet-close').onclick = closeSheet;
    $('sheet-save').onclick = saveSheet;
    $('tx-note').oninput = updateSheetSave;
    $('sheet-backdrop').onclick = closeSheet;
    $('cat-search').oninput = renderCats;
    $('cat-list').onclick = (e) => {
      const b = e.target.closest('.cat-opt');
      if (b) chooseCategory(b.dataset.cat);
    };

    // Refresh when you come back to the app after a while.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Home-screen apps resume without reloading, so look for a new version here.
      navigator.serviceWorker?.getRegistration?.().then((reg) => reg && reg.update()).catch(() => {});
      if (!state.data || Date.now() - state.loadedAt < STALE_MS) return;
      if (DEMO || getToken()) loadData({ quiet: true });
      else if (busy()) showBanner('Your sign-in expired.', 'Sign in', () => startSignIn(false));
      else startSignIn(true);   // quiet re-sign-in; Google asks for a tap only if it must
    });
  }

  // ---------- Start ----------

  // Something open or saving that a reload or sign-in redirect would throw away.
  const busy = () => writing > 0 || !$('sheet').hidden || !$('review').hidden || !$('goal-sheet').hidden || !$('split-sheet').hidden;

  function start() {
    bind();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      // When a new version of the app installs, reload once so it shows right away.
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        reloaded = true;
        if (busy()) showBanner('A new version of the app is ready.', 'Update', () => location.reload());
        else location.reload();
      });
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }

    if (lockEnabled() && (!DEMO || location.search.includes('lock')) &&
        Date.now() - Number(store.get(ACTIVE_KEY) || 0) > LOCK_AFTER_MS) showLock();

    if (DEMO) { showApp(); loadData(); return; }

    const result = handleRedirect();
    if (result?.error) { showSignIn(result.error); return; }
    restoreUi();
    if (getToken()) { showApp(); loadData(); return; }

    // Returning user: try a silent sign-in first (no tap needed if Google still
    // remembers you). If Google needs you to tap, show the button instead.
    const configured = CFG.clientId && !CFG.clientId.startsWith('PASTE');
    if (configured && !result?.needsTap && localStorage.getItem(RETURNING_KEY)) {
      startSignIn(true);
      return;
    }
    showSignIn();
  }

  start();
})();
