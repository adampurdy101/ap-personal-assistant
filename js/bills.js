// ============================================================
//  AP PERSONAL ASSISTANT  ·  bills.js  —  the bill ledger (data only, no DOM)
//  Tables: fm_bills (one row per bill), fm_bill_payments (one row per PAID
//  occurrence: bill_id + due_date), fm_accounts (what a bill pays from).
//  Occurrences (the dates a bill is due) are computed here, never stored:
//    monthly  → the anchor's day every month (clamped to short months)
//    biweekly → every 14 days from the anchor
//    yearly   → the anchor's month + day every year
//    once     → the anchor date only
//  A bill applies from its anchor_date until ended_on (null = ongoing).
//  Every change is logged in fm_moves (kind bill_*) so Undo and "why" work.
// ============================================================

export const B = { bills: [], accounts: [], payments: [], loaded: false, error: null };

const pad = (n) => String(n).padStart(2, "0");
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();   // m is 0-based
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
export const money = (n, cents = true) => {
  const v = Number(n) || 0, r = Math.round(v * 100) / 100;
  const whole = r % 1 === 0;
  return "$" + (whole || !cents ? Math.round(r).toLocaleString("en-US") : r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
export const logoUrl = (domain) => domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : null;
export const initials = (name) => String(name || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
export const cleanDomain = (v) => String(v || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();

// ---------- load ----------
export async function loadBills(db) {
  const since = isoOf(addDays(new Date(), -400));
  const [b, a, p] = await Promise.all([
    db.from("fm_bills").select("*").is("deleted_at", null).order("sort").order("id"),
    db.from("fm_accounts").select("*").order("sort").order("id"),
    db.from("fm_bill_payments").select("*").gte("due_date", since),
  ]);
  if (b.error || a.error || p.error) { B.error = (b.error || a.error || p.error).message; return false; }
  B.bills = (b.data || []).map((r) => ({ ...r, amount: Number(r.amount) }));
  B.accounts = a.data || [];
  B.payments = p.data || [];
  B.loaded = true; B.error = null;
  return true;
}

// ---------- accounts ----------
export const acctById = (id) => (id == null ? null : B.accounts.find((a) => a.id === id) || null);
export const acctLabel = (id, { full = false } = {}) => {
  const a = acctById(id); if (!a) return null;
  const digits = a.last4 ? " ••" + String(a.last4).slice(-4) : "";
  return full ? `${a.bank}${a.nick ? " · " + a.nick : ""}${digits}` : `${a.bank}${digits}`;
};

// ---------- occurrences ----------
const anchorOf = (b) => fromISO(b.anchor_date);
function applies(b, dueISO) {
  if (dueISO < b.anchor_date) return false;
  if (b.ended_on && dueISO > b.ended_on) return false;
  return true;
}
// all due dates of one bill inside a month (y, m 0-based)
export function dueDaysInMonth(b, y, m) {
  const a = anchorOf(b), out = [];
  if (b.recur === "monthly") out.push(Math.min(a.getDate(), daysIn(y, m)));
  else if (b.recur === "yearly") { if (a.getMonth() === m) out.push(Math.min(a.getDate(), daysIn(y, m))); }
  else if (b.recur === "once") { if (a.getFullYear() === y && a.getMonth() === m) out.push(a.getDate()); }
  else if (b.recur === "biweekly") {
    const n = daysIn(y, m);
    for (let d = 1; d <= n; d++) { const diff = Math.round((new Date(y, m, d) - a) / 86400000); if (diff >= 0 && diff % 14 === 0) out.push(d); }
  }
  return out.map((d) => `${y}-${pad(m + 1)}-${pad(d)}`).filter((dISO) => applies(b, dISO));
}
export function occurrencesInMonth(y, m) {
  const out = [];
  for (const b of B.bills) for (const due of dueDaysInMonth(b, y, m)) out.push({ bill: b, due });
  return out.sort((p, q) => p.due.localeCompare(q.due) || q.bill.amount - p.bill.amount);
}
export function occurrencesBetween(fromISOStr, toISOStr) {
  const out = [];
  let d = new Date(fromISO(fromISOStr).getFullYear(), fromISO(fromISOStr).getMonth(), 1);
  const end = fromISO(toISOStr);
  while (d <= end) { out.push(...occurrencesInMonth(d.getFullYear(), d.getMonth())); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  return out.filter((o) => o.due >= fromISOStr && o.due <= toISOStr);
}
export const occOn = (dISO) => occurrencesBetween(dISO, dISO);

// ---------- paid / late / soon ----------
export const paymentFor = (bill, due) => B.payments.find((p) => p.bill_id === bill.id && p.due_date === due) || null;
export const isPaid = (bill, due) => !!paymentFor(bill, due);
// paid · late · today · soon (inside the bill's remind window) · open — shape + wording in the UI, never color alone
export function statusOf(bill, due, today) {
  if (isPaid(bill, due)) return "paid";
  if (due < today) return "late";
  if (due === today) return "today";
  if (daysBetween(today, due) <= (bill.remind_days ?? 2)) return "soon";
  return "open";
}
export const daysLate = (due, today) => Math.max(0, daysBetween(due, today));

export function monthStats(y, m, today) {
  const occ = occurrencesInMonth(y, m);
  const s = { total: 0, paid: 0, left: 0, nTotal: occ.length, nPaid: 0, late: [], soon: [], open: [], paidList: [] };
  for (const o of occ) {
    s.total += o.bill.amount;
    const st = statusOf(o.bill, o.due, today);
    if (st === "paid") { s.paid += o.bill.amount; s.nPaid++; s.paidList.push(o); }
    else if (st === "late") s.late.push(o);
    else if (st === "today" || st === "soon") s.soon.push(o);
    else s.open.push(o);
  }
  s.left = s.total - s.paid;
  s.pct = s.total > 0 ? Math.round(s.paid / s.total * 100) : 0;
  return s;
}
// unpaid and past due, looking back `lookback` days (a bill missed 2 months ago still shows; older is history)
export function pastDue(today, lookback = 75) {
  const from = isoOf(addDays(fromISO(today), -lookback)), to = isoOf(addDays(fromISO(today), -1));
  return occurrencesBetween(from, to).filter((o) => !isPaid(o.bill, o.due)).sort((p, q) => p.due.localeCompare(q.due));
}
export function dueWithin(today, days) {
  return occurrencesBetween(today, isoOf(addDays(fromISO(today), days))).filter((o) => !isPaid(o.bill, o.due));
}
export const nextDue = (today) => dueWithin(today, 120)[0] || null;
export const amountOf = (list) => list.reduce((a, o) => a + o.bill.amount, 0);

// ---------- changes (every one logged in fm_moves, kind bill_*, so Undo and "why" work) ----------
async function log(db, kind, before, after, reason) {
  return db.from("fm_moves").insert({ batch_id: "app-" + isoOf(new Date()), kind, task_id: null, before, after, reason }).then(() => {}, () => {});
}
export async function markPaid(db, bill, due, { source = "app", note = null, amount = null } = {}) {
  if (isPaid(bill, due)) return true;
  const row = { bill_id: bill.id, due_date: due, source, note, amount };
  const { data, error } = await db.from("fm_bill_payments").insert(row).select().single();
  if (error) return error.message;
  B.payments.push(data);
  log(db, "bill_paid", { bill_id: bill.id, name: bill.name, due_date: due, paid: false }, { ...data, name: bill.name }, `Marked paid: ${bill.name} due ${due}`);
  return true;
}
export async function unmarkPaid(db, bill, due) {
  const p = paymentFor(bill, due); if (!p) return true;
  const { error } = await db.from("fm_bill_payments").delete().eq("id", p.id);
  if (error) return error.message;
  B.payments = B.payments.filter((x) => x.id !== p.id);
  log(db, "bill_unpaid", { ...p, name: bill.name }, { bill_id: bill.id, name: bill.name, due_date: due, paid: false }, `Un-marked: ${bill.name} due ${due}`);
  return true;
}
const BILL_FIELDS = ["name", "domain", "amount", "recur", "anchor_date", "account_id", "remind_days", "autopay", "notes", "photo", "sort", "ended_on"];
export async function saveBill(db, fields, id = null) {
  const row = {};
  for (const k of BILL_FIELDS) if (k in fields) row[k] = fields[k];
  if (id == null) {
    const { data, error } = await db.from("fm_bills").insert(row).select().single();
    if (error) return error.message;
    data.amount = Number(data.amount); B.bills.push(data);
    log(db, "bill_add", null, { id: data.id, name: data.name, amount: data.amount, anchor_date: data.anchor_date, recur: data.recur }, "Added a bill in the app");
    return data;
  }
  const cur = B.bills.find((b) => b.id === id); if (!cur) return "no such bill";
  const before = {}; for (const k of Object.keys(row)) before[k] = cur[k] ?? null;
  const { error } = await db.from("fm_bills").update(row).eq("id", id);
  if (error) return error.message;
  Object.assign(cur, row, { amount: Number(row.amount ?? cur.amount) });
  log(db, "bill_update", { id, name: cur.name, ...before }, { id, ...row }, "Edited a bill in the app");
  return cur;
}
// Remove = Trash (deleted_at), like tasks; payments stay so history is intact
export async function removeBill(db, bill) {
  const stamp = new Date().toISOString();
  const { error } = await db.from("fm_bills").update({ deleted_at: stamp }).eq("id", bill.id);
  if (error) return error.message;
  B.bills = B.bills.filter((b) => b.id !== bill.id);
  log(db, "bill_remove", { id: bill.id, name: bill.name, amount: bill.amount }, null, "Removed a bill in the app → Trash");
  return true;
}
export async function restoreBill(db, id) {
  const { data, error } = await db.from("fm_bills").update({ deleted_at: null }).eq("id", id).select().single();
  if (error) return error.message;
  data.amount = Number(data.amount); B.bills.push(data);
  log(db, "bill_restore", null, { id, name: data.name }, "Put a bill back from the Trash");
  return true;
}
export async function saveAccount(db, fields, id = null) {
  const row = { bank: fields.bank, nick: fields.nick || null, last4: fields.last4 || null };
  if (id == null) {
    const { data, error } = await db.from("fm_accounts").insert(row).select().single();
    if (error) return error.message;
    B.accounts.push(data); return data;
  }
  const { error } = await db.from("fm_accounts").update(row).eq("id", id);
  if (error) return error.message;
  const cur = B.accounts.find((a) => a.id === id); if (cur) Object.assign(cur, row);
  return cur;
}
export async function deleteAccount(db, id) {
  const { error } = await db.from("fm_accounts").delete().eq("id", id);
  if (error) return error.message;
  B.accounts = B.accounts.filter((a) => a.id !== id);
  B.bills.forEach((b) => { if (b.account_id === id) b.account_id = null; });
  return true;
}
