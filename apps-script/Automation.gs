/**
 * Porter Finances – automation for the Tiller sheet
 *
 * Paste this whole file into Extensions > Apps Script (replacing anything there),
 * choose "setup" in the toolbar, and click Run once. It then runs on its own:
 *
 *  Every hour
 *   - Duplicates: removes exact duplicate rows (same Transaction ID and identical
 *     details), after saving a copy to the "Removed Duplicates" tab. Copies that
 *     differ are only reported, never deleted.
 *   - Re-imports: when a bank is reconnected, Tiller can download weeks of old
 *     transactions again with new IDs. Copies that arrive a day or more after an
 *     identical original (same date, amount, card, description and full description)
 *     are removed, after saving a copy to "Removed Duplicates".
 *   - Possible double charges: different IDs, same account and amount, similar
 *     description, a few days apart (pending vs. posted, or a merchant charging twice).
 *   - Bank connections that stopped updating (7+ days), and the sheet not filling (2 days).
 *   - Large charges and charges from merchants you've never used.
 *   - Low balances on the accounts you choose.
 *  Every morning (7 AM)
 *   - Backs up the whole sheet to a Google Drive folder, keeping the last 14.
 *   - Bills and subscriptions: late bills, price changes, new subscriptions.
 *   - 15th and 22nd: budget pacing. Mondays: AutoCat rule suggestions and work
 *     reimbursements. First day of each quarter: update your manual accounts.
 *
 * Alerts go to your phone through Pushover (menu: Automation > Set up phone alerts),
 * or by email until Pushover is set up. Every alert is also listed on the "Alerts"
 * tab and on the Connections screen of the Finances app. Change amounts and
 * thresholds on the "Automation Settings" tab.
 */

const APP_URL = 'https://rporter99.github.io/porter-finance-app/';
const TAB = {
  tx: 'Transactions', accounts: 'Accounts', categories: 'Categories', autocat: 'AutoCat',
  settings: 'Automation Settings', alerts: 'Alerts', suggestions: 'Suggested Rules', removed: 'Removed Duplicates',
};
const BACKUP_FOLDER = 'Porter Finances Backups';

// Settings tab: [setting, default value, explanation]
const SETTINGS = [
  ['Large charge alert ($)', 500, 'Alert for any single charge at least this big.'],
  ['New merchant alert minimum ($)', 100, 'Alert for a first-ever charge from a merchant, at least this big.'],
  ['Low balance accounts', '', 'Account names from the Accounts tab, separated by commas. Leave blank to turn off.'],
  ['Low balance floor ($)', 1000, 'Alert when one of those accounts drops below this.'],
  ['Remove exact duplicates automatically', 'Yes', 'Yes or No. Removed rows are always saved to the Removed Duplicates tab.'],
  ['Remove re-imported duplicates automatically', 'Yes', 'Yes or No. Catches old transactions Tiller downloads again (with new IDs) after a bank is reconnected.'],
  ['Double charge minimum ($)', 20, 'Smaller repeat charges (like coffee) are not flagged as possible double charges.'],
  ['Budget pacing days', '15, 22', 'Days of the month to check whether categories are on pace to go over.'],
  ['Work expense category', 'Work Expense', 'Category for expenses you get paid back for.'],
  ['Work reimbursement category', 'Work Reimburse', 'Category for the payments you get back.'],
  ['Reimbursement wait (days)', 30, 'Alert when a work expense has waited this long without being paid back.'],
  ['Backups to keep', 14, 'Daily backups saved in the "' + BACKUP_FOLDER + '" folder in Google Drive.'],
  ['Quiet hours', '22 to 7', 'Alerts between these hours (24-hour clock) arrive without a sound.'],
  ['Also email alerts', 'No', 'Yes to get an email as well as the phone alert.'],
  ['Ignore accounts for connection alerts', '', 'Accounts to leave out of "stopped updating" alerts: last 4 digits (like 1234) or exact names, separated by commas.'],
];

// ---------- Menu, setup ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Automation')
    .addItem('Run all checks now', 'runAllNow')
    .addItem('Set up phone alerts (Pushover)', 'setupPushover')
    .addItem('Send a test alert', 'sendTestAlert')
    .addSeparator()
    .addItem('Turn on automation', 'setup')
    .addItem('Turn off automation', 'teardown')
    .addToUi();
}

/** Run once from the editor. Creates the settings tab and the hourly and daily schedules. */
function setup() {
  teardown();
  ensureSettingsTab_();
  ScriptApp.newTrigger('runHourly').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('runDaily').timeBased().atHour(7).everyDays(1).create();
  // Start the "new charges" watermark now, so existing history doesn't trigger alerts.
  const ctx = loadContext_();
  PropertiesService.getScriptProperties().setProperty('watermark', String(maxAdded_(ctx.txns)));
  Logger.log('Automation is on. Runs every hour, plus every morning at 7.');
}

/** Removes every schedule this script created (including the older duplicate check). */
function teardown() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
}

function runAllNow() {
  runHourly();
  runDaily();
  try { SpreadsheetApp.getUi().alert('All checks ran. Any alerts are on the Alerts tab.'); } catch (_) { /* no UI */ }
}

