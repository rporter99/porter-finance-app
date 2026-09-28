// Made-up data used only when the app is opened with ?demo in the address,
// so the design can be previewed without touching the real sheet.
(() => {
  if (!new URLSearchParams(location.search).has('demo')) return;

  const categories = [
    ['Groceries', 'Food', 'Expense', 800], ['Dining Out', 'Food', 'Expense', 300], ['Coffee', 'Food', 'Expense', 60],
    ['Gas', 'Transportation', 'Expense', 250], ['Auto Insurance', 'Transportation', 'Expense', 140],
    ['Utilities', 'Home', 'Expense', 350], ['Mortgage', 'Home', 'Expense', 1850], ['Home Improvement', 'Home', 'Expense', 150],
    ['Shopping', 'Personal', 'Expense', 200], ['Subscriptions', 'Personal', 'Expense', 60], ['Health', 'Personal', 'Expense', 100],
    ['Charity', 'Giving', 'Expense', 150],
    ['Paycheck', 'Income', 'Income', 0], ['Credit Card Payment', 'Transfers', 'Transfer', 0], ['Transfer', 'Transfers', 'Transfer', 0],
  ].map(([name, group, type, budget]) => {
    // Same budget every month for the last 6 months, like Tiller's monthly columns.
    const budgets = {};
    for (let back = 0; back < 6; back++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back);
      budgets[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`] = budget;
    }
    return { name, group, type, hidden: false, budgets };
  });

  const accounts = [
    { id: 'a1', name: 'Joint Checking', institution: 'Chase', type: 'depository', group: 'Bank Accounts', balance: 6420.18 },
    { id: 'a2', name: 'High-Yield Savings', institution: 'Ally', type: 'depository', group: 'Bank Accounts', balance: 18900.0 },
    { id: 'a3', name: 'Visa Signature', institution: 'Chase', type: 'credit', group: 'Credit Cards', balance: -1284.55 },
    { id: 'a4', name: 'Blue Cash', institution: 'American Express', type: 'credit', group: 'Credit Cards', balance: -612.4, age: 4 },
    { id: 'a5', name: '401(k)', institution: 'Fidelity', type: 'investment', group: 'Investments', balance: 96300.0 },
    { id: 'a6', name: 'Roth IRA', institution: 'Vanguard', type: 'investment', group: 'Investments', balance: 41210.0, stale: true },
    { id: 'manual:a7', name: 'Home Value', institution: '', type: 'investment', group: 'Real Estate Value', balance: 650000.0, stale: true },
    { id: 'a8', name: 'Mortgage', institution: 'Rocket Mortgage', type: 'mortgage', group: 'Real Estate Liabilities', balance: -412300.0 },
  ].map((a) => {
    const d = new Date(); d.setDate(d.getDate() - (a.age ?? (a.stale ? 40 : 1)));
    return { ...a, number: 'xxxx' + (1000 + a.id.charCodeAt(1) * 37), liability: a.balance < 0, hidden: false, updated: d.toISOString().slice(0, 10) };
  });

  const merchants = [
    ["Trader Joe's", 'Groceries', 40, 110, 'Visa Signature'], ['Costco', 'Groceries', 90, 240, 'Visa Signature'],
    ['Safeway', 'Groceries', 25, 80, 'Blue Cash'], ['Chipotle', 'Dining Out', 14, 32, 'Blue Cash'],
    ['Olive Garden', 'Dining Out', 45, 85, 'Visa Signature'], ['Starbucks', 'Coffee', 5, 12, 'Blue Cash'],
    ['Shell', 'Gas', 38, 62, 'Blue Cash'], ['Chevron', 'Gas', 40, 65, 'Visa Signature'],
    ['Amazon', 'Shopping', 12, 90, 'Visa Signature'], ['Target', 'Shopping', 20, 75, 'Visa Signature'],
    ['Home Depot', 'Home Improvement', 15, 120, 'Visa Signature'], ['CVS Pharmacy', 'Health', 8, 40, 'Blue Cash'],
    ['Venmo payment', '', 20, 60, 'Joint Checking'],
  ];

  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const txns = [];
  for (let back = 0; back < 75; back++) {
    const d = new Date(today); d.setDate(today.getDate() - back);
    const n = Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const [desc, category, lo, hi, account] = merchants[Math.floor(rand() * merchants.length)];
      txns.push({ date: key(d), desc, category, account, amount: -Math.round((lo + rand() * (hi - lo)) * 100) / 100 });
    }
    const dom = d.getDate();
    if (dom === 1 || dom === 15) txns.push({ date: key(d), desc: 'Paycheck', category: 'Paycheck', account: 'Joint Checking', amount: 3200 });
    if (dom === 1) txns.push({ date: key(d), desc: 'Rocket Mortgage', category: 'Mortgage', account: 'Joint Checking', amount: -1850 });
    if (dom === 5) txns.push({ date: key(d), desc: 'PG&E', category: 'Utilities', account: 'Joint Checking', amount: -186.42 });
    if (dom === 9) txns.push({ date: key(d), desc: 'Netflix', category: 'Subscriptions', account: 'Visa Signature', amount: -15.49 });
    if (dom === 12) txns.push({ date: key(d), desc: 'Spotify', category: 'Subscriptions', account: 'Blue Cash', amount: -11.99 });
    if (dom === 20) txns.push({ date: key(d), desc: 'GEICO', category: 'Auto Insurance', account: 'Joint Checking', amount: -138.0 });
    if (dom === 3) txns.push({ date: key(d), desc: 'Local Food Bank', category: 'Charity', account: 'Joint Checking', amount: -100 });
    if (dom === 17) txns.push({ date: key(d), desc: 'Family Dental', category: 'Health', account: 'Visa Signature', amount: -85 });
    if (dom === 22) txns.push({ date: key(d), desc: 'Chase Card Payment', category: 'Credit Card Payment', account: 'Joint Checking', amount: -1420.0 });
  }
  const numberOf = (name) => (accounts.find((a) => a.name === name) || {}).number || '';
  txns.forEach((t, i) => { t.row = i + 2; t.id = 'demo' + i; t.fullDesc = t.desc; t.number = numberOf(t.account);
    const [y, m, d] = t.date.split('-').map(Number);
    t.added = Date.UTC(y, m - 1, d, 11, 24) / 86400000 + 25569; });
  // Made-up duplicates so the Connections screen has something to show:
  // two exact copies (safe to delete) and one copy that differs (flagged for review).
  const copy = (t, change) => ({ ...t, ...change, category: '', row: txns.length + 2 });
  txns.push(copy(txns[3], {}));
  txns.push(copy(txns[8], {}));
  txns.push(copy(txns[12], { amount: txns[12].amount - 5 }));
  // A transaction recorded under the account's old name before a reconnect (same number).
  { const d = new Date(); d.setDate(d.getDate() - 50);
    txns.push({ date: key(d), desc: 'Old-name deposit', category: 'Paycheck', account: 'OLD JOINT CHECKING', amount: 250,
      number: numberOf('Joint Checking'), row: txns.length + 2, id: 'demo-old', fullDesc: 'Old-name deposit', added: null }); }
  // Made-up category problems for the Sheet check: a near-miss name and a missing category.
  // One transaction flagged with a question for the other person.
  txns[2].ask = true; txns[2].note = 'What was this one for?';
  txns[5].category = 'groceries '; txns[6].category = 'Old Category'; txns[7].category = 'Old Category';

  const demoRules = [
    { row: 2, status: '', category: 'Groceries', keyword: "Trader Joe's", count: 14, uncategorized: 1 },
    { row: 3, status: '', category: 'Dining Out', keyword: 'Chipotle', count: 9, uncategorized: 0 },
  ];

  const demoGoals = [{ row: 2, name: 'Emergency fund', target: 25000, date: (() => { const d = new Date(); d.setMonth(d.getMonth() + 10); return key(d).slice(0, 7); })(), number: accounts[1].number }];

  window.DEMO_SOURCE = {
    async splitTransaction(t, parts) {
      await new Promise((r) => setTimeout(r, 400));
      const i = txns.indexOf(t);
      const base = t.id.replace(/^split:(.+)\[\d+\]$/, '$1');
      const n = Math.max(1, ...txns.map((x) => (/^split:(.+)\[(\d+)\]$/.exec(x.id) || [])).filter((m) => m[1] === base).map((m) => Number(m[2]))) + 1;
      const copy = { ...t, id: `split:${base}[${n}]`, amount: parts[1].amount, category: parts[1].category, note: '', ask: false };
      Object.assign(t, { id: t.id.startsWith('split:') ? t.id : `split:${base}[1]`, amount: parts[0].amount, category: parts[0].category });
      txns.splice(i + 1, 0, copy);
    },
    async setFieldBatch(field, items) {
      await new Promise((r) => setTimeout(r, 200));
      return items.length;
    },
    async saveGoal(goal) {
      await new Promise((r) => setTimeout(r, 300));
      const i = demoGoals.findIndex((g) => g.row === goal.row);
      if (goal.deleted) { if (i >= 0) demoGoals.splice(i, 1); return; }
      if (i >= 0) demoGoals[i] = goal; else demoGoals.push({ ...goal, row: demoGoals.length + 2 });
    },
    async approveRule(rule, list) {
      await new Promise((r) => setTimeout(r, 400));
      demoRules.find((r) => r.row === rule.row).status = 'Approved';
      let n = 0;
      list.forEach((t) => { if (!t.category && t.desc.toLowerCase().includes(rule.keyword.toLowerCase())) { t.category = rule.category; n++; } });
      return n;
    },
    async dismissRule(rule) {
      await new Promise((r) => setTimeout(r, 300));
      demoRules.find((r) => r.row === rule.row).status = 'Dismissed';
    },
    async load() {
      await new Promise((r) => setTimeout(r, 300));
      const now = new Date();
      const serial = (hoursAgo) => (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()) - hoursAgo * 3600000) / 86400000 + 25569;
      return {
        hasNote: true, hasReviewed: true, hasAsk: true,
        goals: demoGoals, balAgo: { a2: { d: (() => { const d = new Date(); d.setDate(d.getDate() - 95); return key(d); })(), v: 16800 } },
        accounts, categories, txns, netWorthStart: 396324,
        alerts: [
          { when: serial(2), type: 'duplicate', title: 'Removed 1 duplicate transaction', message: 'Costco $84.12. Copies are saved on the Removed Duplicates tab.' },
          { when: serial(20), type: 'bill', title: 'Netflix.com price changed', message: 'Now -$17.99, was -$15.49.' },
          { when: serial(50), type: 'connection', title: 'Vanguard stopped updating', message: 'Last update 40 days ago. Open the Tiller Console to refresh or fix it.' },
        ],
        rules: demoRules.filter((r) => !r.status),
      };
    },
    async setFields(t, fields) {
      await new Promise((r) => setTimeout(r, 300));
    },
    async fixCategories(items) {
      await new Promise((r) => setTimeout(r, 400));
      for (const it of items) { const t = txns.find((x) => x.id === it.id); if (t) t.category = it.to; }
      return items.length;
    },
    async deleteDuplicates(ids) {
      await new Promise((r) => setTimeout(r, 600));
      let removed = 0;
      for (const id of ids) {
        const copies = txns.filter((t) => t.id === id);
        for (const t of copies.slice(1)) { txns.splice(txns.indexOf(t), 1); removed++; }
      }
      return removed;
    },
  };
})();