function setupPushover() {
  const ui = SpreadsheetApp.getUi();
  const user = ui.prompt('Phone alerts', 'Paste your Pushover User Key (from pushover.net after you sign in).\nFor more than one person, separate keys with commas.', ui.ButtonSet.OK_CANCEL);
  if (user.getSelectedButton() !== ui.Button.OK || !user.getResponseText().trim()) return;
  const token = ui.prompt('Phone alerts', 'Paste the API Token of the application you created on pushover.net.', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK || !token.getResponseText().trim()) return;
  PropertiesService.getScriptProperties().setProperties({
    pushoverUser: user.getResponseText().trim(), pushoverToken: token.getResponseText().trim(),
  });
  sendTestAlert();
}

/** Sends a test straight to Pushover and reports exactly what Pushover answered. */
function sendTestAlert() {
  const props = PropertiesService.getScriptProperties();
  const users = String(props.getProperty('pushoverUser') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const token = String(props.getProperty('pushoverToken') || '').trim();
  let report;
  if (!token || !users.length) {
    report = 'Pushover keys are not set up yet. Use Automation > Set up phone alerts.';
  } else {
    report = users.map((user, i) => {
      const res = UrlFetchApp.fetch('https://api.pushover.net/1/messages.json', {
        method: 'post', muteHttpExceptions: true,
        payload: { token, user, title: 'Finances: alerts are working', message: 'You will get alerts like this when something needs your attention.', url: APP_URL, url_title: 'Open Finances' },
      });
      let body = {};
      try { body = JSON.parse(res.getContentText()); } catch (_) { /* not JSON */ }
      const who = users.length > 1 ? `User key ${i + 1}: ` : '';
      if (res.getResponseCode() === 200 && body.status === 1) return who + 'Pushover accepted the test alert. If it does not appear on your phone, open the Pushover app and check that this phone is logged in and notifications are allowed.';
      return who + 'Pushover said: ' + ((body.errors || []).join(' ') || res.getContentText().slice(0, 300));
    }).join('\n\n');
  }
  try { SpreadsheetApp.getUi().alert(report); } catch (_) { Logger.log(report); }
}

// ---------- Scheduled jobs ----------

function runHourly() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ctx = loadContext_();
    safely_('Duplicates', () => checkDuplicates_(ctx));
    // Duplicate cleanup changes the sheet, so reload before each following check.
    safely_('Re-imports', () => checkReimports_(loadContext_()));
    const fresh = loadContext_();
    safely_('Double charges', () => checkNearDuplicates_(fresh));
    safely_('Connections', () => checkConnections_(fresh));
    safely_('Sheet filling', () => checkFill_(fresh));
    safely_('New charges', () => checkNewCharges_(fresh));
    safely_('Low balances', () => checkLowBalances_(fresh));
  } finally {
    lock.releaseLock();
  }
}

function runDaily() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    safely_('Backup', () => backupSpreadsheet_());
    const ctx = loadContext_();
    const day = Number(ctx.today.slice(8, 10));
    const monday = new Date().getDay() === 1;
    safely_('Bills', () => checkBills_(ctx));
    if (listNumbers_(ctx.settings['Budget pacing days']).includes(day)) safely_('Budget pacing', () => checkPacing_(ctx));
    if (monday) safely_('Rule suggestions', () => refreshRuleSuggestions_(ctx));
    if (monday) safely_('Reimbursements', () => checkReimbursements_(ctx));
    if (day === 1 && ['01', '04', '07', '10'].includes(ctx.today.slice(5, 7))) safely_('Manual accounts', () => remindManualAccounts_(ctx));
  } finally {
    lock.releaseLock();
  }
}

function safely_(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(name + ': ' + (e && e.stack || e));
    notify_('error:' + name + ':' + todayKey_(), 'error', 'Automation problem: ' + name, String(e && e.message || e));
  }
}

// ---------- Checks ----------

function checkDuplicates_(ctx) {
  const { safe, review } = findDuplicates(ctx.txns);
  review.forEach((g) => {
    const t = g.copies[0];
    notify_('dupreview:' + g.id, 'duplicate', 'Duplicate needs a look',
      `${t.desc} ${money_(t.amount)} on ${day_(t.date)} (${t.account.trim()}) has ${g.copies.length} copies that differ. Check them on the Transactions tab.`);
  });
  if (!safe.length) return;
  if (!yes_(ctx.settings['Remove exact duplicates automatically'])) {
    safe.forEach((g) => notify_('dup:' + g.id, 'duplicate', 'Duplicate transaction',
      `${g.keep.desc} ${money_(g.keep.amount)} on ${day_(g.keep.date)} appears ${g.copies.length} times. Remove it on the Connections tab.`));
    return;
  }
  const removed = removeRows_(ctx, safe.flatMap((g) => g.remove));
  if (removed) {
    const names = safe.slice(0, 5).map((g) => `${g.keep.desc} ${money_(g.keep.amount)}`).join(', ');
    notify_(null, 'duplicate', `Removed ${removed} duplicate transaction${removed === 1 ? '' : 's'}`,
      `${names}${safe.length > 5 ? ', …' : ''}. Copies are saved on the Removed Duplicates tab.`);
  }
}

/** Saves full copies of the rows to "Removed Duplicates", then deletes them bottom-up,
 *  re-checking each row's Transaction ID right before deleting it. Returns how many were removed. */
function removeRows_(ctx, list) {
  if (!list.length) return 0;
  const targets = list.slice().sort((a, b) => b.row - a.row);
  const sheet = ctx.txSheet;
  const width = ctx.txHead.length;
  const idCol = ctx.col.id + 1;
  const log = ensureTab_(TAB.removed, ['Removed on'].concat(ctx.txHead));
  const stamp = Utilities.formatDate(new Date(), ctx.tz, 'yyyy-MM-dd HH:mm');
  const rows = targets.map((t) => [stamp].concat(sheet.getRange(t.row, 1, 1, width).getDisplayValues()[0]));
  log.getRange(log.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  let removed = 0;
  targets.forEach((t) => {
    if (String(sheet.getRange(t.row, idCol).getValue()) !== t.id) return;
    sheet.deleteRow(t.row);
    removed++;
  });
  return removed;
}

function checkReimports_(ctx) {
  const found = findReimports(ctx.txns, 3);
  if (!found.length) return;
  const total = found.reduce((s, t) => s + t.amount, 0);
  const span = found.map((t) => t.date).sort();
  const range = span[0] === span[span.length - 1] ? day_(span[0]) : `${day_(span[0])} – ${day_(span[span.length - 1])}`;
  if (!yes_(ctx.settings['Remove re-imported duplicates automatically'])) {
    notify_('reimport:' + found.map((t) => t.id).sort().join('').slice(0, 60), 'duplicate',
      `${found.length} re-imported duplicate${found.length === 1 ? '' : 's'} found`,
      `Old transactions (${range}, ${money_(total)}) came in again with new IDs, probably after a bank reconnect. ` +
      'Turn on "Remove re-imported duplicates automatically" on the Automation Settings tab, or remove them in the sheet.');
    return;
  }
  const removed = removeRows_(ctx, found);
  if (removed) {
    const cards = [...new Set(found.map((t) => t.account.trim()))].join(', ');
    notify_(null, 'duplicate', `Removed ${removed} re-imported duplicate${removed === 1 ? '' : 's'}`,
      `${cards}: ${range}, ${money_(total)} that would have been counted twice. Originals kept; copies saved on the Removed Duplicates tab.`);
  }
}

function checkNearDuplicates_(ctx) {
  const min = num_(ctx.settings['Double charge minimum ($)'], 20);
  findNearDuplicates(ctx.txns, ctx.today, min).forEach((p) => {
    notify_('near:' + [p.a.id, p.b.id].sort().join('|'), 'double-charge', 'Possible double charge',
      `${p.a.desc} ${money_(p.a.amount)} ${p.a.date === p.b.date ? 'twice on ' + day_(p.a.date) : 'on ' + day_(p.a.date) + ' and ' + day_(p.b.date)} (${p.a.account.trim()}). ` +
      'This can be a pending charge that posted again, or a merchant charging twice.');
  });
}

function checkConnections_(ctx) {
  connectionProblems(ctx.accounts, ctx.today, ignoreList_(ctx.settings['Ignore accounts for connection alerts'])).forEach((b) => {
    notify_('conn:' + b.name, 'connection', `${b.name} stopped updating`,
      `Last update ${b.days} days ago. Open the Tiller Console to refresh or fix it.`, { repeatDays: 3 });
  });
}

function checkFill_(ctx) {
  const last = maxAdded_(ctx.txns);
  if (!last) return;
  const hours = (Date.now() - last) / 3600000;
  if (hours >= 48) {
    notify_('fill', 'fill', 'No new transactions in 2 days',
      'Your sheet hasn\'t received new transactions since ' +
      Utilities.formatDate(new Date(last), ctx.tz, 'EEE MMM d, h:mm a') + '. Check that Tiller AutoFill is on.', { repeatDays: 2 });
  }
}

function checkNewCharges_(ctx) {
  const props = PropertiesService.getScriptProperties();
  const mark = Number(props.getProperty('watermark') || 0);
  const newest = maxAdded_(ctx.txns);
  if (!mark) { props.setProperty('watermark', String(newest)); return; }
  const found = newChargeAlerts(ctx.txns, mark, {
    large: num_(ctx.settings['Large charge alert ($)'], 500),
    newMin: num_(ctx.settings['New merchant alert minimum ($)'], 100),
    catTypes: ctx.catTypes,
    recurring: new Set(findRecurring(ctx.txns, ctx.today, ctx.catTypes).map((r) => r.key)),
  });
  found.large.forEach((t) => notify_('large:' + t.id, 'large-charge', `Large charge: ${money_(t.amount)}`,
    `${t.desc} on ${day_(t.date)} (${t.account.trim()}).`));
  found.newMerchant.forEach((t) => notify_('newm:' + t.id, 'new-merchant', `New merchant: ${t.desc}`,
    `${money_(t.amount)} on ${day_(t.date)} (${t.account.trim()}). First time this merchant has charged you.`));
  if (newest > mark) props.setProperty('watermark', String(newest));
}

function checkLowBalances_(ctx) {
  const names = String(ctx.settings['Low balance accounts'] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return;
  const floor = num_(ctx.settings['Low balance floor ($)'], 1000);
  const props = PropertiesService.getScriptProperties();
  const low = JSON.parse(props.getProperty('lowBalance') || '{}');
  ctx.accounts.filter((a) => !a.hidden && names.includes(a.name.trim().toLowerCase())).forEach((a) => {
    if (a.balance < floor && !low[a.id]) {
      low[a.id] = true;
      notify_(null, 'low-balance', `Low balance: ${a.name.trim()}`, `Balance is ${money_(a.balance)}, below your ${money_(floor)} floor.`);
    } else if (a.balance >= floor + 50) {
      delete low[a.id];
    }
  });
  props.setProperty('lowBalance', JSON.stringify(low));
}

function checkBills_(ctx) {
  const month = ctx.today.slice(0, 7);
  billAlerts(ctx.txns, ctx.today, ctx.catTypes).forEach((a) => {
    if (a.kind === 'late') {
      notify_('late:' + a.bill.key + ':' + month, 'bill', `${a.bill.name} hasn't posted yet`,
        `It usually posts around the ${ordinal_(a.bill.day)} (last time ${money_(a.bill.lastAmount)}). ` +
        'Check that it was paid, or refresh the account in Tiller.');
    } else if (a.kind === 'price') {
      notify_('price:' + a.bill.key + ':' + a.bill.lastId, 'bill', `${a.bill.name} price changed`,
        `Now ${money_(a.bill.lastAmount)}, was ${money_(a.previous)}.`);
    } else if (a.kind === 'new') {
      notify_('newsub:' + a.bill.key, 'bill', `New recurring charge: ${a.bill.name}`,
        `${money_(a.bill.lastAmount)} a month, charged ${a.bill.months} months in a row (${a.bill.account.trim()}).`);
    }
  });
}

function checkPacing_(ctx) {
  const recurring = new Set(findRecurring(ctx.txns, ctx.today, ctx.catTypes).map((r) => r.key));
  const res = budgetPacing(ctx.txns, ctx.categories, ctx.today, recurring);
  if (!res.onPace.length && !res.over.length) return;
  const lines = res.onPace.slice(0, 5).map((c) => `${c.name.trim()}: heading for ${money_(c.projected)} of ${money_(c.budget)}`)
    .concat(res.over.slice(0, 5).map((c) => `${c.name.trim()}: already ${money_(c.spent - c.budget)} over`));
  notify_('pace:' + ctx.today, 'budget', 'Budget check', lines.join('\n'));
}

function checkReimbursements_(ctx) {
  const res = reimbursementsOutstanding(ctx.txns, ctx.settings['Work expense category'], ctx.settings['Work reimbursement category'],
    ctx.today, num_(ctx.settings['Reimbursement wait (days)'], 30));
  if (!res.overdue.length) return;
  const oldest = res.overdue[0];
  notify_('reimb:' + ctx.today, 'reimbursement', `${money_(res.total)} in work expenses not paid back`,
    `${res.overdue.length} expense${res.overdue.length === 1 ? '' : 's'} waiting ${ctx.settings['Reimbursement wait (days)']}+ days. ` +
    `Oldest: ${oldest.desc} ${money_(oldest.amount)} on ${day_(oldest.date)}.`);
}

function refreshRuleSuggestions_(ctx) {
  const sheet = ensureTab_(TAB.suggestions, ['Status', 'Category', 'Description Contains', 'Times Seen', 'Uncategorized Now', 'Suggested On']);
  const existing = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues() : [];
  const kept = existing.filter((r) => String(r[0]).trim());               // approved / dismissed history
  const known = new Set(existing.map((r) => String(r[2]).trim().toLowerCase()));
  const rules = ctx.autocatContains;
  const list = ruleSuggestions(ctx.txns, rules, ctx.categories, ctx.today)
    .filter((s) => !kept.some((r) => String(r[2]).trim().toLowerCase() === s.keyword.toLowerCase()));
  const pending = list.map((s) => ['', s.category, s.keyword, s.count, s.uncategorized, ctx.today]);
  const all = kept.concat(pending);
  sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 6).clearContent();
  if (all.length) sheet.getRange(2, 1, all.length, 6).setValues(all);
  const fresh = list.filter((s) => !known.has(s.keyword.toLowerCase()));
  if (fresh.length) {
    notify_('rules:' + ctx.today, 'rules', `${fresh.length} new AutoCat rule suggestion${fresh.length === 1 ? '' : 's'}`,
      fresh.slice(0, 5).map((s) => `${s.keyword} → ${s.category.trim()}`).join('\n') + '\nApprove them on the Connections tab.');
  }
}

function remindManualAccounts_(ctx) {
  const manual = ctx.accounts.filter((a) => !a.hidden && isManual(a));
  if (!manual.length) return;
  notify_('manual:' + ctx.today.slice(0, 7), 'manual', 'Time to update your manual accounts',
    manual.map((a) => `${a.name.trim()} (last updated ${a.updated ? day_(a.updated) : 'never'})`).join('\n'));
}

function backupSpreadsheet_() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const name = `${ss.getName()} backup ${Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd')}`;
  if (folder.getFilesByName(name).hasNext()) return;
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  const keep = num_(readSettings_()['Backups to keep'], 14);
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.filter((f) => f.getName().indexOf(ss.getName() + ' backup ') === 0)
    .sort((a, b) => b.getDateCreated() - a.getDateCreated())
    .slice(keep)
    .forEach((f) => f.setTrashed(true));   // moved to Drive trash, not permanently deleted
}

// ---------- Notifications ----------

/**
 * Sends an alert to the phone (Pushover) and/or email, and logs it on the Alerts tab.
 * key: alerts with the same key are sent once, or again after opts.repeatDays.
 */
function notify_(key, type, title, message, opts) {
  opts = opts || {};
  const log = ensureTab_(TAB.alerts, ['When', 'Type', 'Title', 'Message', 'Key']);
  if (key) {
    const last = lastAlertTime_(log, key);
    if (last && (!opts.repeatDays || Date.now() - last < opts.repeatDays * 86400000)) return false;
  }
  const settings = readSettings_();
  const props = PropertiesService.getScriptProperties();
  const users = String(props.getProperty('pushoverUser') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const token = props.getProperty('pushoverToken');
  const quiet = inQuietHours_(settings['Quiet hours']);
  let sent = false;
  if (token && users.length) {
    users.forEach((user) => {
      const res = UrlFetchApp.fetch('https://api.pushover.net/1/messages.json', {
        method: 'post', muteHttpExceptions: true,
        payload: {
          token, user, title: 'Finances: ' + title, message: message.slice(0, 1000),
          url: APP_URL, url_title: 'Open Finances', priority: quiet ? '-1' : '0',
        },
      });
      sent = sent || res.getResponseCode() === 200;
    });
  }
  if (!sent || yes_(settings['Also email alerts'])) {
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(), subject: 'Finances: ' + title,
      body: message + '\n\nOpen the Finances app: ' + APP_URL,
    });
    sent = true;
  }
  if (type !== 'test') {
    log.insertRowAfter(1);
    log.getRange(2, 1, 1, 5).setValues([[new Date(), type, title, message, key || '']]);
    if (log.getLastRow() > 501) log.deleteRows(502, log.getLastRow() - 501);   // keep the newest 500
  }
  return sent;
}

function lastAlertTime_(log, key) {
  const n = log.getLastRow() - 1;
  if (n < 1) return 0;
  const rows = log.getRange(2, 1, n, 5).getValues();
  for (const r of rows) if (r[4] === key) return new Date(r[0]).getTime();
  return 0;
}

function inQuietHours_(spec) {
  const m = /(\d+)\D+(\d+)/.exec(String(spec || ''));
  if (!m) return false;
  const h = Number(Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'H'));
  const from = Number(m[1]), to = Number(m[2]);
  return from > to ? (h >= from || h < to) : (h >= from && h < to);
}

// ---------- Reading the sheet ----------

function loadContext_() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const txSheet = ss.getSheetByName(TAB.tx);
  const values = txSheet.getDataRange().getValues();
  const head = values[0].map(String);
  const col = {
    id: head.indexOf('Transaction ID'), date: head.indexOf('Date'), desc: head.indexOf('Description'),
    full: head.indexOf('Full Description'), amount: head.indexOf('Amount'), account: head.indexOf('Account'),
    category: head.indexOf('Category'), added: head.indexOf('Date Added'), note: head.indexOf('Note'),
    number: head.indexOf('Account #'),
  };
  const key = (d) => (d instanceof Date ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : '');
  const txns = [];
  for (let r = 1; r < values.length; r++) {
    const v = values[r];
    const date = key(v[col.date]);
    const amount = Number(v[col.amount]);
    if (!date || !isFinite(amount) || v[col.amount] === '') continue;
    txns.push({
      row: r + 1,
      id: col.id < 0 ? '' : String(v[col.id] || ''),
      date, amount,
      desc: String(v[col.desc] || ''),
      fullDesc: col.full < 0 ? '' : String(v[col.full] || ''),
      account: String(v[col.account] || ''),
      number: col.number < 0 ? '' : String(v[col.number] || ''),
      category: String(v[col.category] || ''),
      note: col.note < 0 ? '' : String(v[col.note] || ''),
      added: col.added >= 0 && v[col.added] instanceof Date ? v[col.added].getTime() : null,
    });
  }

  // Categories, with each month's budget ("Sep 2026" columns).
  const cv = ss.getSheetByName(TAB.categories).getDataRange().getValues();
  const ch = cv[0].map(String);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthCols = [];
  cv[0].forEach((h, i) => {
    let k = '';
    if (h instanceof Date) k = Utilities.formatDate(h, tz, 'yyyy-MM');
    else {
      const m = /^([A-Za-z]{3})\w*\s+(\d{4})$/.exec(String(h).trim());
      const mi = m ? MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase()) : -1;
      if (mi >= 0) k = m[2] + '-' + String(mi + 1).padStart(2, '0');
    }
    if (k) monthCols.push({ k, i });
  });
  const ci = (n) => ch.indexOf(n);
  const categories = [];
  const catTypes = {};
  for (let r = 1; r < cv.length; r++) {
    const name = String(cv[r][ci('Category')] || '');
    if (!name.trim()) continue;
    const budgets = {};
    monthCols.forEach((m) => { budgets[m.k] = Math.abs(Number(cv[r][m.i]) || 0); });
    const c = {
      name, type: String(cv[r][ci('Type')] || '').trim(), group: String(cv[r][ci('Group')] || '').trim(),
      hidden: /^(hide|true|yes|x)$/i.test(String(cv[r][ci('Hide From Reports')] || '').trim()), budgets,
    };
    categories.push(c);
    catTypes[name] = c.type;
  }

  // Accounts: Tiller's list on the right-hand side of the Accounts tab.
  const av = ss.getSheetByName(TAB.accounts).getDataRange().getValues();
  const ah = av[0].map(String);
  const R = (n) => ah.lastIndexOf(n);
  const accounts = [];
  for (let r = 1; r < av.length; r++) {
    const a = av[r];
    const name = String(a[R('Account')] || '');
    if (!name.trim()) continue;
    const cls = String(a[R('Class')] || '');
    const type = String(a[R('Type')] || '').toLowerCase();
    const liability = /liab/i.test(cls) || (!cls && /credit|loan|mortgage/.test(type));
    const raw = Number(a[R('Last Balance')]) || 0;
    accounts.push({
      id: String(a[R('Account Id')] || ''), name,
      number: String(a[R('Account #')] || '').trim(), institution: String(a[R('Institution')] || '').trim(),
      hidden: /^(hide|true|yes|x)$/i.test(String(a[R('Hide')] || '').trim()),
      balance: liability ? -Math.abs(raw) : raw,
      updated: key(a[R('Last Update')]),
    });
  }

  // AutoCat "Description Contains" values, to avoid suggesting rules that already exist.
  const autoSheet = ss.getSheetByName(TAB.autocat);
  let autocatContains = [];
  if (autoSheet) {
    const av2 = autoSheet.getDataRange().getValues();
    const di = av2[0].map(String).indexOf('Description Contains');
    if (di >= 0) autocatContains = av2.slice(1).map((r) => String(r[di] || '').trim().toLowerCase()).filter(Boolean);
  }

  return {
    ss, tz, txSheet, txHead: head, col, txns, categories, catTypes, accounts, autocatContains,
    settings: readSettings_(), today: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
  };
}

function readSettings_() {
  const out = {};
  SETTINGS.forEach((s) => { out[s[0]] = s[1]; });
  const sheet = SpreadsheetApp.getActive().getSheetByName(TAB.settings);
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach((r) => {
    if (String(r[0]).trim() in out && String(r[1]).trim() !== '') out[String(r[0]).trim()] = r[1];
    else if (String(r[0]).trim() in out) out[String(r[0]).trim()] = '';
  });
  return out;
}

function ensureSettingsTab_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TAB.settings);
  if (!sheet) {
    sheet = ss.insertSheet(TAB.settings);
    sheet.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What it does']]).setFontWeight('bold');
  }
  const have = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map((r) => String(r[0]).trim()) : [];
  const missing = SETTINGS.filter((s) => !have.includes(s[0]));
  if (missing.length) {
    const start = sheet.getLastRow() + 1;
    sheet.getRange(start, 2, missing.length, 1).setNumberFormat('@');   // keep values as typed (no date guessing)
    sheet.getRange(start, 1, missing.length, 3).setValues(missing.map((r) => [r[0], String(r[1]), r[2]]));
  }
  sheet.setColumnWidth(1, 280); sheet.setColumnWidth(2, 220); sheet.setColumnWidth(3, 520);
}

function ensureTab_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ---------- Small helpers ----------

const money_ = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const yes_ = (v) => /^(yes|y|true|on)$/i.test(String(v).trim());
const num_ = (v, d) => (isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
const ignoreList_ = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const listNumbers_ = (v) => String(v).split(/[^\d]+/).filter(Boolean).map(Number);
const todayKey_ = () => Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
const maxAdded_ = (txns) => txns.reduce((m, t) => (t.added && t.added > m ? t.added : m), 0);
/** '2026-09-16' -> 'Sep 16' */
function day_(key) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m[Number(key.slice(5, 7)) - 1] + ' ' + Number(key.slice(8, 10));
}
function ordinal_(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// =====================================================================
// Pure logic below: plain data in, plain data out. Tested on the Mac.
// Dates are 'YYYY-MM-DD' strings; amounts are negative for charges.
// =====================================================================

function dayNum(key) { const p = key.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000; }
function daysBetween(a, b) { return Math.round(dayNum(b) - dayNum(a)); }
function addMonths(ym, n) { const p = ym.split('-').map(Number); const d = new Date(Date.UTC(p[0], p[1] - 1 + n, 1)); return d.toISOString().slice(0, 7); }
function daysInMonth(ym) { const p = ym.split('-').map(Number); return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate(); }

/** Merchant name without store numbers, card digits or punctuation. */
function merchantKey(desc) {
  return String(desc).toLowerCase()
    .replace(/[#*]/g, ' ')
    .split(/\s+/).filter((w) => w && !/\d/.test(w)).join(' ')
    .replace(/[^a-z0-9&' ]/g, '').replace(/\s+/g, ' ').trim();
}

function isManual(a) { return a.id.indexOf('manual:') === 0 || (!a.institution && !a.number); }

/** Same rules as the app: exact copies are safe; anything that differs (including two different notes) goes to review. */
function findDuplicates(txns) {
  const byId = new Map();
  txns.forEach((t) => {
    if (!t.id) return;
    if (!byId.has(t.id)) byId.set(t.id, []);
    byId.get(t.id).push(t);
  });
  const same = (a, b) => a.date === b.date && a.amount === b.amount && a.account === b.account &&
    a.desc === b.desc && a.fullDesc === b.fullDesc;
  const safe = [], review = [];
  byId.forEach((copies, id) => {
    if (copies.length < 2) return;
    const cats = new Set(copies.map((t) => t.category).filter(Boolean));
    const notes = new Set(copies.map((t) => t.note || '').filter(Boolean));
    const identical = cats.size <= 1 && notes.size <= 1 && copies.every((t) => same(t, copies[0]));
    const keep = copies.slice().sort((a, b) =>
      (b.category ? 1 : 0) - (a.category ? 1 : 0) ||
      (b.note ? 1 : 0) - (a.note ? 1 : 0) ||
      ((a.added == null ? Infinity : a.added) - (b.added == null ? Infinity : b.added)) ||
      b.row - a.row)[0];
    (identical ? safe : review).push({ id, keep, remove: copies.filter((t) => t !== keep), copies });
  });
  return { safe, review };
}

/**
 * Re-imported copies: after a bank reconnect Tiller can download old transactions again
 * with new IDs. Within a group of identical transactions (same date, amount, card,
 * description and full description, all with different IDs), copies that arrived a day
 * or more after the first copy, for a transaction already at least minAgeDays old when
 * they arrived, are re-imports. Never more are flagged than there were originals, so
 * genuine repeat purchases survive; copies carrying a note are left alone.
 */
function findReimports(txns, minAgeDays) {
  const DAY = 86400000;
  const groups = new Map();
  txns.forEach((t) => {
    if (!t.id || t.added == null) return;
    const k = [t.date, t.amount.toFixed(2), t.number || t.account, t.desc, t.fullDesc].join('\u0001');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  const out = [];
  groups.forEach((list) => {
    if (list.length < 2 || new Set(list.map((t) => t.id)).size !== list.length) return;   // same-ID copies are handled elsewhere
    list.sort((a, b) => a.added - b.added);
    const first = list[0].added;
    const originals = list.filter((t) => t.added - first < DAY);
    const p = list[0].date.split('-').map(Number);
    const txDay = Date.UTC(p[0], p[1] - 1, p[2]);
    const later = list.filter((t) => t.added - first >= DAY && (t.added - txDay) / DAY >= minAgeDays && !t.note);
    const n = Math.min(later.length, originals.length);
    out.push(...later.slice(later.length - n));
  });
  return out;
}

/** Charges with different IDs that look like the same purchase twice (last 30 days). */
function findNearDuplicates(txns, today, minAmount) {
  const recent = txns.filter((t) => t.amount < 0 && Math.abs(t.amount) >= minAmount && t.id && daysBetween(t.date, today) <= 30);
  const groups = new Map();
  recent.forEach((t) => {
    const k = t.account + '|' + t.amount.toFixed(2) + '|' + merchantKey(t.desc);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  const pairs = [];
  groups.forEach((list) => {
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a.id !== b.id && daysBetween(a.date, b.date) <= 3) pairs.push({ a, b });
    }
  });
  return pairs;
}

/** Matches an account against an ignore list of last-4 digits or exact names. */
function isIgnored(a, ignore) {
  const digits = String(a.number || '').replace(/\D/g, '');
  const name = a.name.trim().toLowerCase();
  return (ignore || []).some((x) => (/^\d{3,}$/.test(x) ? digits.endsWith(x) : name === x));
}

/** Banks whose stalest account hasn't updated in 7+ days (only accounts shown on Balances). */
function connectionProblems(accounts, today, ignore) {
  const banks = new Map();
  accounts.filter((a) => !a.hidden && !isManual(a) && !isIgnored(a, ignore)).forEach((a) => {
    const name = a.institution || a.name.trim();
    const days = a.updated ? daysBetween(a.updated, today) : 9999;
    banks.set(name, Math.max(banks.get(name) || 0, days));
  });
  const out = [];
  banks.forEach((days, name) => { if (days >= 7) out.push({ name, days }); });
  return out;
}

const SKIP_TYPES = /^(transfer|income)$/i;

/**
 * Monthly bills and subscriptions: a merchant charged at most twice a month,
 * in at least 3 of the last 4 complete months (or 2 in a row for new ones).
 */
function findRecurring(txns, today, catTypes) {
  const thisMonth = today.slice(0, 7);
  const byKey = new Map();
  txns.forEach((t) => {
    if (t.amount >= 0) return;
    if (t.category && SKIP_TYPES.test(catTypes[t.category] || '')) return;
    if (daysBetween(t.date, today) > 400) return;
    const k = merchantKey(t.desc);
    if (k.length < 3) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  });
  const out = [];
  byKey.forEach((list, k) => {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const perMonth = new Map();
    list.forEach((t) => { const m = t.date.slice(0, 7); perMonth.set(m, (perMonth.get(m) || 0) + 1); });
    if ([...perMonth.values()].some((n) => n > 2)) return;              // shops you visit often, not bills
    const last4 = [1, 2, 3, 4].map((n) => addMonths(thisMonth, -n));
    const hits = last4.filter((m) => perMonth.has(m)).length;
    const last = list[list.length - 1];
    const recentDays = list.slice(-3).map((t) => Number(t.date.slice(8, 10))).sort((a, b) => a - b);
    const bill = {
      key: k, name: last.desc, account: last.account, lastAmount: last.amount, lastId: last.id, lastDate: last.date,
      day: recentDays[Math.floor(recentDays.length / 2)], amounts: list.map((t) => t.amount),
      months: perMonth.size, firstDate: list[0].date, perMonth,
    };
    if (hits >= 3) out.push(Object.assign(bill, { established: true }));
    else if (perMonth.size === 2 && list.length === 2 && addMonths(list[0].date.slice(0, 7), 1) === list[1].date.slice(0, 7)) {
      out.push(Object.assign(bill, { established: false }));
    }
  });
  return out;
}

/** Late bills, price changes on fixed-price bills, and new subscriptions. */
function billAlerts(txns, today, catTypes) {
  const thisMonth = today.slice(0, 7);
  const dayToday = Number(today.slice(8, 10));
  const alerts = [];
  findRecurring(txns, today, catTypes).forEach((b) => {
    if (b.established) {
      const paidThisMonth = b.perMonth.has(thisMonth);
      const activeLastMonth = b.perMonth.has(addMonths(thisMonth, -1));
      if (!paidThisMonth && activeLastMonth && b.day + 5 < dayToday && b.day + 5 <= daysInMonth(thisMonth)) {
        alerts.push({ kind: 'late', bill: b });
      }
      const a = b.amounts;
      if (a.length >= 4 && daysBetween(b.lastDate, today) <= 10) {
        const prev = a.slice(-4, -1);
        const stable = Math.max.apply(null, prev) - Math.min.apply(null, prev) <= 0.5;
        const was = prev[prev.length - 1];
        const diff = Math.abs(b.lastAmount - was);
        if (stable && diff > Math.max(1, Math.abs(was) * 0.03)) alerts.push({ kind: 'price', bill: b, previous: was });
      }
    } else if (daysBetween(b.firstDate, today) <= 70 && daysBetween(b.lastDate, today) <= 10) {
      const [x, y] = b.amounts;
      const d1 = Number(b.firstDate.slice(8, 10)), d2 = Number(b.lastDate.slice(8, 10));
      if (Math.abs(x - y) <= Math.abs(x) * 0.05 && Math.abs(d1 - d2) <= 4) alerts.push({ kind: 'new', bill: b });
    }
  });
  return alerts;
}

/** New charges since the watermark: large ones, and first-ever merchants. */
function newChargeAlerts(txns, watermark, opts) {
  const seenBefore = new Set();
  const fresh = [];
  txns.forEach((t) => {
    if (t.added != null && t.added > watermark) fresh.push(t);
    else seenBefore.add(merchantKey(t.desc));
  });
  const payment = /\b(payment|autopay|transfer|xfer|pmt)\b/i;
  const large = [], newMerchant = [];
  fresh.forEach((t) => {
    if (t.amount >= 0) return;
    if (t.category && SKIP_TYPES.test(opts.catTypes[t.category] || '')) return;
    if (!t.category && payment.test(t.desc)) return;
    const k = merchantKey(t.desc);
    const known = seenBefore.has(k);
    seenBefore.add(k);
    if (opts.recurring.has(k)) return;                  // regular bills are expected
    if (Math.abs(t.amount) >= opts.large) large.push(t);
    else if (Math.abs(t.amount) >= opts.newMin && k && !known) newMerchant.push(t);
  });
  return { large, newMerchant };
}

/**
 * Categories on pace to go over this month. Bills (recurring charges) count as-is;
 * everything else is projected from the pace so far.
 */
function budgetPacing(txns, categories, today, recurringKeys) {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const days = daysInMonth(month);
  const onPace = [], over = [];
  categories.forEach((c) => {
    if (c.hidden || !/expense/i.test(c.type)) return;
    const budget = c.budgets[month] || 0;
    if (!budget) return;
    let fixed = 0, variable = 0;
    txns.forEach((t) => {
      if (t.category !== c.name || t.date.slice(0, 7) !== month) return;
      if (recurringKeys.has(merchantKey(t.desc))) fixed -= t.amount; else variable -= t.amount;
    });
    const spent = fixed + variable;
    const projected = fixed + Math.max(variable, 0) / day * days;
    if (spent >= budget + 10) over.push({ name: c.name, budget, spent });
    else if (projected >= budget + 10) onPace.push({ name: c.name, budget, spent, projected });
  });
  onPace.sort((a, b) => (b.projected - b.budget) - (a.projected - a.budget));
  over.sort((a, b) => (b.spent - b.budget) - (a.spent - a.budget));
  return { onPace, over };
}

/** Work expenses (last 12 months) not yet covered by reimbursements, oldest first. */
function reimbursementsOutstanding(txns, expenseCat, reimbCat, today, waitDays) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const exp = norm(expenseCat), reimb = norm(reimbCat);
  if (!exp) return { overdue: [], total: 0 };
  const recent = txns.filter((t) => daysBetween(t.date, today) <= 365);
  let credit = recent.filter((t) => t.amount > 0 && (norm(t.category) === reimb || norm(t.category) === exp))
    .reduce((s, t) => s + t.amount, 0);
  const expenses = recent.filter((t) => t.amount < 0 && norm(t.category) === exp).sort((a, b) => a.date.localeCompare(b.date));
  const open = [];
  expenses.forEach((t) => {
    const cost = -t.amount;
    if (credit >= cost - 0.005) credit -= cost; else { open.push(Object.assign({}, t, { owed: cost - Math.max(credit, 0) })); credit = 0; }
  });
  const overdue = open.filter((t) => daysBetween(t.date, today) >= waitDays);
  return { overdue, total: open.reduce((s, t) => s + t.owed, 0) };
}

/**
 * AutoCat rules worth adding: a merchant seen 3+ times in the last year, always
 * given the same budget category, and not already covered by an AutoCat rule.
 */
function ruleSuggestions(txns, autocatContains, categories, today) {
  const valid = new Set(categories.map((c) => c.name));
  const byKey = new Map();
  txns.forEach((t) => {
    if (daysBetween(t.date, today) > 365) return;
    const k = merchantKey(t.desc);
    if (k.length < 3) return;
    if (!byKey.has(k)) byKey.set(k, { cats: new Map(), uncategorized: 0, sample: t.desc });
    const g = byKey.get(k);
    if (t.category) g.cats.set(t.category, (g.cats.get(t.category) || 0) + 1);
    else g.uncategorized++;
  });
  const out = [];
  byKey.forEach((g, k) => {
    if (g.cats.size !== 1) return;
    const [category, count] = [...g.cats][0];
    if (count < 3 || !valid.has(category)) return;
    if (autocatContains.some((r) => k.indexOf(r) >= 0 || String(g.sample).toLowerCase().indexOf(r) >= 0)) return;
    // Use the merchant words as they appear in the description, e.g. "Shell Oil".
    const words = String(g.sample).split(/\s+/).filter((w) => w && !/\d/.test(w) && !/^[#*]+$/.test(w));
    const keyword = words.join(' ').replace(/[#*]+$/, '').trim();
    if (keyword.length < 3) return;
    out.push({ keyword, category, count, uncategorized: g.uncategorized });
  });
  return out.sort((a, b) => b.count - a.count).slice(0, 20);
}
