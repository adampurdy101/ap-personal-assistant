// ============================================================
//  AP PERSONAL ASSISTANT  ·  app.js
//  Panel LEFT (Quick Look · Next Up · Status · Today · Meetings · Promises · Tasks),
//  calendar RIGHT (Month / Week / Day · Work / Home / Both). Quick add (type or
//  speak), Add task, chip push arrows, "?" size/priority popover, Balance week.
//  Done stays on its day (faded, ✓) · Remove = Trash (30 days, Put back) · Undo on
//  every change (toast button, Status card, Ctrl+Z). Nothing is hard-deleted except
//  "Delete for good" inside the Trash. Unfinished items are carried forward to today
//  on every open (↻N on the chip). Click a chip → that task opens FIRST in the panel.
//  Bills ($ Bills button): bill chips on the month grid, a hover summary, Paid ✓ in one
//  click, add/edit bills and accounts, alerts before due dates — data layer in bills.js.
//  Data: Supabase fm_tasks / fm_jobs / fm_meetings / fm_moves / fm_bills / fm_bill_payments / fm_accounts.
// ============================================================
import { db } from "./supabase.js";
import { B, loadBills, occOn, statusOf, paymentFor, monthStats, pastDue, dueWithin, nextDue, amountOf, markPaid, unmarkPaid, saveBill, removeBill, restoreBill, saveAccount, deleteAccount, acctLabel, money, logoUrl, initials, cleanDomain, daysLate } from "./bills.js";
import { CONFIG } from "./config.js";
import { initAuth } from "./auth.js";

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayISO = () => iso(new Date());
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
const fmtLong = (s) => fromISO(s).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const fmtShort = (s) => fromISO(s).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ISO week number (Mon-start weeks). For a Sunday-start row use the row's Thursday.
function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y0) / 86400000 + 1) / 7);
}
const weeksInYear = (y) => isoWeek(new Date(y, 11, 28));
const rowWeek = (sunday) => isoWeek(addDays(sunday, 4));

const PRI = {
  urgent: { mark: "!!", label: "Urgent" },
  high:   { mark: "▲",  label: "High" },
  normal: { mark: "●",  label: "Normal" },
  low:    { mark: "–",  label: "Low" },
};
const PRI_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS = { not_started: "Not started", working: "Working", waiting: "Waiting on", done: "Done" };
const SIZE = { "15m": "15 min", "1h": "1 hr", half: "Half day", full: "Full day" };

// ---------- state ----------
const state = {
  bucket: localStorage.getItem("fm.bucket") || "work",   // work | home | both
  view:   localStorage.getItem("fm.view")   || "month",  // month | week | day
  cursor: new Date(),                                    // which month/week/day we're looking at
  selected: null,                                        // ISO date opened in the rail
  panel: null,                                           // 'day' | 'unscheduled' | 'tomorrow' | null
  openId: null,                                          // expanded task id
  editId: null,                                          // task in edit mode
  tasks: [],                                             // live rows (deleted_at is null) — done ones included
  trash: [],                                             // removed rows (deleted_at set); Put back brings them home
  jobs: [],
  meetings: [],                                          // PCI Outlook meetings (titles + times only)
  meetingsSync: null,
  addDraft: "",                                          // Add task panel text, kept across redraws
  addPick: null,                                         // Add task panel choices (day, priority, size, calendar)
  tab: "week",                                           // phone: week · month · add · brain
  pWeek: null,                                           // phone week screen: Sunday ISO of the week shown
  pMonth: null,                                          // phone month screen: first-of-month ISO
  billOpen: null,                                        // bill id opened first in the day panel (bills mode)
  billDraft: null,                                       // Add / Edit bill form, kept across redraws
  billEditId: null,                                      // bill being edited (null = new)
  acctDraft: null,                                       // Accounts panel form
  feedToken: null,                                       // Apple Calendar feed token (fm_prefs), loaded on demand
};
// ---------- phone: one screen at a time, bottom tabs ----------
const PHONE_MQ = window.matchMedia("(max-width: 740px), ((pointer: coarse) and (max-height: 520px))");
const isPhone = () => PHONE_MQ.matches;
PHONE_MQ.addEventListener("change", () => render({ now: true }));

// toast: a short line at the bottom. With { undo: true } it carries an ↶ Undo button
// (the last change on the undo stack) and stays up long enough to hit it.
function toast(msg, { undo: withUndo = false, ms = null } = {}) {
  const t = $("toast"); t.innerHTML = ""; t.append(el("span", "", msg));
  if (withUndo && undoStack.length) {
    const b = el("button", "btn sm undo", "↶ Undo"); b.type = "button";
    b.addEventListener("click", () => { t.classList.add("hidden"); undoLast(); });
    t.append(b);
  }
  t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms || (withUndo ? 8000 : 2400));
}

// ---------- data ----------
const TRASH_DAYS = 30;   // removed items wait this long in the Trash, then go for good
async function loadAll() {
  const from = iso(addDays(new Date(), -45)), to = iso(addDays(new Date(), 120));
  const [t, j, m, billsOk] = await Promise.all([
    db.from("fm_tasks").select("*").order("sort").order("created_at"),
    db.from("fm_jobs").select("*").eq("active", true).order("bucket").order("sort"),
    db.from("fm_meetings").select("id,title,start_at,end_at,all_day,attending,day,updated_at,source").gte("day", from).lte("day", to).order("start_at"),
    loadBills(db),
  ]);
  if (t.error) { toast("Load failed: " + t.error.message); return; }
  if (!billsOk && !loadAll._billWarned) { loadAll._billWarned = true; toast("Bills didn't load: " + (B.error || "unknown")); }
  const rows = t.data || [];
  state.tasks = rows.filter((x) => !x.deleted_at);
  state.trash = rows.filter((x) => !!x.deleted_at).sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
  state.jobs = j.data || [];
  if (!m.error) {
    state.meetings = m.data || [];
    state.meetingsSync = state.meetings.reduce((a, x) => (x.updated_at > a ? x.updated_at : a), "") || null;
  }
  purgeOldTrash();
  await carryForward();
  render();
}

// ---------- carry forward: nothing unfinished stays behind on a past day ----------
// Every open task sitting on a day before today moves to today (work → the next work day),
// counts one more slip (↻N on the chip) and remembers the day it was first due on. The
// morning plan does the same at 5:30; this makes sure it happens the moment the app opens.
async function carryForward() {
  const today = todayISO();
  const late = state.tasks.filter((t) => !isDone(t) && t.scheduled_date && t.scheduled_date < today);
  if (!late.length) return;
  const moved = [];
  for (const t of late) {
    const to = t.bucket === "work" ? landDay(today, "work") : today;
    const from = t.scheduled_date;
    const patch = { scheduled_date: to, planned: false, carried: (t.carried || 0) + 1, carried_from: t.carried_from || from };
    // only if nobody else (another window, the morning plan) moved it first
    const { data, error } = await db.from("fm_tasks").update(patch).eq("id", t.id).eq("scheduled_date", from).select("id");
    if (error || !data || !data.length) continue;
    const before = { scheduled_date: from, planned: t.planned, carried: t.carried || 0, carried_from: t.carried_from || null };
    Object.assign(t, patch);
    db.from("fm_moves").insert({ batch_id: "carry-" + today, kind: "move", task_id: t.id, before, after: patch, reason: `Carried forward — not finished on ${fmtShort(from)}`, from_date: from, to_date: to }).then(() => {}, () => {});
    moved.push(t);
  }
  if (!moved.length) return;
  const days = [...new Set(moved.map((t) => fmtShort(t.carried_from)))].slice(0, 3).join(", ");
  toast(`Carried ${moved.length} unfinished item${moved.length === 1 ? "" : "s"} forward to today (from ${days})`, { ms: 7000 });
}

// once per session: anything that has sat in the Trash past TRASH_DAYS goes for good
function purgeOldTrash() {
  if (purgeOldTrash._done) return; purgeOldTrash._done = true;
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  const old = state.trash.filter((x) => x.deleted_at < cutoff);
  if (!old.length) return;
  db.from("fm_tasks").delete().in("id", old.map((x) => x.id)).then(() => { state.trash = state.trash.filter((x) => x.deleted_at >= cutoff); }, () => {});
}

// ---------- change log + undo ----------
// Every change the app makes is written to fm_moves (batch app-<date>) with a one-line
// reason, like the brain and the scheduled runs do — so "why did this move" has an answer.
async function logApp(kind, t, before, after, reason) {
  return db.from("fm_moves").insert({ batch_id: "app-" + todayISO(), kind, task_id: t.id, before, after, reason,
    from_date: before?.scheduled_date ?? null, to_date: after?.scheduled_date ?? null }).then(() => {}, () => {});
}
// The undo stack lives in this window for the session: the last 25 changes he made here.
const undoStack = [];   // { label, revert: async () => boolean, at }
function pushUndo(label, revert) { undoStack.push({ label, revert, at: Date.now() }); if (undoStack.length > 25) undoStack.shift(); }
async function undoLast() {
  const u = undoStack.pop();
  if (!u) { toast("Nothing to undo"); return false; }
  const ok = await u.revert();
  if (ok !== false) toast(`Undid: ${u.label}`);
  render();
  return ok !== false;
}
const whenShort = (ts) => ts ? new Date(ts).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" AM", "a").replace(" PM", "p") : "";
// keep a row in the right list (live vs trash) after deleted_at changes
function placeRow(t) {
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  state.trash = state.trash.filter((x) => x.id !== t.id);
  if (t.deleted_at) { state.trash.unshift(t); if (state.openId === t.id) state.openId = null; }
  else state.tasks.push(t);
}

// The one way the app changes a task: patch → log → undo entry → redraw.
async function patchTask(t, patch, { kind = "update", reason = "", label = null, undoable = true } = {}) {
  const before = {}; for (const k of Object.keys(patch)) before[k] = t[k] ?? null;
  const { error } = await db.from("fm_tasks").update(patch).eq("id", t.id);
  if (error) { toast("Save failed: " + error.message); return false; }
  Object.assign(t, patch);
  if ("deleted_at" in patch) placeRow(t);
  logApp(kind, t, before, patch, reason);
  if (undoable && label) pushUndo(label, () => patchTask(t, before, { kind: "undo", reason: "Undo: " + label, undoable: false }));
  render();
  return true;
}
// the actions he presses most — each one logs with a reason and can be undone
const markDone = (t) => patchTask(t, { status: "done", done_at: new Date().toISOString() }, { kind: "complete", reason: "Done — marked in the app", label: `Done "${t.title}"` });
const reopen = (t) => patchTask(t, { status: "not_started", done_at: null }, { kind: "update", reason: "Reopened in the app", label: `Reopen "${t.title}"` });
const removeTask = (t) => patchTask(t, { deleted_at: new Date().toISOString() }, { kind: "delete", reason: "Removed in the app → Trash", label: `Remove "${t.title}"` });
const putBack = (t) => patchTask(t, { deleted_at: null }, { kind: "restore", reason: "Put back from the Trash", label: `Put back "${t.title}"` });
async function deleteForGood(t) {
  if (!confirm(`Delete "${t.title}" for good? This one can't be undone.`)) return false;
  const { error } = await db.from("fm_tasks").delete().eq("id", t.id);
  if (error) { toast("Delete failed: " + error.message); return false; }
  state.trash = state.trash.filter((x) => x.id !== t.id);
  db.from("fm_moves").insert({ batch_id: "app-" + todayISO(), kind: "purge", task_id: null, before: t, after: null, reason: "Deleted for good from the Trash" }).then(() => {}, () => {});
  render();
  return true;
}

async function insertTask(row) {
  const { data, error } = await db.from("fm_tasks").insert(row).select().single();
  if (error) { toast("Add failed: " + error.message); return null; }
  state.tasks.push(data);
  logApp("add", data, null, data, row.source === "quick" ? "Quick add" : "Added in the app");
  pushUndo(`Add "${data.title}"`, () => patchTask(data, { deleted_at: new Date().toISOString() }, { kind: "delete", reason: "Undo: add", undoable: false }));
  render();
  return data;
}

// realtime: if Claude (or another window) changes a task, this window follows
let liveChannel = null;
let refreshQueued = false;
let lastRefresh = 0;

// don't redraw under Adam's fingers: skip while he is editing or typing
function userIsTyping() {
  if (state.editId != null) return true;
  if (voice.on) return true;
  const a = document.activeElement;
  return !!a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox" && a.value));
}

async function refresh() {
  if (document.hidden) return;
  if (userIsTyping()) { refreshQueued = true; return; }
  refreshQueued = false;
  lastRefresh = Date.now();
  await loadAll();
}

function subscribe() {
  if (liveChannel) { try { db.removeChannel(liveChannel); } catch (e) {} }
  liveChannel = db.channel("fm_tasks_live_" + Date.now())
    .on("postgres_changes", { event: "*", schema: "public", table: "fm_tasks" }, () => refresh())
    .on("postgres_changes", { event: "*", schema: "public", table: "fm_meetings" }, () => { clearTimeout(subscribe._m); subscribe._m = setTimeout(refresh, 1500); })
    .on("postgres_changes", { event: "*", schema: "public", table: "fm_bill_payments" }, () => refresh())
    .on("postgres_changes", { event: "*", schema: "public", table: "fm_bills" }, () => refresh())
    .on("postgres_changes", { event: "*", schema: "public", table: "fm_accounts" }, () => refresh())
    .subscribe((status) => {
      if (status === "SUBSCRIBED") refresh();
      if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") setTimeout(subscribe, 3000);
    });
}

// belt and braces: catch up when the tab wakes, the network returns, and every 30 s
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", () => refresh());
window.addEventListener("online", () => { subscribe(); refresh(); });
setInterval(() => { if (!document.hidden && (Date.now() - lastRefresh) > 25000) refresh(); }, 30000);
setInterval(() => { if (refreshQueued && !userIsTyping()) refresh(); }, 2000);

// ---------- derived ----------
// $ Bills mode: the calendar and panel show bills only (desktop: the 4th button; phone: the Bills tab)
const billsMode = () => state.bucket === "bills" || (isPhone() && state.tab === "bills");
const inBucket = (t) => !billsMode() && (state.bucket === "both" || t.bucket === state.bucket);
// done items stay visible on their day (faded, ✓) — the Trash is the only thing that hides a task
const visible = (t) => inBucket(t);
const isDone = (t) => t.status === "done";
const tasksOn = (dateISO) => state.tasks.filter((t) => visible(t) && t.scheduled_date === dateISO).sort(dayOrder);
const openOn = (dateISO) => tasksOn(dateISO).filter((t) => !isDone(t));
const unscheduled = () => state.tasks.filter((t) => visible(t) && !t.scheduled_date && !isDone(t)).sort(byPriority);
// done in the last N days (newest first), the Trash included so "did I finish that?" always has an answer
const doneLog = (days = TRASH_DAYS) => {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return [...state.tasks, ...state.trash].filter((t) => inBucket(t) && isDone(t) && t.done_at && t.done_at >= cutoff).sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
};
const doneThisWeek = () => { const s = iso(weekStart(new Date())); return doneLog(8).filter((t) => iso(new Date(t.done_at)) >= s).length; };
const trashItems = () => state.trash.filter(inBucket);
// ---------- meetings (PCI Outlook, read-only, work calendar) + off days ----------
const SIZE_HRS = { "15m": 0.25, "1h": 1, half: 4, full: 8 };
const DAY_HRS = 8;
const OFF_SOURCES = new Set(["pcg_holiday", "pto"]);   // all-day rows that take the whole day off
const showMeetings = () => state.bucket !== "home" && !billsMode();
const meetingsOn = (dISO) => showMeetings() ? state.meetings.filter((m) => m.day === dISO) : [];
const timedOn = (dISO) => meetingsOn(dISO).filter((m) => !m.all_day);
const allDayOn = (dISO) => meetingsOn(dISO).filter((m) => m.all_day);
const isOff = (m) => m.all_day && OFF_SOURCES.has(m.source);
// a holiday row: PCG days off, plus the standard ones Outlook puts on the calendar (not days off)
const HOLIDAY_RE = /holiday|new year|martin luther|mlk|presidents|memorial day|juneteenth|independence day|labor day|columbus|indigenous|veterans|thanksgiving|christmas|halloween|valentine|st\.? patrick|easter|mother'?s day|father'?s day|election day|good friday|flag day|cinco de mayo|groundhog|daylight saving/i;
const isHoliday = (m) => m.all_day && (/holiday/i.test(m.source || "") || HOLIDAY_RE.test(m.title || ""));
const offOn = (dISO) => state.meetings.filter((m) => m.day === dISO && isOff(m));
const isWeekend = (dISO) => { const d = fromISO(dISO).getDay(); return d === 0 || d === 6; };
const dayCapacity = (dISO) => (isWeekend(dISO) || offOn(dISO).length) ? 0 : DAY_HRS;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" AM", "a").replace(" PM", "p");
const mtgHrs = (m) => Math.max(0, (new Date(m.end_at) - new Date(m.start_at)) / 3600000);
const fmtHrs = (h) => (Math.round(h * 4) / 4).toString().replace(/\.0$/, "") + " h";
// what counts against the 8 h day: meetings he attends + work tasks on that day
function dayLoad(dISO) {
  const cap = dayCapacity(dISO);
  const off = !isWeekend(dISO) && cap === 0;   // holiday / PTO: he is not in those meetings
  const mtg = off ? 0 : timedOn(dISO).filter((m) => m.attending).reduce((a, m) => a + mtgHrs(m), 0);
  const work = state.tasks.filter((t) => t.bucket === "work" && t.status !== "done" && t.scheduled_date === dISO)
    .reduce((a, t) => a + (SIZE_HRS[t.size] ?? 1), 0);
  return { mtg, work, total: mtg + work, cap, free: cap - mtg - work, over: mtg + work > cap };
}
// the next day a task can land on: work skips weekends + off days, home takes any day
function nextDay(fromISOStr, dir, bucket) {
  let d = fromISO(fromISOStr);
  for (let i = 0; i < 30; i++) {
    d = addDays(d, dir);
    const s = iso(d);
    if (bucket === "home") return s;
    if (!isWeekend(s) && !offOn(s).length) return s;
  }
  return iso(d);
}
// where a work task lands if it is pointed at a day that holds no work (weekend, holiday, PTO): the next work day
const landDay = (dISO, bucket) => (bucket === "work" && dayCapacity(dISO) === 0) ? nextDay(dISO, 1, bucket) : dISO;
const whyOff = (dISO) => offOn(dISO).length ? `off (${offOn(dISO).map((m) => m.title).join(", ")})` : isWeekend(dISO) ? "the weekend" : "";
// move a task and log it like the brain does, so Undo and "why" work the same way
async function moveTask(t, toISO, reason, { ask = true } = {}) {
  if (!toISO || toISO === t.scheduled_date) return false;
  if (ask && t.promised_to && !confirm(`"${t.title}" is promised to ${t.promised_to}. Move it anyway?`)) return false;
  if (ask && t.dropdead_date && toISO > t.dropdead_date && !confirm(`That is past its drop-dead (${fmtShort(t.dropdead_date)}). Move it anyway?`)) return false;
  if (ask && t.bucket === "work" && dayCapacity(toISO) === 0 && !confirm(`${fmtShort(toISO)} is ${whyOff(toISO)} — no work goes there. Put it there anyway?\n(Cancel, then use ‹ › or Pick a day for a work day.)`)) return false;
  const from = t.scheduled_date;
  const ok = await patchTask(t, { scheduled_date: toISO, planned: false }, { kind: "move", reason, label: `Move "${t.title}" ${from ? fmtShort(from) : "inbox"} → ${fmtShort(toISO)}` });
  return ok;
}
// order of a day (rulebook 5.3): urgent → promises due → drop-deads within 2 days → planned → high → normal → low · done last
function dayOrder(a, b) {
  const r = (t) => {
    const today = todayISO(), soon = iso(addDays(new Date(), 2));
    if (isDone(t)) return 9;
    if (t.priority === "urgent") return 0;
    if (t.promised_to && (!t.dropdead_date || t.dropdead_date <= soon)) return 1;
    if (t.dropdead_date && t.dropdead_date <= soon) return 2;
    if (t.planned) return 3;
    return 4 + (PRI_ORDER[t.priority] ?? 2);
  };
  return (r(a) - r(b)) || (a.sort - b.sort) || (a.id - b.id);
}
async function setAttending(m, attending) {
  // applies to every meeting with this exact title (the whole series)
  const { data: s } = await db.auth.getSession();
  const uid = s?.session?.user?.id;
  await db.from("fm_meeting_rules").delete().eq("match_title", m.title);
  const ins = await db.from("fm_meeting_rules").insert({ user_id: uid, match_title: m.title, attending, note: "set in app" });
  if (ins.error) { toast("Couldn't save: " + ins.error.message); return; }
  const up = await db.from("fm_meetings").update({ attending }).eq("title", m.title);
  if (up.error) { toast("Couldn't save: " + up.error.message); return; }
  state.meetings.forEach((x) => { if (x.title === m.title) x.attending = attending; });
  toast(attending ? `Counting "${m.title}" on your day` : `"${m.title}" no longer counts`);
  render();
}
function meetingLine(m, { compact = false } = {}) {
  const off = isOff(m);
  const cls = "mtg " + (off ? "allday off" : m.all_day ? "allday" : m.attending ? "going" : "invited") + (isHoliday(m) ? " holiday" : "");
  const mark = m.all_day ? "◇" : m.attending ? "■" : "◌";
  const when = m.all_day ? (off ? "Day off" : "All day") : `${fmtTime(m.start_at)}–${fmtTime(m.end_at)}`;
  const n = el("div", cls);
  if (compact) n.textContent = m.all_day ? `${mark} ${m.title}` : `${mark} ${fmtTime(m.start_at)} ${m.title}`;
  else n.innerHTML = `<span class="mk">${mark}</span><span class="tm">${esc(when)}</span><span class="tt">${esc(m.title)}</span>`;
  n.title = `${m.title} · ${when} · ${off ? "Day off — no work goes here" : m.all_day ? "All day (from Outlook)" : m.attending ? "You're in this one — counts against your day" : "Invited — not counted on your day"}`;
  return n;
}
function meetingCard(m) {
  const row = meetingLine(m);
  row.classList.add("card");
  if (!m.all_day) {
    const tag = el("span", "tag", m.attending ? "You go · counts" : "Invited · not counted");
    const b = el("button", "btn sm", m.attending ? "I don't go" : "I go to this");
    b.title = "Applies to every meeting with this name";
    b.addEventListener("click", (e) => { e.stopPropagation(); setAttending(m, !m.attending); });
    row.append(tag, b);
  }
  return row;
}
function loadLine(dISO) {
  const L = dayLoad(dISO);
  const n = el("div", "load" + (L.over ? " over" : ""));
  if (L.cap === 0 && offOn(dISO).length) n.textContent = `${L.over ? "!! " : ""}Day off — ${offOn(dISO).map((m) => m.title).join(", ")}${L.total ? ` · ${fmtHrs(L.total)} booked anyway` : ""}`;
  else n.textContent = `${L.over ? "!! Over by " + fmtHrs(L.total - L.cap) + " · " : ""}Work ${fmtHrs(L.work)} + meetings ${fmtHrs(L.mtg)} = ${fmtHrs(L.total)} of ${L.cap} h`;
  return n;
}
function meetingsSection(r, dISO, title = "Meetings") {
  const ms = meetingsOn(dISO);
  if (!ms.length) return;
  const h = el("h3"); h.append(title, el("span", "muted", "from your PCI Outlook"));
  r.append(h);
  const box = el("div", "mtgs");
  ms.sort((a, b) => (a.all_day === b.all_day ? a.start_at.localeCompare(b.start_at) : a.all_day ? -1 : 1)).forEach((m) => box.append(meetingCard(m)));
  r.append(box);
}

function byPriority(a, b) {
  return (PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) || (a.sort - b.sort) || (a.id - b.id);
}

// one short status line per task: never color alone
function statusLine(t) {
  const today = todayISO();
  if (t.status === "done") return { text: "✓ Done" + (t.done_at ? " · " + whenShort(t.done_at) : ""), cls: "done" };
  if (t.dropdead_date && t.dropdead_date < today) return { text: `Overdue ${daysBetween(t.dropdead_date, today)}d`, cls: "overdue" };
  if (t.status === "waiting") return { text: `Waiting on ${t.waiting_on || "…"}`, cls: "warn" };
  if (t.target_date && t.target_date < today) return { text: "Target missed", cls: "warn" };
  if (t.carried > 0) return { text: `Carried ×${t.carried} · was ${fmtShort(t.carried_from || t.scheduled_date).replace(",", "")}`, cls: "warn" };
  if (t.planned) return { text: "Planned", cls: "" };
  return { text: STATUS[t.status] || "Not started", cls: "" };
}

function tooltip(t) {
  const parts = [`${PRI[t.priority].label}`, isDone(t) ? "Done " + whenShort(t.done_at) : STATUS[t.status]];
  if (t.carried > 0 && !isDone(t)) parts.push(`carried forward ${t.carried}×`);
  if (t.job) parts.push(t.job);
  if (t.target_date) parts.push("Target " + fmtShort(t.target_date));
  if (t.dropdead_date) parts.push("Drop-dead " + fmtShort(t.dropdead_date));
  if (t.promised_to) parts.push("Promised to " + t.promised_to);
  return parts.join(" · ");
}

// ---------- render ----------
function render(opts) {
  // Mid-scroll in month view? A rebuild would snap the scrollbar back — wait for it to settle.
  // (opts.now skips that wait: the Assistant panel must open the instant he presses the button.)
  if (!opts?.now && state.view === "month" && !state.mJump && Date.now() - M.lastScroll < 400 && M.scroller && M.scroller.isConnected) {
    clearTimeout(M.pending); M.pending = setTimeout(render, 450); return;
  }
  clearTimeout(M.pending); M.pending = null;
  renderTop();
  if (MINI_ONLY) { renderMini($("mini-root")); updateBadge(); return; }
  document.body.classList.toggle("phone", isPhone());
  if (isPhone()) { renderPhone(); updateBadge(); return; }
  renderCalendar();
  renderRail();
  $("layout").classList.toggle("wide", !!state.panel);
  renderMini();
  updateBadge();
}

function renderTop() {
  document.querySelectorAll("#bucket-seg button").forEach((b) => b.classList.toggle("on", b.dataset.bucket === state.bucket));
  document.querySelectorAll("#view-seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  const badge = document.querySelector('#bucket-seg button[data-bucket="bills"] .bbadge');
  if (badge) { const n = B.loaded ? pastDue(todayISO()).length : 0; badge.textContent = n ? `${n} LATE` : ""; badge.classList.toggle("hidden", !n); }
  const btn = $("tell-btn"), inp = $("quick-input");
  if (btn) { btn.classList.toggle("listening", voice.on); const l = btn.querySelector("span"); if (l) l.textContent = voice.on ? "Listening… press to send" : "Assistant"; }
  if (inp) inp.placeholder = voice.on ? "Listening… say it at your pace" : "Quick add (Enter) — or type anything and press Assistant";
}

function renderCalendar() {
  const body = $("cal-body");
  body.innerHTML = "";
  document.querySelector(".cal-head")?.classList.toggle("bills", billsMode());
  if (state.view === "month") renderMonth(body);
  else if (state.view === "week") renderWeek(body);
  else renderDay(body);
}

function chipFor(t) {
  const done = isDone(t);
  const c = el("span", `chip p-${t.priority}` + (t.planned ? " planned" : "") + (t.bucket === "home" && state.bucket === "both" ? " bucket-home" : "") + (done ? " is-done" : ""));
  c.append(el("span", "sym", done ? "✓" : PRI[t.priority].mark));
  if (t.carried > 0 && !done) { const k = el("span", "carry", `↻${t.carried}`); k.title = `Carried forward ${t.carried}× — first due ${fmtShort(t.carried_from || t.scheduled_date)}`; c.append(k); }
  if (!t.confirmed && !done) {
    const q = el("span", "q", "?");
    q.title = "I guessed the size and priority — click to set them";
    q.addEventListener("click", (e) => { e.stopPropagation(); openQuickFix(t, c); });
    c.append(q);
  }
  c.append(document.createTextNode(t.title));
  if (t.scheduled_date && !done) {
    const l = el("span", "mv l", "‹"); l.title = "Push a day earlier";
    const r = el("span", "mv r", "›"); r.title = "Push a day later";
    l.addEventListener("click", (e) => { e.stopPropagation(); moveTask(t, nextDay(t.scheduled_date, -1, t.bucket), "Pushed a day earlier with the chip arrow"); });
    r.addEventListener("click", (e) => { e.stopPropagation(); moveTask(t, nextDay(t.scheduled_date, 1, t.bucket), "Pushed a day later with the chip arrow"); });
    c.append(l, r);
  }
  if (done) {   // second click on a finished item: clear it off the day → Trash (Put back any time)
    const x = el("span", "mv x", "×"); x.title = "Remove from this day — it goes to the Trash (Put back any time)";
    x.setAttribute("aria-label", "Remove from this day");
    x.addEventListener("click", async (e) => { e.stopPropagation(); if (await removeTask(t)) toast(`Removed "${t.title}" — it's in the Trash`, { undo: true }); });
    c.append(x);
  }
  c.title = tooltip(t) + (t.confirmed || done ? "" : " · size/priority guessed (?)") + (done ? " · click × to clear it off the day" : "");
  c.draggable = !done;
  c.dataset.id = t.id;
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(t.id)); e.dataTransfer.effectAllowed = "move"; });
  c.addEventListener("click", (e) => { e.stopPropagation(); openDay(t.scheduled_date, t.id); });
  return c;
}

// "?" popover: 2 questions — how long, which priority — then Save
let popEl = null;
function closeQuickFix() { if (popEl) { popEl.remove(); popEl = null; } }
document.addEventListener("click", (e) => { if (popEl && !popEl.contains(e.target)) closeQuickFix(); });
// free-entry hours snap to the nearest size the calendar knows (15 m · 1 h · ½ day · full)
const snapSize = (h) => (h <= 0.5 ? "15m" : h <= 2 ? "1h" : h <= 5 ? "half" : "full");
// put a popover under its anchor, kept inside the window
function placePop(p, anchor, w, h) {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - w - 10, r.left));
  const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  p.style.left = left + "px"; p.style.top = top + "px";
}

// ---------- date picker popover: a real month to look at, click a day ----------
function openDatePop(anchor, startISO, onPick) {
  closeQuickFix();
  const p = el("div", "pop datepop");
  let cur = fromISO(startISO || todayISO()); cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const draw = () => {
    p.innerHTML = "";
    const head = el("div", "dp-head");
    const prev = el("button", "btn sm", "‹"); prev.type = "button"; prev.title = "Previous month";
    const next = el("button", "btn sm", "›"); next.type = "button"; next.title = "Next month";
    prev.addEventListener("click", () => { cur = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); draw(); });
    next.addEventListener("click", () => { cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); draw(); });
    head.append(prev, el("b", "", cur.toLocaleDateString("en-US", { month: "long", year: "numeric" })), next);
    p.append(head);
    const grid = el("div", "dp-grid");
    ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].forEach((d) => grid.append(el("span", "dp-dow", d)));
    for (let i = 0; i < cur.getDay(); i++) grid.append(el("span", "dp-blank", ""));
    const n = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= n; d++) {
      const dISO = iso(new Date(cur.getFullYear(), cur.getMonth(), d));
      const off = offOn(dISO);
      const b = el("button", "dp-day" + (dISO === todayISO() ? " today" : "") + (isWeekend(dISO) ? " wk" : "") + (off.length ? " off" : "") + (dISO === startISO ? " on" : "") + (dISO < todayISO() ? " past" : ""), String(d));
      b.type = "button";
      b.title = off.length ? off.map((m) => m.title).join(", ") : fmtLong(dISO);
      b.addEventListener("click", () => { closeQuickFix(); onPick(dISO); });
      grid.append(b);
    }
    p.append(grid);
    const foot = el("div", "dp-foot");
    const t = el("button", "btn sm", "Today"); t.type = "button"; t.addEventListener("click", () => { closeQuickFix(); onPick(todayISO()); });
    foot.append(t, el("span", "hint", "hatched = day off · tan = weekend"));
    p.append(foot);
  };
  draw();
  p.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(p);
  placePop(p, anchor, 312, 330);
  popEl = p;
}
function openQuickFix(t, anchor) {
  closeQuickFix();
  const p = el("div", "pop");
  const pick = { size: t.size || "1h", priority: t.priority, hrs: "" };
  p.innerHTML = `<div class="ttl">I guessed these for <b>${esc(t.title)}</b> — set them:</div>`;
  const mk = (label, cls) => { const h = el("span", "h", label); p.append(h); const r = el("div", "r " + cls); p.append(r); return r; };
  const sizes = mk("EST. TIME", "sz");
  const szBtns = {};
  [["15m", "15 m"], ["1h", "1 h"], ["half", "½ day"], ["full", "Full"]].forEach(([v, txt]) => {
    const b = el("button", "o" + (pick.size === v && !pick.hrs ? " on" : ""), txt); b.type = "button";
    b.addEventListener("click", () => { pick.size = v; pick.hrs = ""; hrs.value = ""; Object.values(szBtns).forEach((x) => x.classList.remove("on")); b.classList.add("on"); });
    szBtns[v] = b; sizes.append(b);
  });
  const hrs = el("input", "hrs"); hrs.type = "number"; hrs.min = "0.25"; hrs.step = "0.25"; hrs.placeholder = "hrs"; hrs.title = "Or type the hours";
  hrs.addEventListener("input", () => { pick.hrs = hrs.value; Object.values(szBtns).forEach((x) => x.classList.remove("on")); });
  sizes.append(hrs);
  const pris = mk("PRIORITY", "pr");
  const prBtns = {};
  Object.entries(PRI).forEach(([v, d]) => {
    const b = el("button", "o" + (pick.priority === v ? " on" : ""), d.mark); b.type = "button"; b.title = d.label;
    b.addEventListener("click", () => { pick.priority = v; Object.values(prBtns).forEach((x) => x.classList.remove("on")); b.classList.add("on"); });
    prBtns[v] = b; pris.append(b);
  });
  const save = el("button", "o save", "Save"); save.type = "button";
  save.addEventListener("click", async () => {
    const h = Number(pick.hrs);
    // free-entry hours snap to the nearest bucket the calendar knows (15 m · 1 h · ½ day · full), noted in the task
    let size = pick.size, note = null;
    if (pick.hrs && h > 0) { size = snapSize(h); note = `Adam: ${h} h`; }
    const patch = { size, priority: pick.priority, confirmed: true };
    if (note) patch.notes = (t.notes ? t.notes + "\n" : "") + note;
    closeQuickFix();
    if (await patchTask(t, patch, { reason: "Adam set size + priority (the ? badge)", label: `Set size/priority on "${t.title}"` })) toast(`Set: ${SIZE[size]} · ${PRI[pick.priority].label}`, { undo: true });
  });
  pris.append(save);
  p.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(p);
  placePop(p, anchor, 300, 170);
  popEl = p;
}

function dayCell(d, { other = false, max = 4, fit = 0 } = {}) {
  if (billsMode()) return billDayCell(d, { other, max, fit });
  const dISO = iso(d);
  const cell = el("div", "day");
  if (other) cell.classList.add("other");
  if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add("weekend");
  const isToday = dISO === todayISO();
  const items = tasksOn(dISO);
  if (isToday) cell.classList.add("today");
  else if (dISO < todayISO()) {
    // the stamp tells the truth: DONE when nothing is left open on that day, else how many are still open
    cell.classList.add("past");
    const left = items.filter((t) => !isDone(t)).length;
    const st = el("span", "stamp" + (left ? " open" : ""), left ? `${left} OPEN` : "DONE");
    st.title = left ? `${left} item${left === 1 ? "" : "s"} on this past day still open — finish or move them` : "Nothing left open on this day";
    cell.append(st);
  }
  if (dISO === state.selected && state.panel === "day") cell.classList.add("selected");

  const num = el("div", "num");
  const numLabel = el("span", "", String(d.getDate()));
  if (isToday) numLabel.append(el("b", "today-tag", "TODAY"));
  num.append(numLabel);
  const weekday = d.getDay() !== 0 && d.getDay() !== 6;
  const off = offOn(dISO);
  if (off.length) cell.classList.add("off");
  const L = dayLoad(dISO);
  const past = !isToday && dISO < todayISO();
  let cap = null;
  if (showMeetings() && weekday && off.length) {
    const o = el("span", "count off", L.total ? `!! ${fmtHrs(L.total)} ON A DAY OFF` : "OFF");
    o.title = off.map((m) => m.title).join(", ") + (L.total ? " — nothing should be booked here" : "");
    num.append(o);
  } else if (showMeetings() && weekday && (L.total > 0 || !past)) {
    const ld = el("span", "count" + (L.over ? " over" : ""), L.total ? `${L.over ? "!! " : ""}${fmtHrs(L.total)}/8` : "");
    ld.title = `Work ${fmtHrs(L.work)} + meetings you attend ${fmtHrs(L.mtg)}${L.over ? " — over the 8 h day" : ""}`;
    num.append(ld);
    if (!past) {
      cap = el("div", "cap" + (L.over ? " over" : ""));
      const fill = el("i"); fill.style.width = Math.min(100, Math.round(L.total / DAY_HRS * 100)) + "%";
      cap.append(fill); cap.title = ld.title || "Hours booked of 8";
    }
  } else if (items.length) num.append(el("span", "count", `${items.length}`));
  cell.append(num);
  const due = state.tasks.filter((t) => visible(t) && t.status !== "done" && t.dropdead_date === dISO);
  if (due.length) {
    cell.classList.add("has-dd");
    const tab = el("div", "dd", "DD");
    tab.title = "Drop-dead today:\n" + due.map((t) => "• " + t.title).join("\n");
    tab.setAttribute("aria-label", `${due.length} drop-dead due`);
    cell.append(tab);
  }
  // lines, most important first: days off → meetings you go to → tasks → "+N more" → Outlook all-day items → invited
  const going = timedOn(dISO).filter((m) => m.attending);
  const invited = timedOn(dISO).filter((m) => !m.attending);
  const allDay = allDayOn(dISO);
  allDay.filter(isOff).forEach((m) => cell.append(meetingLine(m, { compact: true })));
  going.forEach((m) => cell.append(meetingLine(m, { compact: true })));
  let room = fit ? Math.max(0, fit - cell.querySelectorAll(".mtg").length) : 99;
  let show = Math.min(max, room);
  if (items.length > show) show = Math.max(0, Math.min(show, room - 1));
  items.slice(0, show).forEach((t) => cell.append(chipFor(t)));
  room -= show;
  if (items.length > show) { const m = el("div", "more", `+${items.length - show} more`); m.title = items.slice(show).map((t) => PRI[t.priority].mark + " " + t.title).join("\n"); cell.append(m); room -= 1; }
  allDay.filter((m) => !isOff(m)).forEach((m) => { if (room > 0) { cell.append(meetingLine(m, { compact: true })); room -= 1; } });
  if (invited.length && room > 0) {
    if (max > 4) invited.forEach((m) => cell.append(meetingLine(m, { compact: true })));
    else {
      const inv = el("div", "mtg invited", `◌ ${invited.length} invited`);
      inv.title = invited.map((m) => `${fmtTime(m.start_at)} ${m.title}`).join("\n") + "\n(not counted on your day)";
      cell.append(inv);
    }
  }
  if (cap) cell.append(cap);

  cell.addEventListener("click", () => openDay(dISO));
  cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("drop"); });
  cell.addEventListener("dragleave", () => cell.classList.remove("drop"));
  cell.addEventListener("drop", async (e) => {
    e.preventDefault(); cell.classList.remove("drop");
    const id = Number(e.dataTransfer.getData("text/plain"));
    const t = state.tasks.find((x) => x.id === id);
    if (t && await moveTask(t, dISO, "Dragged to " + fmtShort(dISO))) toast("Moved to " + fmtShort(dISO), { undo: true });
  });
  return cell;
}

// Month view = one continuous run of weeks. Scroll wheel / scrollbar slides
// partway into next or prior months to peek. The month in focus (white cells,
// the title) is anchored: it only changes with ‹ › and Today, never by scrolling —
// scrolling used to flip the focus and turn the current month tan mid-screen.
// While he is scrolled into another month a small "viewing October" note shows
// by the title. Built ONCE for a wide window (±12 months). Scrolling never
// rebuilds the DOM: running out of weeks just appends/prepends more rows. Data
// refreshes that land mid-scroll wait until the scroll settles (a rebuild
// mid-drag snaps the scrollbar back).
const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthRows = (m) => Math.ceil((m.getDay() + new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) / 7);
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
const M = { scroller: null, head: null, first: null, last: null, lastScroll: 0, pending: null, fit: 0 };
const LINE_PX = 23, CELL_CHROME = 42;   // one chip/meeting line · number row + load bar + padding
const fitFor = (rowh) => Math.max(1, Math.floor((rowh - CELL_CHROME) / LINE_PX));

function weekRow(start, focusKey, max) {
  const row = el("div", "mweek");
  row.dataset.start = iso(start);
  const gut = el("div", "gut");
  gut.append(el("span", "", "WK"), el("b", "", String(rowWeek(start))));
  gut.title = `Week ${rowWeek(start)} of ${weeksInYear(addDays(start, 4).getFullYear())}`;
  if (todayISO() >= iso(start) && todayISO() <= iso(addDays(start, 6))) gut.classList.add("cur");
  row.append(gut);
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const cell = dayCell(d, { other: monthKey(d) !== focusKey, max, fit: M.fit });
    cell.dataset.month = monthKey(d);
    if (monthKey(addDays(d, -7)) !== monthKey(d)) cell.classList.add("mtop");
    if (iso(d) === todayISO()) row.classList.add("cur");
    if (d.getDate() === 1) {
      cell.classList.add("mstart");
      cell.querySelector(".num span").textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    row.append(cell);
  }
  return row;
}

function renderMonth(body) {
  const focus = firstOfMonth(state.cursor);
  const focusKey = monthKey(focus);
  const max = monthRows(focus) >= 6 ? 3 : 4;
  const winStart = weekStart(new Date(focus.getFullYear(), focus.getMonth() - 12, 1));
  const winEnd = new Date(focus.getFullYear(), focus.getMonth() + 13, 0);
  const weeks = Math.ceil((daysBetween(iso(winStart), iso(winEnd)) + 1) / 7);

  const scroller = el("div", "mscroll");
  const head = el("div", "mhead");
  head.append(el("div", "gut hd0", "WK"));
  DOW_FULL.forEach((d, i) => head.append(el("div", "dow" + (i === new Date().getDay() ? " td" : "") + (i === 0 || i === 6 ? " wkd" : ""), d)));
  scroller.append(head);
  body.append(scroller);
  // Row height: the focused month fills the screen exactly. Known before the rows are built, so each cell knows its room.
  const h = scroller.clientHeight - head.offsetHeight;
  const rowh = Math.max(96, Math.floor(h / monthRows(focus)));
  scroller.style.setProperty("--rowh", rowh + "px");
  M.fit = fitFor(rowh);
  const frag = document.createDocumentFragment();
  for (let w = 0; w < weeks; w++) frag.append(weekRow(addDays(winStart, w * 7), focusKey, max));
  scroller.append(frag);
  M.scroller = scroller; M.head = head; M.first = winStart; M.last = addDays(winStart, weeks * 7);
  $("cal-title").textContent = focus.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  setPeek(null);

  // Land: explicit jump (arrows / Today) or the same spot as before the redraw.
  const rowFor = (dISO) => scroller.querySelector(`.mweek[data-start="${iso(weekStart(fromISO(dISO)))}"]`);
  if (!state.mJump && state.mTop && rowFor(state.mTop.iso)) {
    scroller.scrollTop = rowFor(state.mTop.iso).offsetTop - head.offsetHeight + state.mTop.off;
  } else {
    const r = rowFor(state.mJump || iso(focus));
    if (r) {
      if (state.mJumpSmooth && state.mPrevTop != null) scroller.scrollTop = state.mPrevTop;
      scroller.scrollTo({ top: r.offsetTop - head.offsetHeight, behavior: state.mJumpSmooth ? "smooth" : "auto" });
    }
  }
  state.mJump = null; state.mJumpSmooth = false; state.mPrevTop = null;

  let ticking = false;
  scroller.addEventListener("scroll", () => { M.lastScroll = Date.now(); if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; monthOnScroll(); }); } }, { passive: true });
  if (!renderMonth._resize) { renderMonth._resize = true; window.addEventListener("resize", () => { if (state.view === "month") render(); }); }
}

function monthOnScroll() {
  const sc = M.scroller, head = M.head;
  if (!sc || !sc.isConnected) return;
  const rows = sc.querySelectorAll(".mweek");
  if (!rows.length) return;
  const rowH = rows[0].offsetHeight + 5;
  const top = sc.scrollTop;
  const firstTop = rows[0].offsetTop - head.offsetHeight;
  const idx = Math.max(0, Math.min(rows.length - 1, Math.floor((top - firstTop) / rowH)));
  const topRow = rows[idx];
  state.mTop = { iso: topRow.dataset.start, off: top - (topRow.offsetTop - head.offsetHeight) };

  // The month a third of the way down the screen. The focus month (white cells, the title)
  // does NOT follow it — only a small note by the title says where he has scrolled to.
  const probeIdx = Math.min(rows.length - 1, Math.floor((top - firstTop + (sc.clientHeight - head.offsetHeight) / 3) / rowH));
  const f = firstOfMonth(addDays(fromISO(rows[probeIdx].dataset.start), 3));
  const focus = firstOfMonth(state.cursor);
  setPeek(sameMonth(f, focus) ? null : f);

  // Running out of weeks? Add more rows — no rebuild, no jump.
  const max = monthRows(focus) >= 6 ? 3 : 4, key = monthKey(focus), ADD = 12;
  if (sc.scrollHeight - top - sc.clientHeight < sc.clientHeight * 2) {
    const frag = document.createDocumentFragment();
    for (let w = 0; w < ADD; w++) frag.append(weekRow(addDays(M.last, w * 7), key, max));
    M.last = addDays(M.last, ADD * 7); sc.append(frag);
  }
  if (top < sc.clientHeight * 2) {
    const frag = document.createDocumentFragment();
    const newFirst = addDays(M.first, -ADD * 7);
    for (let w = 0; w < ADD; w++) frag.append(weekRow(addDays(newFirst, w * 7), key, max));
    M.first = newFirst; head.after(frag);
    sc.scrollTop = top + ADD * rowH;
  }
}

// "viewing October" note by the month title while he is scrolled away from the focus month
function setPeek(m) {
  const p = $("cal-peek"); if (!p) return;
  if (!m) { p.classList.add("hidden"); p.textContent = ""; return; }
  p.textContent = `↕ viewing ${m.toLocaleDateString("en-US", { month: "long", year: m.getFullYear() === state.cursor.getFullYear() ? undefined : "numeric" })} — Today or ‹ › to move`;
  p.classList.remove("hidden");
}

function weekStart(d) { return addDays(d, -d.getDay()); }

function renderWeek(body) {
  const s = weekStart(state.cursor), e = addDays(s, 6);
  $("cal-title").textContent = `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  const grid = el("div", "week");
  for (let i = 0; i < 7; i++) {
    const d = addDays(s, i);
    grid.append(el("div", "dow" + (iso(d) === todayISO() ? " td" : "") + (i === 0 || i === 6 ? " wkd" : ""), d.toLocaleDateString("en-US", { weekday: "long", day: "numeric" })));
  }
  for (let i = 0; i < 7; i++) grid.append(dayCell(addDays(s, i), { max: 12 }));
  body.append(grid);
}
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function renderDay(body) {
  const dISO = iso(state.cursor);
  $("cal-title").textContent = fmtLong(dISO);
  const wrap = el("div", "dayview");
  if (billsMode()) {
    const occ = occOn(dISO);
    if (!occ.length) wrap.append(el("div", "empty", "No bills due this day."));
    occ.forEach((o) => wrap.append(billCard(o)));
    body.append(wrap);
    return;
  }
  const items = tasksOn(dISO);
  if (showMeetings()) { wrap.append(loadLine(dISO)); meetingsSection(wrap, dISO); if (meetingsOn(dISO).length) wrap.append(el("h3", "", "Tasks")); }
  if (!items.length) wrap.append(el("div", "empty", "Nothing on this day. Drag something here or use Quick add."));
  items.forEach((t) => wrap.append(itemCard(t)));
  body.append(wrap);
}

// ---------- rail ----------
function renderRail() {
  const r = $("rail-body");
  r.innerHTML = "";
  if (state.panel === "addbill") return renderAddBillPanel(r);
  if (state.panel === "accounts") return renderAccountsPanel(r);
  if (state.panel === "billalerts") return renderBillAlertsPanel(r);
  if (billsMode()) {
    if (state.panel === "day" && state.selected) return renderBillDayPanel(r);
    if (state.panel === "brain") return renderBrainPanel(r);
    if (state.panel === "add") return renderAddPanel(r);
    return renderBillsPanel(r);
  }
  if (!state.panel) renderQuickLook(r);   // first thing in the general view only
  if (state.panel === "day" && state.selected) return renderDayPanel(r);
  if (state.panel === "unscheduled") return renderUnscheduledPanel(r);
  if (state.panel === "done") return renderDonePanel(r);
  if (state.panel === "trash") return renderTrashPanel(r);
  if (state.panel === "add") return renderAddPanel(r);
  if (state.panel === "brain") return renderBrainPanel(r);
  renderSkinny(r);
}

// ---------- AP brain (Supabase edge function ap-brain) ----------
const brain = { busy: false, log: [], history: [], batch: null, questions: null, lastBatch: null, queue: [] };
const BRAIN_TIMEOUT_MS = 90000;

// Everything he says goes through here. Never dropped: if AP is still thinking, the
// next thing waits its turn and goes out as the next message.
async function askBrain(text) {
  text = String(text || "").trim();
  if (!text) return;
  if (brain.busy) { brain.queue.push(text); brain.log.push({ who: "you", text, queued: true }); render({ now: true }); return; }
  brain.busy = true; brain.questions = null;
  const qi = brain.log.findIndex((m) => m.queued && m.text === text);
  if (qi >= 0) brain.log.splice(qi, 1);
  brain.log.push({ who: "you", text });
  state.panel = "brain"; state.openId = null; state.editId = null; render({ now: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRAIN_TIMEOUT_MS);
  try {
    const { data: s } = await db.auth.getSession();
    if (!s?.session?.access_token) throw new Error("not signed in");
    const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/ap-brain`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", apikey: CONFIG.SUPABASE_KEY, Authorization: `Bearer ${s.session.access_token}` },
      body: JSON.stringify({ text, today: todayISO(), now, history: brain.history, batch_id: brain.batch }),
    });
    if (!res.ok) throw new Error("server said " + res.status);
    const out = await res.json();
    brain.history.push({ role: "user", content: text });
    if (out.reply) brain.history.push({ role: "assistant", content: out.reply });
    brain.history = brain.history.slice(-10);
    brain.log.push({ who: "ap", text: out.reply || "(no reply)", actions: out.actions || [], questions: out.questions || null, error: !!out.error });
    if (out.pending) { brain.batch = out.batch_id; brain.questions = out.questions; }
    else {
      brain.batch = null;
      const n = (out.actions || []).length;
      if (n) {
        brain.lastBatch = out.batch_id;
        const id = out.batch_id;
        pushUndo(`Assistant's ${n} change${n === 1 ? "" : "s"}`, async () => { if (brain.lastBatch !== id) { toast("That one was already undone"); return false; } return undoLastBatch(); });
      }
    }
  } catch (e) {
    const why = e.name === "AbortError" ? "it took too long" : (e.message || String(e));
    brain.log.push({ who: "ap", text: `Didn't get through (${why}). Say it again or press Retry.`, error: true, retry: text });
  }
  clearTimeout(timer);
  brain.busy = false;
  await loadAll();
  if (brain.queue.length) askBrain(brain.queue.shift());
}

function answerQuestions(answers) {
  const text = "My answers: " + answers.map((a) => `${a.q} → ${a.a}`).join("; ") + ". Go ahead and file it.";
  askBrain(text);
}

async function undoLastBatch() {
  if (!brain.lastBatch) return false;
  const { data: moves, error } = await db.from("fm_moves").select("*").eq("batch_id", brain.lastBatch).order("id", { ascending: false });
  if (error || !moves?.length) { toast("Nothing to undo"); return false; }
  const stamp = new Date().toISOString();
  for (const m of moves) {
    if (m.kind === "add" && m.task_id) await db.from("fm_tasks").update({ deleted_at: stamp }).eq("id", m.task_id);   // to the Trash, not gone
    else if ((m.kind === "move" || m.kind === "update" || m.kind === "complete") && m.task_id && m.before) {
      const b = { ...m.before }; delete b.id; if (m.kind === "complete") b.done_at = null;
      await db.from("fm_tasks").update(b).eq("id", m.task_id);
    } else if (m.kind === "delete" && m.task_id) await db.from("fm_tasks").update({ deleted_at: null }).eq("id", m.task_id);   // back from the Trash
    else if (m.kind === "delete" && m.before) { const b = { ...m.before }; delete b.id; await db.from("fm_tasks").insert(b); }   // older hard deletes
    else if (m.kind === "bill_paid" && m.after?.id) await db.from("fm_bill_payments").delete().eq("id", m.after.id);
    else if (m.kind === "bill_unpaid" && m.before?.bill_id) await db.from("fm_bill_payments").insert({ bill_id: m.before.bill_id, due_date: m.before.due_date, source: m.before.source || "brain", note: m.before.note || null });
    else if (m.kind === "bill_add" && m.after?.id) await db.from("fm_bills").update({ deleted_at: stamp }).eq("id", m.after.id);
    else if (m.kind === "bill_update" && m.before?.id) { const b = { ...m.before }; delete b.id; delete b.name; await db.from("fm_bills").update(b).eq("id", m.before.id); }
    else if (m.kind === "off_add" && m.after?.id) await db.from("fm_meetings").delete().eq("id", m.after.id).eq("source", "pto");   // the day is a work day again
    else if (m.kind === "off_remove" && m.before?.day) await db.from("fm_meetings").insert({ source: "pto", ext_key: "pto-" + m.before.day, title: m.before.title || "PTO — day off", day: m.before.day, start_at: m.before.day + "T00:00:00Z", end_at: iso(addDays(fromISO(m.before.day), 1)) + "T00:00:00Z", all_day: true, attending: false });   // hatched again
  }
  await db.from("fm_moves").delete().eq("batch_id", brain.lastBatch);
  brain.log.push({ who: "ap", text: `Undid ${moves.length} change${moves.length === 1 ? "" : "s"}.` });
  brain.lastBatch = null;
  await loadAll();
  return true;
}

function renderBrainPanel(r) {
  panelHeader(r, "Assistant", brain.busy ? "thinking…" : voice.on ? "listening" : "");
  const box = el("div", "brain");
  brain.log.slice(-10).forEach((m) => {
    const b = el("div", "bubble " + (m.who === "you" ? "you" : "fm") + (m.queued ? " queued" : "") + (m.error ? " err" : ""));
    b.append(el("div", "who", m.who === "you" ? (m.queued ? "You · waiting for the last reply" : "You") : "Assistant"));
    b.append(el("div", "txt", m.text));
    if (m.retry && !brain.busy) { const rb = el("button", "btn sm", "Retry"); rb.addEventListener("click", () => { const t = m.retry; delete m.retry; askBrain(t); }); b.append(rb); }
    if (m.actions && m.actions.length) {
      const ul = el("ul", "acts");
      m.actions.forEach((a) => {
        let line = "";
        if (a.kind === "add") line = `Added "${a.title}"${a.to ? " on " + fmtShort(a.to) : " (unscheduled)"}`;
        else if (a.kind === "move") line = `Moved "${a.title}" ${a.from ? fmtShort(a.from) : "unscheduled"} → ${a.to ? fmtShort(a.to) : "unscheduled"}${a.reason ? ": " + a.reason : ""}`;
        else if (a.kind === "update") line = `Updated "${a.title}"${a.reason ? ": " + a.reason : ""}`;
        else if (a.kind === "complete") line = `Done: "${a.title}"`;
        else if (a.kind === "delete") line = `Removed "${a.title}" (it's in the Trash)`;
        else if (a.kind === "restore") line = `Put back "${a.title}"`;
        else if (a.kind === "bill_paid") line = `Paid ✓ ${a.title}`;
        else if (a.kind === "bill_unpaid") line = `Un-paid: ${a.title}`;
        else if (a.kind === "bill_add") line = `New bill: ${a.title}`;
        else if (a.kind === "bill_update") line = `Changed bill: ${a.title}`;
        else if (a.kind === "off_add") line = `Day off: ${a.to ? fmtShort(a.to) : ""} — ${a.title} (hatched on the calendar)`;
        else if (a.kind === "off_remove") line = `Work day again: ${a.from ? fmtShort(a.from) : ""} (was ${a.title})`;
        ul.append(el("li", "", line));
      });
      b.append(ul);
    }
    box.append(b);
  });
  if (brain.busy) box.append(el("div", "hint", "Working on it…"));
  if (voice.on && (voice.key === "brain" || voice.key === "quick")) {
    const live = el("div", "bubble you live"); live.id = "live-bubble";
    live.append(el("div", "who", "You · listening — pause 6 s or press to send"), el("div", "txt", voiceText() || "…"));
    box.append(live);
  }
  r.append(box);

  if (brain.questions && !brain.busy) {
    const qwrap = el("div", "questions");
    const picks = {};
    brain.questions.forEach((q) => {
      const card = el("div", "q");
      card.append(el("div", "qt", q.question));
      const opts = el("div", "opts");
      q.options.forEach((o) => {
        const b = el("button", "btn sm", o);
        b.addEventListener("click", () => { picks[q.id] = { q: q.question, a: o }; opts.querySelectorAll("button").forEach((x) => x.classList.remove("primary")); b.classList.add("primary"); });
        opts.append(b);
      });
      card.append(opts); qwrap.append(card);
    });
    const go = el("button", "btn primary", "Send answers");
    go.addEventListener("click", () => { const a = Object.values(picks); if (a.length < brain.questions.length) { toast("Answer each one"); return; } answerQuestions(a); });
    qwrap.append(go);
    r.append(qwrap);
  }

  const foot = el("div", "brain-foot");
  const inp = el("input"); inp.type = "text"; inp.placeholder = voice.on ? "Listening…" : "Say more…"; inp.className = "brain-input";
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && inp.value.trim()) { const v = inp.value.trim(); inp.value = ""; askBrain(v); } });
  const mic = el("button", "mic" + (voice.on ? " listening" : "")); mic.type = "button"; mic.innerHTML = MIC_SVG;
  mic.title = voice.on ? "Press to send" : "Press and talk";
  mic.addEventListener("click", () => { if (voice.on) voiceStop(); else { const v = inp.value.trim(); if (v) { inp.value = ""; askBrain(v); } else voiceStart("brain"); } });
  if (voice.on) inp.disabled = true;
  foot.append(inp, mic);
  if (brain.lastBatch && !brain.busy) { const u = el("button", "btn sm", "Undo last"); u.addEventListener("click", undoLastBatch); foot.append(u); }
  r.append(foot);
  // keep the newest bubble in view
  requestAnimationFrame(() => { const p = $("rail"); if (p) p.scrollTop = p.scrollHeight; });
}


// a panel card: olive label strip + rows
function card(r, label, { sub = "", cls = "" } = {}) {
  const s = el("section", "sec" + (cls ? " " + cls : ""));
  const lab = el("div", "lab", label);
  if (sub) lab.append(el("small", "", sub));
  s.append(lab);
  r.append(s);
  return s;
}
function rowFor(sec, t, { when = "" } = {}) {
  const row = el("div", "row link" + (isDone(t) ? " done" : ""));
  row.append(el("span", "sym" + (isDone(t) ? " ok" : t.priority === "urgent" ? " u" : ""), isDone(t) ? "✓" : PRI[t.priority].mark));
  if (!t.confirmed && t.status !== "done") { const q = el("span", "sym q", "?"); q.title = "size/priority guessed — click the ? on its chip to set"; row.append(q); }
  row.append(el("span", "tt", t.title));
  const s = statusLine(t);
  if (s.text !== "Not started") row.append(el("i", "", s.text));
  if (t.job) row.append(el("i", "", t.job));
  if (when) row.append(el("span", "when", when));
  row.title = tooltip(t);
  row.addEventListener("click", () => t.scheduled_date ? openDay(t.scheduled_date, t.id) : openUnscheduled(t.id));
  sec.append(row);
  return row;
}
const DAY_START = 7, DAY_END = 16; // 7 a.m. – 4 p.m.
function nowMinutes() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function workLeftText() {
  const m = nowMinutes(), end = DAY_END * 60, start = DAY_START * 60;
  if (m < start) return `starts at 7a · ${Math.round((start - m) / 60 * 10) / 10} h to go`;
  if (m >= end) return "day's over";
  const left = end - m;
  return `${Math.floor(left / 60)} h ${pad(left % 60)} m left`;
}

// which task Adam should be on right now: first open item on today in the day's order
function nextUp() {
  const today = todayISO();
  const open = tasksOn(today).filter((t) => t.status !== "done");
  const working = open.find((t) => t.status === "working");
  return working || open[0] || null;
}

function renderSkinny(r) {
  const today = todayISO();
  const todayItems = tasksOn(today);
  const open = todayItems.filter((t) => t.status !== "done");

  // 1. NEXT UP
  const nx = nextUp();
  const sNext = card(r, "Next up", { cls: "focus" });
  if (nx) {
    const row = el("div", "nx");
    row.append(el("span", "nxsym" + (nx.priority === "urgent" ? "" : " calm"), PRI[nx.priority].mark));
    const txt = el("div", "nxt");
    txt.append(el("b", "", nx.title));
    const bits = [SIZE[nx.size] || "1 hr", PRI[nx.priority].label];
    if (nx.dropdead_date) bits.push(nx.dropdead_date === today ? "drop-dead today" : "drop-dead " + fmtShort(nx.dropdead_date));
    else if (nx.target_date) bits.push("target " + fmtShort(nx.target_date));
    if (nx.promised_to) bits.push("promised to " + nx.promised_to);
    if (nx.carried > 0) bits.push(`carried ${nx.carried}×`);
    if (nx.status === "working") bits.push("working");
    txt.append(el("small", "", bits.join(" · ")));
    row.append(txt);
    row.title = tooltip(nx);
    row.addEventListener("click", () => openDay(today, nx.id));
    sNext.append(row);
    const bt = el("div", "nxbtn");
    const ok = el("button", "btn ok", "✓ Done"); ok.addEventListener("click", async () => { if (await markDone(nx)) toast(`Done: "${nx.title}" — it stays on today, faded`, { undo: true }); });
    const push = el("button", "btn push", "Push →"); push.title = "Move it to the next work day";
    push.addEventListener("click", async () => { const to = nextDay(today, 1, nx.bucket); if (await moveTask(nx, to, "Pushed from Next up")) toast(`Pushed to ${fmtShort(to)}`, { undo: true }); });
    const more = el("button", "btn", "More…"); more.addEventListener("click", () => openDay(today, nx.id));
    bt.append(ok, push, more);
    if (!nx.confirmed) { const fix = el("button", "btn", "? Set size"); fix.title = "I guessed the size and priority"; fix.addEventListener("click", () => openQuickFix(nx, fix)); bt.append(fix); }
    sNext.append(bt);
  } else {
    sNext.append(el("div", "empty", todayItems.length ? "Everything on today is done." : "Nothing on today. Quick add or tell your assistant."));
  }

  // 2. STATUS
  const overdue = state.tasks.filter((t) => visible(t) && t.status !== "done" && t.dropdead_date && t.dropdead_date < today);
  const dueToday = state.tasks.filter((t) => visible(t) && t.status !== "done" && t.dropdead_date === today);
  const overDays = [];
  for (let i = 0; i < 7; i++) { const d = iso(addDays(new Date(), i)); if (!isWeekend(d) && dayLoad(d).over && showMeetings()) overDays.push(d); }
  const parts = [];
  if (overdue.length) parts.push(`!! ${overdue.length} overdue`);
  if (dueToday.length) parts.push(`${dueToday.length} drop-dead today`);
  if (overDays.length) parts.push(`${overDays.length} day${overDays.length === 1 ? "" : "s"} over 8 h`);
  const lateBills = B.loaded ? pastDue(today).length : 0;
  if (lateBills) parts.push(`!! ${lateBills} bill${lateBills === 1 ? "" : "s"} past due`);
  const sStat = card(r, "Status");
  sStat.append(el("div", "status" + (parts.length ? "" : " ok"), parts.length ? parts.join(" · ") : "On track"));
  if (B.loaded) {   // bills: a past-due line in every view (they always get paid); the month tally only on Home / Both
    const late = pastDue(today);
    if (late.length) {
      const row = el("div", "row link bills-late");
      row.append(el("b", "", `!! ${late.length} bill${late.length === 1 ? "" : "s"} past due`), el("i", "", `${money(amountOf(late))} · $ Bills →`));
      row.title = late.map((o) => `${o.bill.name} ${money(o.bill.amount)} — due ${fmtShort(o.due)}`).join("\n");
      row.addEventListener("click", () => setBucket("bills")); sStat.append(row);
    } else if (state.bucket !== "work") {
      const d = new Date(), S = monthStats(d.getFullYear(), d.getMonth(), today), nx = nextDue(today);
      const row = el("div", "row link");
      row.append(el("b", "", `$ Bills: ${money(S.left, false)} left this month`), el("i", "", nx ? `next ${nx.bill.name} ${money(nx.bill.amount, false)} ${fmtShort(nx.due).split(",")[0]} →` : "→"));
      row.addEventListener("click", () => setBucket("bills")); sStat.append(row);
    }
  }
  const risky = state.tasks.filter((t) => visible(t) && t.status !== "done" && t.scheduled_date !== today && (
    (t.dropdead_date && t.dropdead_date < today) || (t.target_date && t.target_date < today)
  )).sort(byPriority);
  risky.slice(0, 4).forEach((t) => rowFor(sStat, t));
  const un = unscheduled();
  const inbox = el("div", "row link"); inbox.append(el("b", "", `Inbox: ${un.length} unscheduled`), el("i", "", un.length ? "give each a day →" : ""));
  inbox.addEventListener("click", () => openUnscheduled());
  sStat.append(inbox);
  doneTrashRows(sStat);
  // the last change he made here, with the way back
  if (undoStack.length) {
    const u = undoStack[undoStack.length - 1];
    const row = el("div", "row undo");
    const b = el("button", "btn sm", "↶ Undo"); b.title = "Ctrl+Z works too"; b.addEventListener("click", undoLast);
    row.append(b, el("span", "ulab", u.label));
    sStat.append(row);
  }

  // 3. TODAY — 7 to 4 timeline
  const L = dayLoad(today);
  const sToday = card(r, "Today · " + fromISO(today).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));
  if (showMeetings()) {
    const tl = el("div", "tl");
    const bar = el("div", "tlbar");
    const span = (DAY_END - DAY_START) * 60;
    timedOn(today).forEach((m) => {
      const a = new Date(m.start_at), b = new Date(m.end_at);
      const s = Math.max(0, a.getHours() * 60 + a.getMinutes() - DAY_START * 60), e = Math.min(span, b.getHours() * 60 + b.getMinutes() - DAY_START * 60);
      if (e <= 0 || s >= span) return;
      const seg = el("i", "m" + (m.attending ? "" : " inv")); seg.style.left = (s / span * 100) + "%"; seg.style.width = (Math.max(e - s, 8) / span * 100) + "%";
      seg.title = `${m.title} ${fmtTime(m.start_at)}–${fmtTime(m.end_at)}${m.attending ? "" : " (invited)"}`;
      bar.append(seg);
    });
    const nm = nowMinutes() - DAY_START * 60;
    if (nm >= 0 && nm <= span) { const now = el("i", "now"); now.style.left = (nm / span * 100) + "%"; bar.append(now); }
    tl.append(bar);
    const ticks = el("div", "tlticks"); ["7a", "8", "9", "10", "11", "12", "1", "2", "3", "4p"].forEach((x) => ticks.append(el("span", "", x))); tl.append(ticks);
    tl.append(el("div", "tlnow", `Now ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" AM", "").replace(" PM", "")} · ${workLeftText()}`));
    sToday.append(tl);
    const hrs = el("div", "row wrap");
    if (L.cap === 0 && offOn(today).length) hrs.innerHTML = `<b>Day off</b> — ${esc(offOn(today).map((m) => m.title).join(", "))}`;
    else if (L.over) hrs.innerHTML = `<b>${esc(fmtHrs(L.total))}</b> on an 8 h day — over by ${esc(fmtHrs(L.total - L.cap))}`;
    else hrs.innerHTML = `<b>${esc(fmtHrs(L.total))}</b> of 8 h booked · ${esc(fmtHrs(Math.max(0, L.free)))} free`;
    hrs.title = `Work ${fmtHrs(L.work)} + meetings you attend ${fmtHrs(L.mtg)}`;
    sToday.append(hrs);
  }
  const first = el("div", "row wrap"); first.innerHTML = `First: <b>${esc(nx ? nx.title : "—")}</b> · ${open.length} open`; sToday.append(first);

  // 4. MEETINGS
  if (showMeetings()) {
    const ms = meetingsOn(today).filter((m) => !m.all_day).sort((a, b) => a.start_at.localeCompare(b.start_at));
    const offs = offOn(today);
    if (ms.length || offs.length) {
      const sM = card(r, "Meetings", { sub: "from Outlook" });
      offs.forEach((m) => { const row = el("div", "row wrap" + (isHoliday(m) ? " holiday" : "")); row.innerHTML = `◇ <b>${esc(m.title)}</b><i>day off</i>`; sM.append(row); });
      ms.forEach((m) => {
        const row = el("div", "row link");
        row.innerHTML = `${m.attending ? "■" : "◌"} ${esc(fmtTime(m.start_at))}–${esc(fmtTime(m.end_at))} &nbsp;${esc(m.title)}<i>${m.attending ? "you go" : "invited"}</i>`;
        row.title = m.attending ? "Counts against your day. Open the day to change." : "Not counted. Open the day to say you go.";
        row.addEventListener("click", () => openDay(today));
        sM.append(row);
      });
    }
  }

  // 5. PROMISES
  const owe = state.tasks.filter((t) => visible(t) && t.status !== "done" && t.promised_to)
    .sort((a, b) => String(a.dropdead_date || a.target_date || a.scheduled_date || "9") .localeCompare(String(b.dropdead_date || b.target_date || b.scheduled_date || "9")));
  const owed = state.tasks.filter((t) => visible(t) && t.status === "waiting");
  if (owe.length || owed.length) {
    const sP = card(r, "Promises");
    owe.slice(0, 5).forEach((t) => {
      const row = el("div", "row pr link");
      const d = t.dropdead_date || t.target_date || t.scheduled_date;
      row.append(el("span", "arr", "→"), el("span", "who", `You owe ${t.promised_to}`), el("span", "what", t.title), el("span", "when", d ? fmtShort(d).replace(",", "") : "no date"));
      row.title = tooltip(t);
      row.addEventListener("click", () => t.scheduled_date ? openDay(t.scheduled_date, t.id) : openUnscheduled(t.id));
      sP.append(row);
    });
    owed.slice(0, 5).forEach((t) => {
      const row = el("div", "row pr in link");
      const days = Math.max(0, Math.round((Date.now() - new Date(t.updated_at || t.created_at)) / 86400000));
      row.append(el("span", "arr", "←"), el("span", "who", `${t.waiting_on || "Someone"} owes you`), el("span", "what", t.title), el("span", "when", `${days} d`));
      row.title = tooltip(t);
      row.addEventListener("click", () => t.scheduled_date ? openDay(t.scheduled_date, t.id) : openUnscheduled(t.id));
      sP.append(row);
    });
  }

  // 6. TASKS (today)
  const sT = card(r, `Tasks · ${open.length} open`, { sub: todayItems.length - open.length ? `${todayItems.length - open.length} done today` : "" });
  todayItems.forEach((t) => rowFor(sT, t));
  if (!todayItems.length) sT.append(el("div", "empty", "Nothing scheduled today."));
  if (state.meetingsSync) sT.append(el("div", "hint", `Outlook checked ${new Date(state.meetingsSync).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · every 15 min`));
}

// the two rows that answer "where did it go": the Done log and the Trash
function doneTrashRows(sec) {
  const dn = doneThisWeek(), tr = trashItems().length;
  const done = el("div", "row link"); done.append(el("b", "", `✓ Done log`), el("i", "", `${dn} this week · last ${TRASH_DAYS} days →`));
  done.title = "Everything you finished, by day"; done.addEventListener("click", () => openPanel("done"));
  const trash = el("div", "row link"); trash.append(el("b", "", `Trash`), el("i", "", tr ? `${tr} item${tr === 1 ? "" : "s"} · put back any time →` : "empty"));
  trash.title = "Removed items wait here " + TRASH_DAYS + " days — Put back or Delete for good"; trash.addEventListener("click", () => openPanel("trash"));
  sec.append(done, trash);
}

// ---------- Done log: what got finished, by day ----------
function renderDonePanel(r) {
  const items = doneLog();
  panelHeader(r, "Done log", `${items.length} in the last ${TRASH_DAYS} days`);
  if (!items.length) { const s = card(r, "Nothing finished yet"); s.append(el("div", "empty", "When you press ✓ Done on something, it lands here with the day and time.")); return; }
  const byDay = new Map();
  items.forEach((t) => { const k = iso(new Date(t.done_at)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); });
  const today = todayISO(), yest = iso(addDays(new Date(), -1));
  for (const [k, list] of byDay) {
    const label = k === today ? "Today" : k === yest ? "Yesterday" : fmtLong(k);
    const s = card(r, `${label} · ${list.length}`, { sub: list.map((t) => SIZE_HRS[t.size] ?? 1).reduce((a, b) => a + b, 0) + " h" });
    list.forEach((t) => {
      const row = el("div", "row link done");
      row.append(el("span", "sym ok", "✓"), el("span", "tt", t.title));
      row.append(el("i", "", whenShort(t.done_at).replace(/^\w+ /, "")));
      if (t.job) row.append(el("i", "", t.job));
      if (t.deleted_at) row.append(el("i", "", "in Trash"));
      row.title = tooltip(t) + (t.deleted_at ? " · in the Trash" : "") + " — click to open";
      row.addEventListener("click", () => t.deleted_at ? openPanel("trash", t.id) : t.scheduled_date ? openDay(t.scheduled_date, t.id) : openUnscheduled(t.id));
      s.append(row);
    });
  }
}

// ---------- Trash: removed items, put back or gone for good ----------
function renderTrashPanel(r) {
  const items = trashItems();
  panelHeader(r, "Trash", items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "empty");
  const s = card(r, "Removed items", { sub: `kept ${TRASH_DAYS} days, then deleted for good` });
  if (!items.length) s.append(el("div", "empty", "Nothing here. Remove something from a day and it waits here — Put back brings it home."));
  items.forEach((t) => {
    const c = el("div", `item p-${t.priority}` + (isDone(t) ? " is-done" : "") + (state.openId === t.id ? " selected" : ""));
    const head = el("div", "head");
    head.append(el("span", `chip p-${t.priority}`, `${PRI[t.priority].mark} ${PRI[t.priority].label}`), el("span", "title", t.title));
    if (isDone(t)) head.append(el("span", "status-pill done", "✓ Done"));
    c.append(head);
    const d = el("div", "detail");
    d.textContent = `Removed ${whenShort(t.deleted_at)} · was on ${t.scheduled_date ? fmtShort(t.scheduled_date) : "no day (inbox)"} · ${t.bucket === "home" ? "Home" : "Work"}${t.job ? " · " + t.job : ""}`;
    c.append(d);
    const a = el("div", "actions r2");
    const back = el("button", "btn sm olive", "↶ Put back"); back.title = "Back where it was" + (t.scheduled_date ? ` (${fmtShort(t.scheduled_date)})` : " (the Inbox)");
    back.addEventListener("click", async () => { if (await putBack(t)) toast(`Put back "${t.title}"` + (t.scheduled_date ? ` on ${fmtShort(t.scheduled_date)}` : " in the Inbox"), { undo: true }); });
    const gone = el("button", "btn sm danger", "Delete for good"); gone.addEventListener("click", () => deleteForGood(t));
    a.append(back, gone); c.append(a);
    s.append(c);
  });
  if (items.length > 1) {
    const foot = el("div", "actions");
    const all = el("button", "btn sm danger", `Empty trash (${items.length})`);
    all.addEventListener("click", async () => {
      if (!confirm(`Delete all ${items.length} items in the Trash for good? This can't be undone.`)) return;
      const ids = items.map((t) => t.id);
      const { error } = await db.from("fm_tasks").delete().in("id", ids);
      if (error) { toast("Couldn't empty it: " + error.message); return; }
      state.trash = state.trash.filter((t) => !ids.includes(t.id));
      db.from("fm_moves").insert({ batch_id: "app-" + todayISO(), kind: "purge", task_id: null, before: { count: ids.length, titles: items.map((t) => t.title) }, after: null, reason: "Emptied the Trash" }).then(() => {}, () => {});
      toast("Trash emptied"); render();
    });
    foot.append(all); s.append(foot);
  }
}
function openPanel(which, taskId = null) { state.panel = which; state.openId = taskId; state.editId = null; render({ now: true }); const p = $("rail"); if (p) p.scrollTop = 0; }

// ---------- PHONE ----------
// One screen at a time in the panel box; the month grid on the right is hidden. Big type,
// nothing hover-only. Tabs: Week · Month · Add · Assistant. Day / Add / Assistant reuse the
// desktop panels, so every button he knows is the same button.
function renderPhone() {
  document.querySelectorAll("#tabs button").forEach((b) => {
    const t = b.dataset.tab;
    const on = state.panel === "add" ? t === "add" : state.panel === "brain" ? t === "brain" : state.panel ? t === state.tab && t !== "add" && t !== "brain" : t === state.tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
  const r = $("rail-body");
  r.innerHTML = "";
  if (state.panel === "addbill") return renderAddBillPanel(r);
  if (state.panel === "accounts") return renderAccountsPanel(r);
  if (state.panel === "billalerts") return renderBillAlertsPanel(r);
  if (state.panel === "day" && state.selected) return billsMode() ? renderBillDayPanel(r) : renderDayPanel(r);
  if (state.panel === "unscheduled") return renderUnscheduledPanel(r);
  if (state.panel === "done") return renderDonePanel(r);
  if (state.panel === "trash") return renderTrashPanel(r);
  if (state.panel === "add") return renderAddPanel(r);
  if (state.panel === "brain") return renderBrainPanel(r);
  if (state.tab === "bills") return renderBillsPanel(r);
  if (state.tab === "month") return renderPhoneMonth(r);
  renderPhoneWeek(r);
}
function phoneTab(tab) {
  closeQuickFix();
  state.openId = null; state.editId = null;
  if (tab === "add") { state.tab = "add"; state.panel = "add"; }
  else if (tab === "brain") { state.tab = "brain"; state.panel = "brain"; }
  else { state.tab = tab; state.panel = null; state.billOpen = null; if (tab === "week") state.pWeek = null; if (tab === "month") state.pMonth = null; }
  render({ now: true });
  const rail = $("rail"); if (rail) rail.scrollTop = 0;
}
// a task as one full-width line: mark · title · the one thing that matters (est. time / promise / drop-dead / status)
function phoneChip(t) {
  const c = el("div", `pchip p-${t.priority}` + (t.planned ? " planned" : "") + (isDone(t) ? " is-done" : "") + (t.bucket === "home" ? " bucket-home" : ""));
  c.append(el("span", "sym", isDone(t) ? "✓" : PRI[t.priority].mark));
  const body = el("div", "pt");
  body.append(el("div", "ttl", t.title));
  const bits = [];
  if (isDone(t)) bits.push("done " + whenShort(t.done_at));
  else {
    if (t.dropdead_date) bits.push(t.dropdead_date === todayISO() ? "drop-dead today" : "drop-dead " + fmtShort(t.dropdead_date).replace(",", ""));
    if (t.promised_to) bits.push("promised to " + t.promised_to);
    if (t.carried > 0) bits.push(`carried ${t.carried}×`);
    if (t.status === "working") bits.push("working");
    if (t.status === "waiting") bits.push("waiting on " + (t.waiting_on || "someone"));
    bits.push((SIZE[t.size] || "1 hr") + (t.confirmed ? "" : " ?"));
  }
  body.append(el("div", "bits", bits.join(" · ")));
  c.append(body);
  c.addEventListener("click", () => openDay(t.scheduled_date, t.id));
  return c;
}
function phoneDayCard(dISO, { showEmpty = true } = {}) {
  const d = fromISO(dISO), today = todayISO();
  const offs = offOn(dISO), L = dayLoad(dISO), past = dISO < today;
  const items = tasksOn(dISO);
  const card = el("div", "pday" + (dISO === today ? " today" : "") + (offs.length ? " off" : "") + (isWeekend(dISO) ? " wk" : "") + (past ? " past" : "") + (offs.some(isHoliday) ? " holiday" : ""));
  const head = el("div", "pd-head");
  head.append(el("div", "pd-num", String(d.getDate())));
  const dow = el("div", "pd-dow");
  dow.append(el("b", "", d.toLocaleDateString("en-US", { weekday: "long" })), el("span", "", d.toLocaleDateString("en-US", { month: "short" }) + (dISO === today ? " · TODAY" : "")));
  head.append(dow);
  let load = "";
  if (offs.length && !isWeekend(dISO)) load = "OFF";
  else if (!isWeekend(dISO) && showMeetings() && !past) load = L.over ? `!! ${fmtHrs(L.total)} / 8` : L.total ? `${fmtHrs(L.total)} / 8` : "open";
  if (load) head.append(el("div", "pd-load" + (L.over ? " over" : ""), load));
  head.addEventListener("click", () => openDay(dISO));
  card.append(head);
  const body = el("div", "pd-body");
  offs.forEach((m) => body.append(meetingLine(m)));
  if (showMeetings()) {
    const ms = timedOn(dISO).sort((a, b) => a.start_at.localeCompare(b.start_at));
    ms.filter((m) => m.attending).forEach((m) => body.append(meetingLine(m)));
    const inv = ms.filter((m) => !m.attending).length;
    if (inv) { const i = el("div", "pd-inv", `◌ ${inv} invited`); i.addEventListener("click", () => openDay(dISO)); body.append(i); }
  }
  items.forEach((t) => body.append(phoneChip(t)));
  if (!items.length && !offs.length && showEmpty) body.append(el("div", "pd-empty", past ? "" : "nothing booked"));
  card.append(body);
  return card;
}
function renderPhoneWeek(r) {
  const today = todayISO();
  const sun = state.pWeek ? fromISO(state.pWeek) : weekStart(new Date());
  const sunISO = iso(sun), satISO = iso(addDays(sun, 6));
  const hasToday = today >= sunISO && today <= satISO;
  // header: ‹ Week 46 · Nov 8–14 ›  Today
  const h = el("div", "sec head pnav");
  const lab = el("div", "lab");
  const prev = el("button", "btn", "‹"); prev.setAttribute("aria-label", "Previous week"); prev.addEventListener("click", () => { state.pWeek = iso(addDays(sun, -7)); render({ now: true }); });
  const next = el("button", "btn", "›"); next.setAttribute("aria-label", "Next week"); next.addEventListener("click", () => { state.pWeek = iso(addDays(sun, 7)); render({ now: true }); });
  const ttl = el("div", "pttl");
  ttl.append(el("b", "", `Week ${isoWeek(addDays(sun, 1))}`), el("span", "", `${sun.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${addDays(sun, 6).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`));
  lab.append(prev, ttl, next);
  if (!hasToday) { const t = el("button", "btn sm", "Today"); t.addEventListener("click", () => { state.pWeek = null; render({ now: true }); }); lab.append(t); }
  h.append(lab); r.append(h);
  // NOW strip — only on the current week
  if (hasToday) {
    const nx = nextUp(), L = dayLoad(today);
    const now = el("div", "sec focus pnow");
    const l2 = el("div", "lab"); l2.append("Now", el("small", "", showMeetings() ? workLeftText() : "")); now.append(l2);
    if (offOn(today).length) now.append(el("div", "pnx", "Day off — " + offOn(today).map((m) => m.title).join(", ")));
    else if (nx) {
      const row = el("div", "pnx");
      row.append(el("span", "nxsym" + (nx.priority === "urgent" ? "" : " calm"), PRI[nx.priority].mark), el("b", "", nx.title));
      row.addEventListener("click", () => openDay(today, nx.id));
      now.append(row);
      const bt = el("div", "nxbtn");
      const ok = el("button", "btn ok", "✓ Done"); ok.addEventListener("click", async () => { if (await markDone(nx)) toast(`Done: "${nx.title}"`, { undo: true }); });
      const push = el("button", "btn push", "Push →"); push.addEventListener("click", async () => { const to = nextDay(today, 1, nx.bucket); if (await moveTask(nx, to, "Pushed from Next up")) toast(`Pushed to ${fmtShort(to)}`, { undo: true }); });
      bt.append(ok, push); now.append(bt);
    } else now.append(el("div", "pnx", tasksOn(today).length ? "Everything on today is done." : "Nothing on today."));
    if (showMeetings() && !offOn(today).length) now.append(el("div", "hint", L.over ? `!! ${fmtHrs(L.total)} on an 8 h day` : `${fmtHrs(L.total)} of 8 h booked`));
    r.append(now);
  }
  const list = el("div", "pweek");
  for (let i = 0; i < 7; i++) list.append(phoneDayCard(iso(addDays(sun, i))));
  r.append(list);
  // promises you owe this week + inbox count, short
  const un = unscheduled();
  const foot = el("div", "sec pfoot");
  const inbox = el("div", "row link"); inbox.append(el("b", "", `Inbox: ${un.length} unscheduled`), el("i", "", un.length ? "give each a day →" : "")); inbox.addEventListener("click", () => openUnscheduled()); foot.append(inbox);
  doneTrashRows(foot);
  if (undoStack.length) { const u = el("div", "row undo"); const b = el("button", "btn sm", "↶ Undo"); b.addEventListener("click", undoLast); u.append(b, el("span", "ulab", undoStack[undoStack.length - 1].label)); foot.append(u); }
  const out = el("div", "row"); const lo = el("button", "btn ghost sm", "Sign out"); lo.addEventListener("click", () => $("logout-btn").click()); out.append(lo, el("i", "", document.querySelector(".ver")?.textContent || "")); foot.append(out);
  r.append(foot);
  if (hasToday && !state.pWeek) requestAnimationFrame(() => { const t = r.querySelector(".pday.today"); if (t && t.getBoundingClientRect().top > window.innerHeight * 0.7) t.scrollIntoView({ block: "start" }); });
}
function renderPhoneMonth(r) {
  const today = todayISO();
  const first = state.pMonth ? fromISO(state.pMonth) : firstOfMonth(new Date());
  const h = el("div", "sec head pnav");
  const lab = el("div", "lab");
  const prev = el("button", "btn", "‹"); prev.setAttribute("aria-label", "Previous month"); prev.addEventListener("click", () => { state.pMonth = iso(new Date(first.getFullYear(), first.getMonth() - 1, 1)); render({ now: true }); });
  const next = el("button", "btn", "›"); next.setAttribute("aria-label", "Next month"); next.addEventListener("click", () => { state.pMonth = iso(new Date(first.getFullYear(), first.getMonth() + 1, 1)); render({ now: true }); });
  const ttl = el("div", "pttl"); ttl.append(el("b", "", first.toLocaleDateString("en-US", { month: "long", year: "numeric" })));
  lab.append(prev, ttl, next);
  if (state.pMonth) { const t = el("button", "btn sm", "Today"); t.addEventListener("click", () => { state.pMonth = null; render({ now: true }); }); lab.append(t); }
  h.append(lab); r.append(h);
  const grid = el("div", "pm");
  ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].forEach((d) => grid.append(el("div", "pm-dow", d)));
  for (let i = 0; i < first.getDay(); i++) grid.append(el("div", "pm-cell blank", ""));
  const n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= n; d++) {
    const dISO = iso(new Date(first.getFullYear(), first.getMonth(), d));
    const offs = offOn(dISO), L = dayLoad(dISO), items = tasksOn(dISO).filter((t) => t.status !== "done");
    const c = el("div", "pm-cell" + (dISO === today ? " today" : "") + (isWeekend(dISO) ? " wk" : "") + (offs.length ? " off" : "") + (offs.some(isHoliday) ? " holiday" : "") + (dISO < today ? " past" : ""));
    c.append(el("div", "n", String(d)));
    if (offs.length && !isWeekend(dISO)) c.append(el("div", "tag", offs.some(isHoliday) ? "HOL" : "OFF"));
    else if (items.length) {
      const marks = el("div", "marks");
      items.slice(0, 3).forEach((t) => marks.append(el("span", `mk p-${t.priority}`, PRI[t.priority].mark)));
      if (items.length > 3) marks.append(el("span", "more", `+${items.length - 3}`));
      c.append(marks);
      if (!isWeekend(dISO) && showMeetings()) c.append(el("div", "hrs" + (L.over ? " over" : ""), (L.over ? "!! " : "") + fmtHrs(L.total)));
    } else if (!isWeekend(dISO) && showMeetings() && L.mtg) c.append(el("div", "hrs", fmtHrs(L.mtg)));
    c.addEventListener("click", () => openDay(dISO));
    grid.append(c);
  }
  r.append(grid);
  const leg = el("div", "sec pleg");
  leg.append(el("div", "row wrap", "!! Urgent · ▲ High · ● Normal · – Low · hours = booked of 8 · HOL = holiday · OFF = PTO · tap a day to open it"));
  r.append(leg);
}

// QUICK LOOK — the date, the week, the countdown. Pinned at the top of the panel.
function renderQuickLook(r) {
  const sQ = card(r, "Quick look", { cls: "ql-card" });
  const d = new Date();
  const ql = el("div", "ql");
  const r1 = el("div", "r");
  r1.append(el("span", "huge", d.toLocaleDateString("en-US", { month: "short" }).toUpperCase()), el("span", "huge", String(d.getDate())));
  const r2 = el("div", "r r2");
  r2.append(el("span", "dowl", d.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase()), el("span", "yr", String(d.getFullYear())));
  const wk = rowWeek(weekStart(d)), wks = weeksInYear(d.getFullYear());
  const bar = el("div", "bar"); const fill = el("i"); fill.style.width = Math.round(wk / wks * 100) + "%"; bar.append(fill);
  const lab = el("div", "barlab"); lab.append(el("span", "", `WEEK ${wk} OF ${wks}`), el("span", "", `${wks - wk} LEFT`));
  const jan1 = new Date(d.getFullYear(), 0, 1), dec31 = new Date(d.getFullYear(), 11, 31);
  const doy = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - jan1) / 86400000) + 1;
  const left = Math.round((dec31 - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  const off = nextOff();
  const strip = el("div", "strip");
  const box = (n, l, title) => { const b = el("div", "box"); b.append(el("b", "", String(n)), el("small", "", l)); if (title) b.title = title; return b; };
  strip.append(box(doy, "DAY OF YR"), box(left, "DAYS LEFT"), off ? box(off.days, "TO " + off.label, off.title) : box("—", "NEXT OFF", "No holiday or PTO on the calendar yet"));
  ql.append(r1, r2, bar, lab, strip);
  sQ.append(ql);
}

// next day off on the calendar (PTO or company holiday), for the Quick look box
function nextOff() {
  const today = todayISO();
  const rows = state.meetings.filter((m) => isOff(m) && m.day > today).sort((a, b) => a.day.localeCompare(b.day));
  if (!rows.length) return null;
  const m = rows[0];
  const label = (m.title.split("—").pop() || m.title).trim().replace(/^(PTO|PCG holiday)\s*/i, "").toUpperCase().slice(0, 12);
  return { days: daysBetween(today, m.day), label: label || "OFF", title: `${m.title} · ${fmtShort(m.day)}` };
}

function panelHeader(r, title, sub) {
  const s = card(r, title, { sub });
  const x = el("button", "btn ghost sm close", isPhone() ? "‹ Back" : "✕ Close"); x.title = "Close (Esc)";
  x.addEventListener("click", closePanel);
  s.querySelector(".lab").append(x);
  s.classList.add("head");
  return s;
}

function renderDayPanel(r) {
  const d = state.selected;
  const items = tasksOn(d);
  panelHeader(r, fmtLong(d), `${items.length} item${items.length === 1 ? "" : "s"}`);
  // The one he clicked comes FIRST — expanded, outlined, at the top of the panel. No hunting.
  const picked = state.openId != null ? items.find((t) => t.id === state.openId) : null;
  if (picked) {
    const sP = card(r, "Selected", { sub: "what you clicked — work in it right here", cls: "pick" });
    sP.append(itemCard(picked));
    if (state.panelJump) { state.panelJump = false; requestAnimationFrame(() => { const p = $("rail"); if (p) p.scrollTop = 0; }); }
  }
  if (showMeetings() && !isWeekend(d)) {
    const sH = card(r, "Hours"); sH.append(loadLine(d));
    const ms = meetingsOn(d);
    if (ms.length) {
      const sM = card(r, "Meetings", { sub: "from your PCI Outlook" });
      const box = el("div", "mtgs");
      ms.sort((a, b) => (a.all_day === b.all_day ? a.start_at.localeCompare(b.start_at) : a.all_day ? -1 : 1)).forEach((m) => box.append(meetingCard(m)));
      sM.append(box);
    }
  }
  const rest = picked ? items.filter((t) => t.id !== picked.id) : items;
  const nDone = rest.filter(isDone).length;
  if (!picked || rest.length) {
    const sT = card(r, picked ? "Also on this day" : "Tasks", { sub: nDone ? `${rest.length - nDone} open · ${nDone} done — click one for detail` : "click one for detail" });
    if (!items.length) sT.append(el("div", "empty", "Nothing here yet. Quick add puts new things on this day."));
    rest.forEach((t) => sT.append(itemCard(t)));
  }
  // coming up (next 5 days)
  const soon = [];
  for (let i = 1; i <= 5; i++) { const dd = iso(addDays(fromISO(d), i)); openOn(dd).forEach((t) => soon.push(t)); }
  if (soon.length) {
    const sC = card(r, "Coming up", { sub: "next 5 days" });
    soon.slice(0, 8).forEach((t) => rowFor(sC, t, { when: fmtShort(t.scheduled_date).split(",")[0] }));
  }
}

function renderUnscheduledPanel(r) {
  const items = unscheduled();
  panelHeader(r, "Inbox · unscheduled", String(items.length));
  const sT = card(r, "Give each one a day", { sub: "open it and set Scheduled" });
  if (!items.length) sT.append(el("div", "empty", "Nothing waiting to be scheduled."));
  items.forEach((t) => sT.append(itemCard(t)));
}

// ---------- Add task panel: what · when · priority · how long · which calendar ----------
function addPick() {
  if (!state.addPick) state.addPick = { date: todayISO(), priority: "normal", size: "1h", sizeSet: false, hrs: "", bucket: null };
  return state.addPick;
}
function addBucket() { const k = addPick(); return k.bucket || (state.bucket === "both" ? "work" : state.bucket === "bills" ? "home" : state.bucket); }
// the next few days he can land work on: today, tomorrow, then the rest of the week (work skips weekends + days off)
function addDayChoices() {
  const out = [], work = addBucket() === "work";
  for (let i = 0; out.length < 6 && i < 14; i++) {
    const d = addDays(new Date(), i), dISO = iso(d);
    if (work && dayCapacity(dISO) === 0) continue;
    out.push({ date: dISO, label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}` });
  }
  return out;
}
function renderAddPanel(r) {
  const k = addPick();
  panelHeader(r, "Add task", k.date ? fmtShort(k.date) : "no date yet");
  const opt = (row, label, on, fn, title) => { const b = el("button", "o" + (on ? " on" : ""), label); b.type = "button"; if (title) b.title = title; b.addEventListener("click", () => { fn(); render({ now: true }); }); row.append(b); return b; };

  // WHAT
  const sW = card(r, "What do you want to work on?", { sub: "one per line" });
  const wrap = el("div", "addp");
  const ta = el("textarea"); ta.placeholder = voice.on && voice.key === "add" ? "Listening…" : "Miner L2 leave-outs\nC1 DWG export\n…";
  ta.value = state.addDraft || "";
  ta.addEventListener("input", () => { state.addDraft = ta.value; });
  const taWrap = el("div", "ta-wrap"); taWrap.append(ta);
  const mic = el("button", "mic" + (voice.on && voice.key === "add" ? " listening" : "")); mic.type = "button"; mic.title = voice.on ? "Press to stop" : "Speak it"; mic.setAttribute("aria-label", "Speak the list");
  mic.innerHTML = MIC_SVG;
  mic.addEventListener("click", () => voiceToggle("add"));
  taWrap.append(mic);
  wrap.append(taWrap);
  sW.append(wrap);

  // WHEN
  const sD = card(r, "When", { sub: k.date ? fmtLong(k.date) : "Inbox (no date)" });
  const days = el("div", "picks");
  addDayChoices().forEach((c) => opt(days, c.label, k.date === c.date, () => { k.date = c.date; }));
  const custom = k.date && !addDayChoices().some((c) => c.date === k.date);
  const pickD = el("button", "o date" + (custom ? " on" : ""), custom ? `▦ ${fmtShort(k.date)}` : "▦ Pick a date…"); pickD.type = "button"; pickD.title = "Opens a calendar — click any day";
  pickD.addEventListener("click", (e) => { e.stopPropagation(); openDatePop(pickD, k.date, (d) => { k.date = d; render({ now: true }); }); });
  days.append(pickD);
  opt(days, "No date", !k.date, () => { k.date = null; }, "Goes to the Inbox; give it a day later");
  sD.append(days);

  // PRIORITY
  const sP = card(r, "Priority");
  const pr = el("div", "picks");
  Object.entries(PRI).forEach(([v, d]) => opt(pr, `${d.mark} ${d.label}`, k.priority === v, () => { k.priority = v; }));
  sP.append(pr);

  // HOW LONG
  const sS = card(r, "Estimated time", { sub: k.hrs ? `${k.hrs} h — filed as ${SIZE[k.size]}` : k.sizeSet ? SIZE[k.size] : "1 hr is my guess until you pick or type it" });
  const sz = el("div", "picks");
  [["15m", "15 m"], ["1h", "1 h"], ["half", "½ day"], ["full", "Full day"]].forEach(([v, txt]) => opt(sz, txt, k.sizeSet && !k.hrs && k.size === v, () => { k.size = v; k.sizeSet = true; k.hrs = ""; }));
  const hrs = el("input", "hrs"); hrs.type = "number"; hrs.min = "0.25"; hrs.step = "0.25"; hrs.placeholder = "or type hrs"; hrs.title = "Type the hours (e.g. 2.5)"; hrs.value = k.hrs || "";
  hrs.addEventListener("input", () => { const h = Number(hrs.value); if (hrs.value && h > 0) { k.hrs = hrs.value; k.size = snapSize(h); k.sizeSet = true; } else { k.hrs = ""; k.sizeSet = false; k.size = "1h"; } sS.querySelector(".lab small").textContent = k.hrs ? `${k.hrs} h — filed as ${SIZE[k.size]}` : "1 hr is my guess until you pick or type it"; sz.querySelectorAll(".o").forEach((x) => x.classList.remove("on")); });
  sz.append(hrs);
  sS.append(sz);

  // CALENDAR
  const sB = card(r, "Calendar");
  const bk = el("div", "picks");
  opt(bk, "Work", addBucket() === "work", () => { k.bucket = "work"; });
  opt(bk, "Home", addBucket() === "home", () => { k.bucket = "home"; });
  sB.append(bk);

  // GO
  const act = el("div", "actions");
  const lines = () => (state.addDraft || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const plan = el("button", "btn primary", "Plan it with Assistant");
  plan.title = "AP files these and reshuffles the day around them";
  plan.addEventListener("click", () => {
    const v = lines(); if (!v.length) { toast("Type or say what to add first"); return; }
    const where = k.date ? `on ${fmtLong(k.date)} (${k.date})` : "in the inbox (no date yet)";
    const size = k.hrs ? `${k.hrs} h` : k.sizeSet ? SIZE[k.size] : "1 hr (my guess — leave it unconfirmed)";
    state.addDraft = "";
    askBrain(`Add to my ${addBucket()} calendar ${where}: ${v.join("; ")}. Priority ${PRI[k.priority].label}, size ${size}.${k.date ? " Pencil them in as planned and reshuffle anything else on that day that no longer fits." : ""}`);
  });
  const save = el("button", "btn", "Just add (no reshuffle)");
  save.addEventListener("click", async () => {
    const v = lines(); if (!v.length) { toast("Type or say what to add first"); return; }
    let n = 0;
    for (const line of v) {
      const p = parseQuick(line);
      const row = { title: p.title, priority: p.priority !== "normal" ? p.priority : k.priority, bucket: p.bucket || addBucket(), scheduled_date: p.date || k.date, size: k.size, confirmed: k.sizeSet, planned: true, job: p.job, source: "add" };
      if (k.hrs) row.notes = `Adam: ${k.hrs} h`;
      if (await insertTask(row)) n++;
    }
    state.addDraft = "";
    toast(`${n} added ${k.date ? "to " + fmtShort(k.date) : "to the Inbox"}`);
    render({ now: true });
  });
  act.append(plan, save);
  const go = card(r, "Go");
  go.append(act);

  if (k.date) {
    const existing = tasksOn(k.date);
    const sE = card(r, `Already booked that day — ${fmtShort(k.date)}`, { sub: `${existing.length} item${existing.length === 1 ? "" : "s"} · so you can see what you're stacking onto` });
    if (!existing.length) sE.append(el("div", "empty", "Nothing yet — the day is open."));
    existing.forEach((t) => sE.append(itemCard(t)));
  }
}

// ---------- item card ----------
function itemCard(t) {
  const card = el("div", `item p-${t.priority}` + (t.planned ? " planned" : "") + (t.status === "done" ? " is-done" : ""));
  card.dataset.id = t.id;
  const head = el("div", "head");
  const chip = el("span", `chip p-${t.priority}`, `${PRI[t.priority].mark} ${PRI[t.priority].label}`);
  const title = el("span", "title", t.title);
  const s = statusLine(t);
  const st = el("span", `status-pill ${s.cls}`, s.text);
  const caret = el("span", "caret", state.openId === t.id ? "▴" : "▾");
  head.append(chip, title);
  if (!t.confirmed && t.status !== "done") { const q = el("span", "status-pill q", "? est. time"); q.title = "Estimated time and priority were guessed by AP — open it to set them"; head.append(q); }
  head.append(st, caret);
  head.addEventListener("click", () => { state.openId = state.openId === t.id ? null : t.id; state.editId = null; render(); });
  card.append(head);

  if (state.openId === t.id) {
    if (state.editId === t.id) card.append(editForm(t));
    else {
      const d = el("div", "detail");
      const bits = [];
      if (t.job) bits.push(`<b>Job:</b> ${esc(t.job)}`);
      if (t.size) bits.push(`<b>Est. time:</b> ${esc(SIZE[t.size])}${t.confirmed ? "" : " (AP's guess)"}`);
      bits.push(`<b>Calendar:</b> ${t.bucket === "home" ? "Home" : "Work"}`);
      d.innerHTML = bits.join(" · ") + "<br>"
        + `<b>Scheduled:</b> ${t.scheduled_date ? esc(fmtShort(t.scheduled_date)) : "—"} · `
        + `<b>Target:</b> ${t.target_date ? esc(fmtShort(t.target_date)) : "—"} · `
        + `<b>Drop-dead:</b> ${t.dropdead_date ? esc(fmtShort(t.dropdead_date)) : "—"}`
        + (t.promised_to ? `<br><b>Promised to:</b> ${esc(t.promised_to)}` : "")
        + (t.nag_hours ? `<br><b>Nag:</b> every ${t.nag_hours} hr${t.nag_hours === 1 ? "" : "s"} until done` : "")
        + (t.notes ? `<br><b>Notes:</b> ${esc(t.notes)}` : "");
      card.append(d);

      const btn = (label, fn, cls = "btn sm") => { const b = el("button", cls, label); if (fn) b.addEventListener("click", fn); return b; };
      // a work task pointed at a weekend / day off lands on the next work day instead (and says so)
      const moveTo = async (want, reason) => {
        const to = landDay(want, t.bucket);
        if (await moveTask(t, to, reason + (to !== want ? ` (${fmtShort(want)} is ${whyOff(want)})` : "")))
          toast(to !== want ? `${fmtShort(want)} is ${whyOff(want)} → landed on ${fmtShort(to)}` : `Moved to ${fmtShort(to)}`, { undo: true });
      };
      // Adam's layout: row 1 = Done · → Tomorrow · → +1 week · ▦ Pick a day (4 across) · row 2 = ✎ Edit · Remove
      const r1 = el("div", "actions r4");
      if (!isDone(t)) r1.append(btn("✓ Done", async () => { if (await markDone(t)) toast(`Done: "${t.title}" — it stays on the day, faded`, { undo: true }); }, "btn sm olive"));
      else r1.append(btn("Reopen", async () => { if (await reopen(t)) toast(`Reopened "${t.title}"`, { undo: true }); }));
      { const m = btn("→ Tomorrow", () => moveTo(iso(addDays(new Date(), 1)), "Moved to tomorrow from the panel")); m.title = "Move it to tomorrow (work skips weekends and days off)"; r1.append(m); }
      { const m = btn("→ +1 week", () => moveTo(iso(addDays(t.scheduled_date ? fromISO(t.scheduled_date) : new Date(), 7)), "Pushed a week from the panel")); m.title = "Move it a week later"; r1.append(m); }
      { const c = btn("▦ Pick a day"); c.title = "Opens a calendar — click the day to move it there";
        c.addEventListener("click", (e) => { e.stopPropagation(); openDatePop(c, t.scheduled_date, async (d) => { if (await moveTask(t, d, `Moved to ${fmtShort(d)} from the panel calendar`)) toast(`Moved to ${fmtShort(d)}`, { undo: true }); }); }); r1.append(c); }
      card.append(r1);
      const r2 = el("div", "actions r2");
      { const e = btn("✎ Edit", () => { state.editId = t.id; render(); }, "btn sm primary edit"); e.title = "Change anything on this item"; r2.append(e); }
      { const x = btn("Remove", async () => { if (await removeTask(t)) toast(`Removed "${t.title}" — it's in the Trash for ${TRASH_DAYS} days`, { undo: true }); }, "btn sm danger"); x.title = "Off the calendar and into the Trash — Put back any time in the next " + TRASH_DAYS + " days"; r2.append(x); }
      card.append(r2);
      // only when they apply
      const r3 = el("div", "actions");
      if (t.status === "not_started" || t.status === "waiting") r3.append(btn("Working", () => patchTask(t, { status: "working" }, { reason: "Marked Working in the app", label: `Working on "${t.title}"` })));
      if (t.planned) r3.append(btn("Make it real", () => patchTask(t, { planned: false }, { reason: "Planned → real, in the app", label: `Make "${t.title}" real` })));
      if (!t.confirmed && t.status !== "done") { const q = btn("? Set est. time + priority"); q.addEventListener("click", (e) => { e.stopPropagation(); openQuickFix(t, q); }); r3.append(q); }
      if (r3.children.length) card.append(r3);
    }
  }
  return card;
}

function editForm(t) {
  const f = el("form", "form");
  const field = (label, name, type = "text", value = "", full = false) => {
    const l = el("label", full ? "full" : "", label);
    const i = el("input"); i.type = type; i.name = name; i.value = value ?? "";
    l.append(i); return l;
  };
  const sel = (label, name, opts, value, full = false) => {
    const l = el("label", full ? "full" : "", label);
    const s = el("select"); s.name = name;
    opts.forEach(([v, txt]) => { const o = el("option", "", txt); o.value = v; if (v === (value ?? "")) o.selected = true; s.append(o); });
    l.append(s); return l;
  };
  f.append(field("Title", "title", "text", t.title, true));
  f.append(sel("Priority", "priority", Object.entries(PRI).map(([k, v]) => [k, `${v.mark} ${v.label}`]), t.priority));
  f.append(sel("Calendar", "bucket", [["work", "Work"], ["home", "Home"]], t.bucket));
  f.append(sel("Job", "job", [["", "—"], ...state.jobs.map((j) => [j.name, j.name])], t.job || ""));
  f.append(sel("Estimated time", "size", [["", "—"], ...Object.entries(SIZE)], t.size || ""));
  { const hl = field("…or type the hours (2.5)", "hrs", "number", "", false); const hi = hl.querySelector("input"); hi.step = "0.25"; hi.min = "0.25"; hi.placeholder = "hrs"; f.append(hl); }
  f.append(field("Scheduled (on calendar)", "scheduled_date", "date", t.scheduled_date || ""));
  f.append(sel("Status", "status", Object.entries(STATUS), t.status));
  f.append(field("Target date (want it done by)", "target_date", "date", t.target_date || ""));
  f.append(field("Drop-dead date (must be done by)", "dropdead_date", "date", t.dropdead_date || ""));
  f.append(field("Promised to", "promised_to", "text", t.promised_to || ""));
  f.append(field("Waiting on (if status is Waiting)", "waiting_on", "text", t.waiting_on || ""));
  f.append(sel("Nag until done", "nag_hours", [["0", "No nag"], ["1", "Every hour"], ["2", "Every 2 hrs"], ["4", "Every 4 hrs"], ["24", "Once a day"]], String(t.nag_hours || 0)));
  const notes = el("label", "full", "Notes"); const ta = el("textarea"); ta.name = "notes"; ta.value = t.notes || ""; notes.append(ta); f.append(notes);
  const pl = el("label", "full check"); const cb = el("input"); cb.type = "checkbox"; cb.name = "planned"; cb.checked = !!t.planned; pl.append(cb, el("span", "", " Planned (dashed) — my intent for that day, the morning plan builds around it")); f.append(pl);
  // the whole date box opens the picker, not just the little icon
  f.querySelectorAll('input[type="date"]').forEach((i) => i.addEventListener("click", () => { try { i.showPicker(); } catch {} }));
  const a = el("div", "actions");
  const save = el("button", "btn primary sm", "Save"); save.type = "submit";
  const cancel = el("button", "btn sm", "Cancel"); cancel.type = "button";
  cancel.addEventListener("click", () => { state.editId = null; render(); });
  a.append(save, cancel); f.append(a);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const g = (k) => (fd.get(k) || "").toString().trim();
    const patch = {
      title: g("title") || t.title, priority: g("priority"), bucket: g("bucket"), job: g("job") || null,
      size: g("size") || null, scheduled_date: g("scheduled_date") || null, status: g("status"),
      target_date: g("target_date") || null, dropdead_date: g("dropdead_date") || null,
      promised_to: g("promised_to") || null, waiting_on: g("waiting_on") || null,
      nag_hours: Number(g("nag_hours") || 0), notes: g("notes") || null,
    };
    if (patch.status === "done" && !t.done_at) patch.done_at = new Date().toISOString();
    if (patch.status !== "done") patch.done_at = null;
    patch.planned = fd.get("planned") === "on";
    const h = Number(g("hrs"));
    if (g("hrs") && h > 0) {   // typed hours: snap to a size the calendar knows, keep the real number in the notes (one line, replaced each time)
      patch.size = snapSize(h);
      const base = (patch.notes || "").split("\n").filter((l) => !/^Adam: [\d.]+ h$/.test(l.trim())).join("\n").trim();
      patch.notes = (base ? base + "\n" : "") + `Adam: ${h} h`;
    }
    patch.confirmed = true;   // Adam looked it over — the "?" comes off
    state.editId = null;
    if (await patchTask(t, patch, { kind: patch.scheduled_date !== (t.scheduled_date || null) ? "move" : "update", reason: "Edited in the app", label: `Edit "${patch.title}"` })) toast("Saved", { undo: true });
  });
  return f;
}

// ---------- panels ----------
function openDay(dateISO, taskId = null) {
  if (!dateISO) return openUnscheduled(taskId);
  state.selected = dateISO; state.panel = "day"; state.openId = taskId; state.editId = null;
  state.panelJump = taskId != null;   // a clicked task goes to the top of the panel, scrolled into view
  render({ now: true });
}
function openUnscheduled(taskId = null) { state.panel = "unscheduled"; state.openId = taskId; state.editId = null; render(); }
function openAdd() { state.panel = "add"; state.openId = null; state.editId = null; render({ now: true }); }
function closePanel() { state.panel = null; state.openId = null; state.editId = null; state.billOpen = null; state.billDraft = null; state.billEditId = null; if (state.tab === "add" || state.tab === "brain") state.tab = "week"; render({ now: true }); }
function openBillDay(dateISO, billId = null) {
  state.selected = dateISO; state.panel = "day"; state.billOpen = billId; state.openId = null; state.editId = null;
  state.panelJump = billId != null;
  render({ now: true });
}
function setBucket(b) { state.bucket = b; localStorage.setItem("fm.bucket", b); closeBillPeek(); if (state.panel === "day") { state.panel = null; state.openId = null; state.billOpen = null; } render({ now: true }); }

// ---------- quick add parsing ----------
// "Send James layout fri !!"  → title, priority urgent, date next Friday
// "#home" → home calendar · "@miner" → job · "tomorrow"/"today"/"mon".."sun"/"10/30"
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function parseQuick(text) {
  let t = " " + text.trim() + " ";
  const out = { priority: "normal", bucket: null, job: null, date: null };
  if (/\s!!\s|\burgent\b/i.test(t)) { out.priority = "urgent"; t = t.replace(/\s!!\s/g, " ").replace(/\burgent\b/ig, " "); }
  else if (/\s!\s|\bhigh\b/i.test(t)) { out.priority = "high"; t = t.replace(/\s!\s/g, " ").replace(/\bhigh\b/ig, " "); }
  else if (/\blow\b/i.test(t)) { out.priority = "low"; t = t.replace(/\blow\b/ig, " "); }
  const bm = t.match(/#(work|home)\b/i); if (bm) { out.bucket = bm[1].toLowerCase(); t = t.replace(bm[0], " "); }
  const jm = t.match(/@([\w&-]+)/); if (jm) {
    const j = state.jobs.find((x) => x.name.toLowerCase().startsWith(jm[1].toLowerCase()));
    out.job = j ? j.name : jm[1]; t = t.replace(jm[0], " ");
  }
  const today = new Date();
  if (/\btomorrow\b/i.test(t)) { out.date = iso(addDays(today, 1)); t = t.replace(/\btomorrow\b/ig, " "); }
  else if (/\btoday\b/i.test(t)) { out.date = todayISO(); t = t.replace(/\btoday\b/ig, " "); }
  else {
    const dm = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i);
    if (dm) { const want = DOW.indexOf(dm[1].toLowerCase()); let d = addDays(today, 1); while (d.getDay() !== want) d = addDays(d, 1); out.date = iso(d); t = t.replace(dm[0], " "); }
    const nm = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (nm) { const d = new Date(today.getFullYear(), Number(nm[1]) - 1, Number(nm[2])); if (d < today) d.setFullYear(d.getFullYear() + 1); out.date = iso(d); t = t.replace(nm[0], " "); }
  }
  out.title = t.replace(/\s+/g, " ").trim();
  return out;
}

async function quickAdd(text) {
  const p = parseQuick(text);
  if (!p.title) return;
  const date = p.date || (state.panel === "day" && state.selected ? state.selected : (state.view === "day" ? iso(state.cursor) : todayISO()));
  const row = { title: p.title, priority: p.priority, bucket: p.bucket || (state.bucket === "both" ? "work" : state.bucket === "bills" ? "home" : state.bucket), job: p.job, scheduled_date: date, source: "quick" };
  const t = await insertTask(row);
  if (!t) return;
  toast(`Added to ${fmtShort(date)} — set size, target and drop-dead if it has them`);
  // open it in edit mode so target / drop-dead get asked right away
  state.selected = date; state.panel = "day"; state.openId = t.id; state.editId = t.id;
  render();
}

// ---------- voice (Web Speech API) ----------
const MIC_SVG = '<svg class="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';

// ---------- voice: ONE listener for the whole app ----------
// Press to start. Talk at your pace; pauses are fine — the browser's recognizer is
// restarted under the hood whenever it gives up. It sends by itself after SILENCE_MS
// of quiet once you've said something, or when you press again. Buttons only reflect
// the state; the state lives here, so a panel redraw never loses a session.
const SILENCE_MS = 6000;
const IDLE_MS = 30000;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { rec: null, on: false, key: null, finalText: "", interim: "", silence: null, stopTimer: null, restarts: 0 };
const voiceText = () => (voice.finalText + " " + voice.interim).replace(/\s+/g, " ").trim();
// Where the words go when he's done. quick (top bar) and brain (panel mic) are the
// same conversation; add lands in the Add task panel's list.
const toAssistant = {
  seed: () => ($("quick-input")?.value || document.querySelector(".brain-input")?.value || "").trim(),
  live: (v) => { const i = $("quick-input"); if (i) i.value = v; liveBubble(v); },
  done: (v) => { const i = $("quick-input"); if (i) i.value = ""; const j = document.querySelector(".brain-input"); if (j) j.value = ""; askBrain(v); },
};
const VOICE_TARGETS = {
  quick: toAssistant,
  brain: toAssistant,
  add: {
    seed: () => "",
    live: (v) => { const t = document.querySelector(".addp textarea"); if (t) t.placeholder = v || "Listening…"; },
    done: (v) => { const d = (state.addDraft || "").replace(/\s*$/, ""); state.addDraft = (d ? d + "\n" : "") + v; },
  },
};
function liveBubble(v) { const b = document.querySelector("#live-bubble .txt"); if (b) b.textContent = v || "…"; }
function voiceStart(key) {
  if (!SR) { toast(isPhone() ? "No mic here — use the keyboard's mic in the box, then send" : "Voice needs Chrome or Edge — type it instead"); return false; }
  if (voice.on) return false;
  const t = VOICE_TARGETS[key]; if (!t) return false;
  voice.on = true; voice.key = key; voice.finalText = (t.seed() || "").trim(); voice.interim = ""; voice.restarts = 0;
  if (key === "quick" || key === "brain") { state.panel = "brain"; state.openId = null; state.editId = null; }
  render({ now: true });
  voiceSession();
  voiceBump();
  return true;
}
function voiceSession() {
  let rec;
  try { rec = new SR(); } catch { voiceFinish(); return; }
  voice.rec = rec;
  rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    if (voice.rec !== rec) return;
    let fin = "", int = "";
    for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) fin += r[0].transcript + " "; else int += r[0].transcript; }
    if (fin) voice.finalText = (voice.finalText + " " + fin).replace(/\s+/g, " ");
    voice.interim = int; voice.restarts = 0;
    VOICE_TARGETS[voice.key].live(voiceText());
    voiceBump();
  };
  rec.onerror = (e) => {
    if (voice.rec !== rec) return;
    const code = e && e.error;
    if (code === "not-allowed" || code === "service-not-allowed") { voice.on = false; toast("Mic blocked — click the lock icon by the address bar → Microphone → Allow"); }
    else if (code === "audio-capture") { voice.on = false; toast("No microphone found"); }
    else if (code === "network") { voice.on = false; toast("Speech service hiccup — press and try again"); }
    // no-speech / aborted: the restart in onend handles it
  };
  rec.onend = () => {
    if (voice.rec !== rec) return;
    voice.rec = null; clearTimeout(voice.stopTimer);
    if (!voice.on) { voiceFinish(); return; }
    if (++voice.restarts > 20) { voiceFinish(); return; }   // something is wrong; send what we have
    try { voiceSession(); } catch { voiceFinish(); }
  };
  try { rec.start(); } catch { voice.rec = null; voiceFinish(); }
}
// quiet for SILENCE_MS after he's said something → send; nothing heard at all for IDLE_MS → give up
function voiceBump() {
  clearTimeout(voice.silence);
  const heard = !!voice.finalText.trim();
  voice.silence = setTimeout(() => {
    if (!voice.on) return;
    if (!heard && !voice.finalText.trim()) toast("Didn't hear anything — press and try again");
    voiceStop();
  }, heard ? SILENCE_MS : IDLE_MS);
}
function voiceStop() {
  if (!voice.on) return;
  voice.on = false; clearTimeout(voice.silence);
  const r = voice.rec;
  if (!r) { voiceFinish(); return; }
  try { r.stop(); } catch { voiceFinish(); return; }
  // the browser normally answers stop() with onend; if it doesn't, send what we have anyway
  clearTimeout(voice.stopTimer);
  voice.stopTimer = setTimeout(() => { if (voice.rec === r) voiceFinish(); }, 1500);
}
function voiceFinish() {
  clearTimeout(voice.silence); clearTimeout(voice.stopTimer);
  voice.on = false; voice.rec = null;
  const v = voiceText(), key = voice.key;
  voice.finalText = ""; voice.interim = ""; voice.key = null;
  if (v && key && VOICE_TARGETS[key]) VOICE_TARGETS[key].done(v);
  render({ now: true });
}
function voiceToggle(key) { if (voice.on) voiceStop(); else voiceStart(key); }
// tiny handle for checking the voice state from the console / tests
window.AP = { get voice() { return { on: voice.on, key: voice.key, text: voiceText(), restarts: voice.restarts }; }, get brain() { return { busy: brain.busy, queued: brain.queue.length, log: brain.log.length }; }, get panel() { return state.panel; } };

function initMic() {
  // one button: press → listen; press again → send; typed text in the box → send
  const btn = $("tell-btn"), inp = $("quick-input");
  btn.addEventListener("click", () => {
    if (voice.on) { voiceStop(); return; }
    const v = inp.value.trim();
    if (v) { inp.value = ""; askBrain(v); return; }
    voiceStart("quick");
  });
}

// ---------- full screen ----------
function initFullscreen() {
  const btn = $("full-btn");
  const sync = () => { btn.textContent = document.fullscreenElement ? "⛶ Exit full screen" : "⛶ Full screen"; };
  btn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast("Full screen not available here"));
  });
  document.addEventListener("fullscreenchange", sync);
  sync();
}


// ============================================================
//  APP MODE — own window, badge, pop-up alerts, mini mode
// ============================================================
const MINI_ONLY = new URLSearchParams(location.search).get("mini") === "1";
if (MINI_ONLY) document.body.classList.add("mini-only");

// ---- install (own window) ----
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("install-btn").classList.remove("hidden"); });
window.addEventListener("appinstalled", () => { installEvt = null; $("install-btn").classList.add("hidden"); toast("Installed — open AP Personal Assistant from your Start menu or taskbar"); });
function initInstall() {
  $("install-btn").addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => {});
  });
}

// ---- badge: urgent not done + overdue drop-deads ----
function badgeCount() {
  const today = todayISO();
  return state.tasks.filter((t) => t.status !== "done" && (
    (t.priority === "urgent" && (!t.scheduled_date || t.scheduled_date <= today)) ||
    (t.dropdead_date && t.dropdead_date <= today))).length + (B.loaded ? pastDue(today).length : 0);
}
function updateBadge() {
  if (!("setAppBadge" in navigator)) return;
  const n = badgeCount();
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---- pop-up alerts (while an AP window is open, even minimized) ----
const alertsOn = () => ("Notification" in window) && Notification.permission === "granted" && localStorage.getItem("fm.alerts") !== "off";
function syncAlertsBtn() {
  const b = $("alerts-btn"); if (!b) return;
  if (!("Notification" in window)) { b.textContent = "Alerts: n/a"; b.disabled = true; return; }
  b.textContent = alertsOn() ? "Alerts: on" : (Notification.permission === "denied" ? "Alerts: blocked" : "Alerts: off");
}
async function notify(title, body, tag) {
  if (!alertsOn()) return;
  const opts = { body, tag, icon: "icons/icon.svg", badge: "icons/icon.svg", renotify: false, silent: false };
  try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(title, opts); }
  catch { try { new Notification(title, opts); } catch {} }
}
const firedKey = () => "fm.fired." + todayISO();
const fired = () => { try { return new Set(JSON.parse(localStorage.getItem(firedKey()) || "[]")); } catch { return new Set(); } };
function markFired(k) { const s = fired(); s.add(k); localStorage.setItem(firedKey(), JSON.stringify([...s])); }
function alertTick() {
  if (!alertsOn() || MINI_ONLY) return;
  const now = Date.now(), today = todayISO(), done = fired();
  const once = (k, fn) => { if (!done.has(k)) { markFired(k); fn(); } };
  // meetings you go to: 15-min heads-up, then at start
  state.meetings.filter((m) => m.day === today && m.attending && !m.all_day).forEach((m) => {
    const mins = (new Date(m.start_at) - now) / 60000;
    if (mins <= 15 && mins > 10) once("m15:" + m.id, () => notify("In 15 min — " + m.title, fmtTime(m.start_at) + " · " + fmtTime(m.end_at), "mtg-" + m.id));
    if (mins <= 0 && mins > -3) once("m0:" + m.id, () => notify("Now — " + m.title, "until " + fmtTime(m.end_at), "mtg-" + m.id));
  });
  const h = new Date().getHours(), mn = new Date().getMinutes();
  // 7:00 — anything with a drop-dead today
  const dd = state.tasks.filter((t) => t.status !== "done" && t.dropdead_date === today);
  if (h >= 7 && dd.length) once("dd:" + today, () => notify(`Drop-dead today: ${dd.length}`, dd.map((t) => "• " + t.title).join("\n"), "dd"));
  // bills: each one `remind_days` before it is due and on the due day; anything past due every morning — once a day each
  if (h >= 7 && B.loaded) {
    dueWithin(today, 7).forEach((o) => {
      const dl = daysBetween(today, o.due);
      if (dl > (o.bill.remind_days ?? 2)) return;
      const pays = acctLabel(o.bill.account_id);
      once(`bill:${o.bill.id}:${o.due}`, () => notify(dl === 0 ? `Bill due today — ${o.bill.name} ${money(o.bill.amount)}` : `Bill due ${fmtShort(o.due).split(",")[0]} — ${o.bill.name} ${money(o.bill.amount)}`, (pays ? "pays from " + pays + " · " : "") + "$ Bills → Paid ✓ when it's done", "bill-" + o.bill.id));
    });
    const late = pastDue(today);
    if (late.length) once("bills-late:" + late.length, () => notify(`!! ${late.length} bill${late.length === 1 ? "" : "s"} past due — ${money(amountOf(late))}`, late.slice(0, 4).map((o) => `• ${o.bill.name} ${money(o.bill.amount)} (${daysLate(o.due, today)} d)`).join("\n"), "bills-late"));
  }
  // nags: every nag_hours from 7 a.m. until done, work hours only
  if (h >= 7 && h < 16) state.tasks.filter((t) => t.status !== "done" && t.nag_hours > 0 && t.scheduled_date && t.scheduled_date <= today).forEach((t) => {
    const slot = Math.floor((h - 7 + mn / 60) / t.nag_hours);
    once(`nag:${t.id}:${slot}`, () => notify(PRI[t.priority].mark + " " + t.title, (t.nag_hours === 24 ? "Daily reminder" : `Nag every ${t.nag_hours} h`) + (t.promised_to ? " · promised to " + t.promised_to : ""), "nag-" + t.id));
  });
}
function initAlerts() {
  const b = $("alerts-btn"); if (!b) return;
  syncAlertsBtn();
  b.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") { toast("Blocked in the browser — click the lock icon by the address bar → Notifications → Allow"); return; }
    if (Notification.permission !== "granted") {
      const r = await Notification.requestPermission();
      if (r !== "granted") { syncAlertsBtn(); return; }
      localStorage.setItem("fm.alerts", "on"); syncAlertsBtn(); notify("AP alerts are on", "Meetings 15 min ahead, nags, drop-deads.", "hello"); return;
    }
    localStorage.setItem("fm.alerts", alertsOn() ? "off" : "on"); syncAlertsBtn();
    toast(alertsOn() ? "Alerts on" : "Alerts off");
  });
  setInterval(alertTick, 60 * 1000);
  setTimeout(alertTick, 4000);
}

// ---- mini mode: small always-on-top "today" window ----
let miniWin = null;
function renderMini(root) {
  const host = root || (miniWin && miniWin.document.getElementById("mini-root"));
  if (!host) return;
  const today = todayISO();
  const items = state.tasks.filter((t) => t.scheduled_date === today).sort(dayOrder);
  const open = items.filter((t) => t.status !== "done");
  const L = dayLoad(today);
  host.innerHTML = "";
  host.classList.remove("hidden");
  const h4 = el("h4"); h4.append(el("span", "", "Today"), el("small", "", `${fmtShort(today)} · ${open.length} left · ${fmtHrs(L.total)}/8`));
  host.append(h4);
  const now = Date.now();
  const mtgs = timedOn(today).filter((m) => m.attending && new Date(m.end_at) > now);
  mtgs.slice(0, 3).forEach((m, i) => {
    const n = el("div", "mtg going" + (i === 0 ? " next" : ""), `■ ${fmtTime(m.start_at)} ${m.title}`);
    host.append(n);
  });
  if (!items.length) host.append(el("div", "empty", "Nothing on today."));
  items.forEach((t) => {
    const r = el("div", `mrow p-${t.priority}` + (t.status === "done" ? " done" : ""));
    r.append(el("span", "", PRI[t.priority].mark), el("span", "t", t.title), el("span", "sz", SIZE[t.size] || ""));
    const b = el("button", "", t.status === "done" ? "Reopen" : "✓ Done");
    b.addEventListener("click", () => (t.status === "done" ? reopen(t) : markDone(t)));
    r.append(b);
    host.append(r);
  });
  const tmr = state.tasks.filter((t) => t.scheduled_date === iso(addDays(new Date(), 1)) && t.status !== "done").length;
  const foot = el("div", "foot"); foot.append(el("span", "", `Tomorrow: ${tmr} item${tmr === 1 ? "" : "s"}`), el("span", "", `Urgent/overdue: ${badgeCount()}`));
  host.append(foot);
}
async function openMini() {
  if (miniWin && !miniWin.closed) { try { miniWin.focus(); } catch {} return; }
  if ("documentPictureInPicture" in window) {
    try {
      miniWin = await documentPictureInPicture.requestWindow({ width: 360, height: 460 });
      [...document.styleSheets].forEach((ss) => { try { const l = miniWin.document.createElement("link"); l.rel = "stylesheet"; l.href = ss.href; if (ss.href) miniWin.document.head.append(l); } catch {} });
      const root = miniWin.document.createElement("div"); root.id = "mini-root"; root.className = "miniwin";
      miniWin.document.body.style.margin = "0"; miniWin.document.body.append(root);
      miniWin.addEventListener("pagehide", () => { miniWin = null; });
      renderMini(root);
      return;
    } catch { miniWin = null; }
  }
  // Fallback: a small popup running AP in mini-only mode (not always-on-top)
  miniWin = window.open(location.pathname + "?mini=1", "fm-mini", "popup,width=360,height=460");
}
function initMini() { const b = $("mini-btn"); if (b) b.addEventListener("click", openMini); }

// ============================================================
//  BILLS — the $ Bills view (month grid of bill chips), the hover summary on the
//  button, the panel (tally · past due · due soon · later · paid · accounts),
//  bill cards with Paid ✓ / Edit / Photo / Remove, add + edit, accounts, phone alerts.
//  Data layer: bills.js. Rule: a bill is paid only when Adam says so (Paid ✓, the
//  Assistant, or Claude on his word) — nothing marks itself paid.
// ============================================================
const RECUR = { monthly: "Every month", biweekly: "Every 2 weeks", yearly: "Every year", once: "One time" };
const REMIND = [[0, "Due day"], [1, "1 day"], [2, "2 days"], [3, "3 days"], [7, "1 week"]];

function billLogo(b, cls = "logo") {
  const url = logoUrl(b.domain);
  if (!url) return el("span", "ini" + (cls.includes("big") ? " big" : ""), initials(b.name));
  const img = el("img", cls); img.src = url; img.alt = ""; img.loading = "lazy";
  img.addEventListener("error", () => img.replaceWith(el("span", "ini" + (cls.includes("big") ? " big" : ""), initials(b.name))), { once: true });
  return img;
}
function lateWord(o, today) { const n = daysLate(o.due, today); return `${n} day${n === 1 ? "" : "s"} LATE`; }

// a bill on a day of the month grid: logo · name · $. Paid = ✓ faded. Late = red dashed + LATE. Due today = DUE.
function billChip(o) {
  const today = todayISO(), st = statusOf(o.bill, o.due, today);
  const c = el("div", "bchip st-" + st);
  if (st === "paid") c.append(el("span", "ok", "✓"));
  c.append(billLogo(o.bill), el("span", "nm", o.bill.name), el("span", "amt", money(o.bill.amount, false)));
  if (st === "late") c.append(el("span", "tag", "LATE"));
  else if (st === "today") c.append(el("span", "tag", "DUE"));
  const pays = acctLabel(o.bill.account_id);
  c.title = `${o.bill.name} · ${money(o.bill.amount)} · due ${fmtShort(o.due)}` + (st === "paid" ? ` · paid ${whenShort(paymentFor(o.bill, o.due).paid_at)}` : st === "late" ? ` · ${lateWord(o, today)}` : "") + (pays ? ` · pays from ${pays}` : "") + " · click to open";
  c.dataset.bill = o.bill.id; c.dataset.due = o.due;
  c.addEventListener("click", (e) => { e.stopPropagation(); openBillDay(o.due, o.bill.id); });
  return c;
}

// a day cell in $ Bills mode: bill chips + the day's total; past days say PAID or N LATE
function billDayCell(d, { other = false, max = 4, fit = 0 } = {}) {
  const dISO = iso(d), today = todayISO();
  const cell = el("div", "day bills");
  if (other) cell.classList.add("other");
  if (isWeekend(dISO)) cell.classList.add("weekend");
  const isToday = dISO === today;
  if (isToday) cell.classList.add("today"); else if (dISO < today) cell.classList.add("past");
  if (dISO === state.selected && state.panel === "day") cell.classList.add("selected");
  const occ = occOn(dISO);
  const num = el("div", "num");
  const numLabel = el("span", "", String(d.getDate()));
  if (isToday) numLabel.append(el("b", "today-tag", "TODAY"));
  num.append(numLabel);
  if (occ.length) {
    const nLate = occ.filter((o) => statusOf(o.bill, o.due, today) === "late").length;
    const tot = el("span", "count money" + (nLate ? " late" : ""), money(amountOf(occ), false));
    tot.title = `${occ.length} bill${occ.length === 1 ? "" : "s"} · ${money(amountOf(occ))}${nLate ? ` · ${nLate} LATE` : ""}`;
    num.append(tot);
  }
  cell.append(num);
  let show = Math.min(occ.length, fit ? Math.max(1, fit) : 99, max + 1);
  if (occ.length > show) show = Math.max(0, show - 1);
  occ.slice(0, show).forEach((o) => cell.append(billChip(o)));
  if (occ.length > show) { const m = el("div", "more", `+${occ.length - show} more`); m.title = occ.slice(show).map((o) => `${o.bill.name} ${money(o.bill.amount, false)}`).join("\n"); cell.append(m); }
  if (!isToday && dISO < today && occ.length) {
    const nLate = occ.filter((o) => statusOf(o.bill, o.due, today) === "late").length;
    const st = el("span", "stamp" + (nLate ? " open" : ""), nLate ? `${nLate} LATE` : "PAID");
    st.title = nLate ? `${nLate} bill${nLate === 1 ? "" : "s"} on this day not marked paid` : "Everything due this day is marked paid";
    cell.append(st);
  }
  cell.addEventListener("click", () => openBillDay(dISO));
  return cell;
}

// Paid ✓ and its undo — the two things he presses most
async function doPay(o, { source = "app" } = {}) {
  const r = await markPaid(db, o.bill, o.due, { source });
  if (r !== true) { toast("Couldn't save: " + r); return false; }
  pushUndo(`Paid "${o.bill.name}"`, async () => (await unmarkPaid(db, o.bill, o.due)) === true);
  toast(`Paid ✓ ${o.bill.name} — ${money(o.bill.amount)}`, { undo: true });
  render({ now: true });
  return true;
}
async function doUnpay(o) {
  const r = await unmarkPaid(db, o.bill, o.due);
  if (r !== true) { toast("Couldn't save: " + r); return false; }
  pushUndo(`Un-paid "${o.bill.name}"`, async () => (await markPaid(db, o.bill, o.due)) === true);
  toast(`${o.bill.name} is back to unpaid`, { undo: true });
  render({ now: true });
  return true;
}

// one bill, one line: logo · name + when · $ · Paid ✓
function billRow(o, { when = true } = {}) {
  const today = todayISO(), st = statusOf(o.bill, o.due, today);
  const row = el("div", "brow st-" + st);
  row.append(billLogo(o.bill));
  const tt = el("span", "tt"); tt.append(el("b", "", o.bill.name));
  const bits = [];
  if (when) bits.push(fromISO(o.due).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  if (st === "late") bits.push(lateWord(o, today));
  else if (st === "today") bits.push("DUE TODAY");
  else if (st === "paid") bits.push("paid " + whenShort(paymentFor(o.bill, o.due).paid_at));
  if (o.bill.autopay && st !== "paid") bits.push("autopay");
  const al = acctLabel(o.bill.account_id); if (al && st !== "paid") bits.push(al);
  tt.append(el("small", "", bits.join(" · ")));
  row.append(tt, el("span", "amt", money(o.bill.amount)));
  const btn = el("button", "btn sm " + (st === "paid" ? "ghost" : "pay"), st === "paid" ? "undo" : "Paid ✓");
  btn.title = st === "paid" ? "Mark it unpaid again" : "Mark this one paid (Undo if you slip)";
  btn.addEventListener("click", (e) => { e.stopPropagation(); st === "paid" ? doUnpay(o) : doPay(o); });
  row.append(btn);
  row.title = `${o.bill.name} · ${money(o.bill.amount)} · due ${fmtShort(o.due)} — click to open`;
  row.addEventListener("click", () => openBillDay(o.due, o.bill.id));
  return row;
}

// the panel in $ Bills mode: tally first, then past due, due soon, later, paid, accounts
function renderBillsPanel(r) {
  const today = todayISO();
  const cur = isPhone() ? new Date() : state.cursor;
  const y = cur.getFullYear(), m = cur.getMonth();
  const S = monthStats(y, m, today), late = pastDue(today), week = dueWithin(today, 7);
  const monthName = cur.toLocaleDateString("en-US", { month: "long" });
  // 1. TALLY
  const sT = card(r, `Bills · ${monthName}`, { sub: `${S.nPaid} of ${S.nTotal} paid`, cls: "focus bq-card" });
  const bq = el("div", "bq");
  const top = el("div", "top"); top.append(el("span", "huge", money(S.left, false)), el("span", "of", `of ${money(S.total, false)}`)); bq.append(top);
  bq.append(el("div", "lbl", `LEFT TO PAY IN ${monthName.toUpperCase()}`));
  const bar = el("div", "bar"); const fill = el("i"); fill.style.width = S.pct + "%"; bar.append(fill); bq.append(bar);
  const bl = el("div", "barlab"); bl.append(el("span", "", `${S.pct}% PAID`), el("span", "", `${money(S.paid, false)} DONE`)); bq.append(bl);
  const strip = el("div", "strip");
  const box = (n, l, cls, title) => { const b = el("div", "box" + (cls ? " " + cls : "")); b.append(el("b", "", String(n)), el("small", "", l)); if (title) b.title = title; return b; };
  strip.append(
    box(late.length, "PAST DUE", late.length ? "late" : "", late.length ? money(amountOf(late)) + " not marked paid" : "Nothing past due"),
    box(week.length, "DUE IN 7 DAYS", "", week.length ? money(amountOf(week)) : "Nothing due this week"),
    box(money(amountOf(late) + amountOf(week), false), "NEEDED NOW", "", "Past due + the next 7 days"));
  bq.append(strip); sT.append(bq);
  // 2. PAST DUE — always first, always loud
  if (late.length) { const sL = card(r, "!! Past due", { sub: `${money(amountOf(late))} · not marked paid`, cls: "late" }); late.forEach((o) => sL.append(billRow(o))); }
  // 3. DUE IN THE NEXT 7 DAYS
  const sW = card(r, "Due in the next 7 days", { sub: week.length ? money(amountOf(week)) : "" });
  if (!week.length) sW.append(el("div", "empty", "Nothing due in the next 7 days."));
  week.forEach((o) => sW.append(billRow(o)));
  // 4. LATER THIS MONTH
  const later = [...S.soon, ...S.open].filter((o) => !week.some((w) => w.bill.id === o.bill.id && w.due === o.due) && o.due >= today).sort((a, b) => a.due.localeCompare(b.due));
  if (later.length) { const sO = card(r, `Later in ${monthName}`, { sub: money(amountOf(later)) }); later.forEach((o) => sO.append(billRow(o))); }
  // 5. PAID
  const sP = card(r, `Paid in ${monthName}`, { sub: S.paidList.length ? `${S.paidList.length} · ${money(S.paid)}` : "" });
  if (!S.paidList.length) sP.append(el("div", "empty", "Nothing marked paid yet this month."));
  S.paidList.slice().sort((a, b) => b.due.localeCompare(a.due)).forEach((o) => sP.append(billRow(o)));
  // 6. ACCOUNTS — what comes out of each one this month
  renderAccountsCard(r, y, m);
  // 7. buttons
  const act = el("div", "sec actions-row");
  const add = el("button", "btn primary sm", "+ Add bill"); add.addEventListener("click", () => openAddBill());
  const acc = el("button", "btn sm", "Accounts"); acc.addEventListener("click", () => openPanel("accounts"));
  const al = el("button", "btn sm", "Phone alerts"); al.title = "Your bills as a calendar on iPhone / Apple Watch, with alerts before each due date"; al.addEventListener("click", () => openPanel("billalerts"));
  act.append(add, acc, al); r.append(act);
  if (!B.bills.length) { const sE = card(r, "No bills yet"); sE.append(el("div", "empty", "Press + Add bill. Name, amount, due date — the rest is optional.")); }
}

function renderAccountsCard(r, y, m) {
  if (!B.accounts.length && !B.bills.some((b) => b.account_id)) return;
  const sA = card(r, "Accounts", { sub: "what each one pays this month" });
  const occ = monthStats(y, m, todayISO());
  const all = [...occ.late, ...occ.soon, ...occ.open, ...occ.paidList];
  const rowFor = (label, list, cls = "") => {
    const row = el("div", "acct" + (cls ? " " + cls : ""));
    const left = list.filter((o) => !paymentFor(o.bill, o.due)).reduce((a, o) => a + o.bill.amount, 0);
    row.append(el("b", "", label), el("i", "", list.length ? `${list.length} bill${list.length === 1 ? "" : "s"} · ${money(amountOf(list), false)}${left ? ` · ${money(left, false)} still to pay` : " · all paid"}` : "nothing this month"));
    return row;
  };
  B.accounts.forEach((a) => sA.append(rowFor(acctLabel(a.id, { full: true }), all.filter((o) => o.bill.account_id === a.id))));
  const none = all.filter((o) => !o.bill.account_id);
  if (none.length) { const row = rowFor("? No account set", none, "none"); row.title = "Open each bill → Edit → Pays from"; sA.append(row); }
  sA.addEventListener("click", () => openPanel("accounts"));
}

// a bill opened in the panel: everything about it + the buttons
function billCard(o) {
  const b = o.bill, today = todayISO(), st = statusOf(b, o.due, today);
  const c = el("div", "item bill st-" + st); c.dataset.bill = b.id;
  const head = el("div", "head");
  head.append(billLogo(b, "logo big"), el("span", "title", b.name), el("span", "bamt", money(b.amount)));
  const pill = el("span", "status-pill " + (st === "late" ? "overdue" : st === "paid" ? "done" : st === "today" || st === "soon" ? "warn" : ""),
    st === "paid" ? "✓ Paid" : st === "late" ? `!! ${lateWord(o, today)}` : st === "today" ? "DUE TODAY" : `Due ${fmtShort(o.due).replace(",", "")}`);
  head.append(pill);
  c.append(head);
  const p = paymentFor(b, o.due);
  const dt = el("div", "detail");
  dt.innerHTML = `<b>Due:</b> ${esc(fmtShort(o.due))} · <b>Repeats:</b> ${esc(RECUR[b.recur] || b.recur)} · <b>Remind:</b> ${b.remind_days === 0 ? "on the day" : `${b.remind_days} day${b.remind_days === 1 ? "" : "s"} before`}`
    + `<br><b>Pays from:</b> ${esc(acctLabel(b.account_id, { full: true }) || "— not set")}${b.autopay ? " · <b>Autopay</b>" : ""}`
    + (b.domain ? ` · <b>Site:</b> <a href="https://${esc(b.domain)}" target="_blank" rel="noopener">${esc(b.domain)}</a>` : "")
    + (p ? `<br><b>Paid:</b> ${esc(whenShort(p.paid_at))}${p.source && p.source !== "app" ? ` (${esc(p.source)})` : ""}${p.note ? " · " + esc(p.note) : ""}` : "")
    + (b.ended_on ? `<br><b>Ends:</b> ${esc(fmtShort(b.ended_on))}` : "")
    + (b.notes ? `<br><b>Notes:</b> ${esc(b.notes)}` : "");
  c.append(dt);
  if (b.photo) { const ph = el("div", "bphoto"); const img = el("img"); img.src = b.photo; img.alt = b.name + " bill"; img.title = "Open full size"; img.addEventListener("click", (e) => { e.stopPropagation(); const w = window.open("", "_blank"); if (w) { w.document.write(`<title>${esc(b.name)}</title><img src="${b.photo}" style="max-width:100%">`); w.document.close(); } }); ph.append(img); c.append(ph); }
  const btn = (label, fn, cls = "btn sm") => { const x = el("button", cls, label); x.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return x; };
  const r1 = el("div", "actions r3");
  r1.append(st === "paid" ? btn("Undo paid", () => doUnpay(o)) : btn("✓ Paid", () => doPay(o), "btn sm olive"));
  r1.append(btn("✎ Edit", () => openAddBill(b), "btn sm primary edit"));
  r1.append(btn(b.photo ? "📷 New photo" : "📷 Add photo", () => pickBillPhoto(b)));
  c.append(r1);
  const r2 = el("div", "actions r2");
  r2.append(btn("Remove bill", async () => {
    if (!confirm(`Remove "${b.name}" from your bills?\nIt goes to the Trash (Undo brings it back); paid history stays.`)) return;
    const res = await removeBill(db, b);
    if (res !== true) { toast("Couldn't remove: " + res); return; }
    pushUndo(`Remove bill "${b.name}"`, async () => (await restoreBill(db, b.id)) === true);
    toast(`Removed ${b.name}`, { undo: true });
    closePanel();
  }, "btn sm danger"));
  if (b.photo) r2.append(btn("Remove photo", async () => { const res = await saveBill(db, { photo: null }, b.id); if (typeof res === "string") { toast("Couldn't save: " + res); return; } toast("Photo removed"); render({ now: true }); }));
  c.append(r2);
  return c;
}

// the day panel in $ Bills mode: the bill he clicked first, then the rest of the day, then what's coming
function renderBillDayPanel(r) {
  const d = state.selected, occ = occOn(d);
  panelHeader(r, fmtLong(d), `${occ.length} bill${occ.length === 1 ? "" : "s"}${occ.length ? " · " + money(amountOf(occ)) : ""}`);
  const picked = state.billOpen != null ? occ.find((o) => o.bill.id === state.billOpen) : null;
  if (picked) {
    const sP = card(r, "Selected", { sub: "what you clicked — work in it right here", cls: "pick" });
    sP.append(billCard(picked));
    if (state.panelJump) { state.panelJump = false; requestAnimationFrame(() => { const p = $("rail"); if (p) p.scrollTop = 0; }); }
  }
  const rest = picked ? occ.filter((o) => o !== picked) : occ;
  if (!picked || rest.length) {
    const sT = card(r, picked ? "Also due this day" : "Bills due", { sub: rest.length ? "click one for detail" : "" });
    if (!occ.length) sT.append(el("div", "empty", "No bills due this day."));
    rest.forEach((o) => sT.append(billCard(o)));
  }
  const soon = dueWithin(d, 10).filter((o) => o.due > d);
  if (soon.length) { const sC = card(r, "Coming up", { sub: "next 10 days" }); soon.slice(0, 8).forEach((o) => sC.append(billRow(o))); }
  const act = el("div", "sec actions-row");
  const add = el("button", "btn primary sm", `+ Add bill due ${fmtShort(d).split(",")[1]?.trim() || fmtShort(d)}`); add.addEventListener("click", () => openAddBill({ anchor_date: d }));
  act.append(add); r.append(act);
}

// ---------- the hover summary on the $ Bills button ----------
let peekEl = null, peekTimer = null;
function closeBillPeek() { clearTimeout(peekTimer); if (peekEl) { peekEl.remove(); peekEl = null; } }
function scheduleClosePeek() { clearTimeout(peekTimer); peekTimer = setTimeout(closeBillPeek, 260); }
function openBillPeek(anchor) {
  clearTimeout(peekTimer);
  if (peekEl || !B.loaded) return;
  const today = todayISO(), d = new Date();
  const S = monthStats(d.getFullYear(), d.getMonth(), today), late = pastDue(today), week = dueWithin(today, 7);
  const p = el("div", "pop billpeek");
  const h = el("div", "ttl"); h.append(el("b", "", d.toLocaleDateString("en-US", { month: "long" })), ` · ${money(S.left, false)} left of ${money(S.total, false)} · ${S.nPaid} of ${S.nTotal} paid`); p.append(h);
  const peekRow = (o) => {
    const st = statusOf(o.bill, o.due, today);
    const row = el("div", "pr st-" + st);
    row.append(billLogo(o.bill), el("span", "nm", o.bill.name), el("span", "wh", st === "late" ? lateWord(o, today) : st === "today" ? "DUE TODAY" : fmtShort(o.due).split(",")[0]), el("span", "amt", money(o.bill.amount, false)));
    const b = el("button", "btn sm pay", "Paid ✓"); b.addEventListener("click", (e) => { e.stopPropagation(); doPay(o); closeBillPeek(); }); row.append(b);
    row.addEventListener("click", () => { closeBillPeek(); setBucket("bills"); openBillDay(o.due, o.bill.id); });
    return row;
  };
  if (late.length) { p.append(el("div", "ph late", `!! PAST DUE · ${money(amountOf(late))}`)); late.slice(0, 4).forEach((o) => p.append(peekRow(o))); if (late.length > 4) p.append(el("div", "hint", `+${late.length - 4} more past due`)); }
  p.append(el("div", "ph", `DUE IN 7 DAYS · ${money(amountOf(week))}`));
  if (!week.length) p.append(el("div", "empty", "Nothing due this week."));
  week.slice(0, 6).forEach((o) => p.append(peekRow(o)));
  p.append(el("div", "hint", "Click $ Bills for the full view"));
  p.addEventListener("mouseenter", () => clearTimeout(peekTimer));
  p.addEventListener("mouseleave", scheduleClosePeek);
  p.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(p);
  placePop(p, anchor, 340, 280);
  peekEl = p;
}

// ---------- add / edit a bill ----------
function billDraft() {
  if (!state.billDraft) state.billDraft = { name: "", domain: "", amount: "", anchor_date: todayISO(), recur: "monthly", account_id: null, remind_days: 2, autopay: false, notes: "", photo: null, ended_on: "" };
  return state.billDraft;
}
function openAddBill(seed = null) {
  if (seed && seed.id) {   // edit
    state.billEditId = seed.id;
    state.billDraft = { name: seed.name, domain: seed.domain || "", amount: String(seed.amount), anchor_date: seed.anchor_date, recur: seed.recur, account_id: seed.account_id, remind_days: seed.remind_days ?? 2, autopay: !!seed.autopay, notes: seed.notes || "", photo: seed.photo || null, ended_on: seed.ended_on || "" };
  } else {
    state.billEditId = null; state.billDraft = null; const k = billDraft(); if (seed && seed.anchor_date) k.anchor_date = seed.anchor_date;
  }
  state.panel = "addbill"; state.openId = null; state.editId = null;
  render({ now: true });
  const p = $("rail"); if (p) p.scrollTop = 0;
  requestAnimationFrame(() => { const n = document.querySelector("#rail-body input[name=bname]"); if (n && !state.billEditId) n.focus(); });
}
function renderAddBillPanel(r) {
  const k = billDraft(), editing = state.billEditId != null;
  panelHeader(r, editing ? "Edit bill" : "Add a bill", editing ? k.name : "name · amount · due date — the rest is optional");
  const opt = (row, label, on, fn, title) => { const b = el("button", "o" + (on ? " on" : ""), label); b.type = "button"; if (title) b.title = title; b.addEventListener("click", () => { fn(); render({ now: true }); }); row.append(b); return b; };
  const field = (sec, label, name, type, value, { placeholder = "", step = null, min = null } = {}) => {
    const l = el("label", "bf", label); const i = el("input"); i.type = type; i.name = name; i.value = value ?? ""; if (placeholder) i.placeholder = placeholder; if (step) i.step = step; if (min != null) i.min = min;
    i.addEventListener("input", () => { k[name === "bname" ? "name" : name] = i.value; if (name === "domain" || name === "bname") updateLogoPreview(); });
    if (type === "date") i.addEventListener("click", () => { try { i.showPicker(); } catch {} });
    l.append(i); sec.append(l); return i;
  };
  // WHAT
  const sW = card(r, "What is it?");
  const body = el("div", "bform"); sW.append(body);
  field(body, "Name", "bname", "text", k.name, { placeholder: "e.g. Puget Sound Energy" });
  field(body, "Website (for the logo)", "domain", "text", k.domain, { placeholder: "e.g. pse.com" });
  const pv = el("div", "logo-preview"); pv.id = "logo-preview"; body.append(pv);
  const updateLogoPreview = () => { pv.innerHTML = ""; const dom = cleanDomain(k.domain); if (!k.name && !dom) { pv.append(el("span", "hint", "Logo preview shows here")); return; } pv.append(billLogo({ name: k.name || "?", domain: dom }, "logo big"), el("span", "hint", dom ? `logo from ${dom}` : "no site yet — initials for now")); };
  updateLogoPreview();
  // HOW MUCH · WHEN
  const sA = card(r, "How much, and when");
  const b2 = el("div", "bform two"); sA.append(b2);
  field(b2, "Amount", "amount", "number", k.amount, { placeholder: "0.00", step: "0.01", min: "0" });
  field(b2, editing ? "A due date it falls on" : "Due date", "anchor_date", "date", k.anchor_date);
  const sR = el("div", "picks"); sA.append(el("div", "bf-lab", "Repeats"));
  Object.entries(RECUR).forEach(([v, txt]) => opt(sR, txt, k.recur === v, () => { k.recur = v; }));
  sA.append(sR);
  // PAYS FROM
  const sF = card(r, "Pays from", { sub: "which account the money comes out of" });
  const pf = el("div", "picks");
  opt(pf, "— not set", k.account_id == null, () => { k.account_id = null; });
  B.accounts.forEach((a) => opt(pf, acctLabel(a.id, { full: true }), k.account_id === a.id, () => { k.account_id = a.id; }));
  const addA = el("button", "o dash", "+ account"); addA.type = "button"; addA.addEventListener("click", () => openPanel("accounts")); pf.append(addA);
  sF.append(pf);
  const ap = el("label", "bf check"); const cb = el("input"); cb.type = "checkbox"; cb.checked = !!k.autopay; cb.addEventListener("change", () => { k.autopay = cb.checked; }); ap.append(cb, el("span", "", " Autopay — it pays itself; you just confirm it went through")); sF.append(ap);
  // REMIND
  const sM = card(r, "Remind me", { sub: "a pop-up before it's due (Alerts: on, top right)" });
  const rm = el("div", "picks");
  REMIND.forEach(([d, txt]) => opt(rm, txt, k.remind_days === d, () => { k.remind_days = d; }));
  sM.append(rm);
  // NOTES · PHOTO · ENDS
  const sN = card(r, "Notes, photo, end date", { sub: "optional" });
  const nb = el("div", "bform"); sN.append(nb);
  const nl = el("label", "bf", "Notes"); const ta = el("textarea"); ta.value = k.notes || ""; ta.placeholder = "account number hints, login, anything you need when paying"; ta.addEventListener("input", () => { k.notes = ta.value; }); nl.append(ta); nb.append(nl);
  const pw = el("div", "photo-row");
  const pb = el("button", "btn sm", k.photo ? "📷 Change photo" : "📷 Take or attach a photo of the bill"); pb.type = "button"; pb.addEventListener("click", () => pickPhotoInto((data) => { k.photo = data; render({ now: true }); }));
  pw.append(pb);
  if (k.photo) { const t = el("div", "bphoto"); const img = el("img"); img.src = k.photo; t.append(img); const x = el("button", "btn sm ghost", "Remove photo"); x.type = "button"; x.addEventListener("click", () => { k.photo = null; render({ now: true }); }); pw.append(t, x); }
  nb.append(pw);
  field(nb, "Ends on (last due date — paid-off loan, cancelled service)", "ended_on", "date", k.ended_on);
  // GO
  const go = card(r, "Go");
  const act = el("div", "actions");
  const save = el("button", "btn primary", editing ? "Save changes" : "Add bill"); save.type = "button";
  save.addEventListener("click", async () => {
    const amt = Number(k.amount);
    if (!k.name.trim()) { toast("Give it a name"); return; }
    if (!(amt > 0)) { toast("How much is it?"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k.anchor_date || "")) { toast("Pick the due date"); return; }
    const row = { name: k.name.trim(), domain: cleanDomain(k.domain) || null, amount: Math.round(amt * 100) / 100, anchor_date: k.anchor_date, recur: k.recur, account_id: k.account_id, remind_days: k.remind_days, autopay: !!k.autopay, notes: k.notes?.trim() || null, photo: k.photo || null, ended_on: k.ended_on || null };
    if (!editing) row.sort = Number(k.anchor_date.slice(8, 10));
    const res = await saveBill(db, row, editing ? state.billEditId : null);
    if (typeof res === "string") { toast("Couldn't save: " + res); return; }
    if (!editing) pushUndo(`Add bill "${res.name}"`, async () => (await removeBill(db, res)) === true);
    toast(editing ? `Saved ${res.name}` : `Added ${res.name} — ${money(res.amount)} ${RECUR[res.recur].toLowerCase()}`, { undo: !editing });
    const due = res.anchor_date;
    state.billDraft = null; state.billEditId = null;
    if (isPhone()) { state.tab = "bills"; state.panel = null; render({ now: true }); }
    else { if (state.bucket !== "bills") setBucket("bills"); state.cursor = fromISO(due); state.mJump = iso(firstOfMonth(state.cursor)); openBillDay(due, res.id); }
  });
  const cancel = el("button", "btn", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", () => { state.billDraft = null; state.billEditId = null; closePanel(); });
  act.append(save, cancel); go.append(act);
}
// camera / file → downsized JPEG data URL (fits in a row; the old app did the same)
function pickPhotoInto(done) {
  const inp = el("input"); inp.type = "file"; inp.accept = "image/*"; inp.setAttribute("capture", "environment"); inp.className = "hidden";
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = (ev) => {
      const img = new Image();
      img.onload = () => { const maxW = 1100, sc = Math.min(1, maxW / img.width); const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc); cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); done(cv.toDataURL("image/jpeg", 0.7)); inp.remove(); };
      img.src = ev.target.result;
    };
    rd.readAsDataURL(f);
  });
  document.body.append(inp); inp.click();
}
function pickBillPhoto(b) {
  pickPhotoInto(async (data) => { const res = await saveBill(db, { photo: data }, b.id); if (typeof res === "string") { toast("Couldn't save the photo: " + res); return; } toast("Photo saved"); render({ now: true }); });
}

// ---------- accounts ----------
function renderAccountsPanel(r) {
  panelHeader(r, "Accounts", `${B.accounts.length} · what your bills pay from`);
  const sL = card(r, "Your accounts", { sub: "bank · nickname · last 4 digits only — never the full number" });
  if (!B.accounts.length) sL.append(el("div", "empty", "None yet. Add one below, then set 'Pays from' on each bill."));
  B.accounts.forEach((a) => {
    const row = el("div", "brow");
    const tt = el("span", "tt"); tt.append(el("b", "", acctLabel(a.id, { full: true })));
    const n = B.bills.filter((b) => b.account_id === a.id).length;
    tt.append(el("small", "", n ? `${n} bill${n === 1 ? "" : "s"}` : "no bills point here yet"));
    row.append(tt);
    const ed = el("button", "btn sm", "✎ Edit"); ed.addEventListener("click", () => { state.acctDraft = { id: a.id, bank: a.bank, nick: a.nick || "", last4: a.last4 || "" }; render({ now: true }); });
    const del = el("button", "btn sm danger", "Delete"); del.addEventListener("click", async () => {
      if (!confirm(`Delete ${acctLabel(a.id, { full: true })}?${n ? `\n${n} bill(s) point at it — they'll show "no account set" until you pick another.` : ""}`)) return;
      const res = await deleteAccount(db, a.id); if (res !== true) { toast("Couldn't delete: " + res); return; }
      toast("Account deleted"); render({ now: true });
    });
    row.append(ed, del); sL.append(row);
  });
  const k = state.acctDraft || (state.acctDraft = { id: null, bank: "", nick: "", last4: "" });
  const sF = card(r, k.id ? "Edit account" : "Add an account");
  const f = el("div", "bform two"); sF.append(f);
  const fld = (label, name, value, placeholder, maxlength) => { const l = el("label", "bf", label); const i = el("input"); i.type = "text"; i.name = name; i.value = value; i.placeholder = placeholder; if (maxlength) i.maxLength = maxlength; if (name === "last4") i.inputMode = "numeric"; i.addEventListener("input", () => { k[name] = i.value; }); l.append(i); f.append(l); };
  fld("Bank", "bank", k.bank, "e.g. Qualstar"); fld("Nickname", "nick", k.nick, "e.g. Checking"); fld("Last 4 digits", "last4", k.last4, "1234", 8);
  const act = el("div", "actions");
  const save = el("button", "btn primary sm", k.id ? "Save changes" : "Add account"); save.type = "button";
  save.addEventListener("click", async () => {
    if (!k.bank.trim()) { toast("Which bank?"); return; }
    const last4 = String(k.last4).replace(/\D/g, "").slice(-8);
    const res = await saveAccount(db, { bank: k.bank.trim(), nick: k.nick.trim(), last4: last4 || null }, k.id);
    if (typeof res === "string") { toast("Couldn't save: " + res); return; }
    toast(k.id ? "Saved" : `Added ${acctLabel(res.id, { full: true })}`); state.acctDraft = null; render({ now: true });
  });
  const back = el("button", "btn sm", k.id ? "Cancel" : (state.billDraft ? "‹ Back to the bill" : "‹ Back")); back.type = "button";
  back.addEventListener("click", () => { state.acctDraft = null; if (state.billDraft) { state.panel = "addbill"; render({ now: true }); } else closePanel(); });
  act.append(save, back); sF.append(act);
}

// ---------- phone alerts: the bills as a subscribed calendar (Apple Calendar reads it, alerts fire by remind_days) ----------
async function feedToken() {
  if (state.feedToken) return state.feedToken;
  const { data } = await db.from("fm_prefs").select("value").eq("key", "bills_feed_token").maybeSingle();
  let tok = data && typeof data.value === "string" ? data.value : null;
  if (!tok) {
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes); tok = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error } = await db.from("fm_prefs").upsert({ key: "bills_feed_token", value: tok }, { onConflict: "user_id,key" });
    if (error) { toast("Couldn't set up the feed: " + error.message); return null; }
  }
  state.feedToken = tok; return tok;
}
function renderBillAlertsPanel(r) {
  panelHeader(r, "Phone alerts", "bills in your iPhone / Apple Watch calendar");
  const s = card(r, "How it works");
  s.append(el("div", "row wrap", "Your bills become a calendar called Bills. Each one alerts you before it's due (the bill's own 'Remind me'); mark it paid here and the alert goes away."));
  const box = el("div", "actions-col"); s.append(box);
  box.append(el("div", "hint", "One moment…"));
  feedToken().then((tok) => {
    box.innerHTML = "";
    if (!tok) { box.append(el("div", "empty", "Couldn't reach the server — try again in a minute.")); return; }
    const url = `${CONFIG.SUPABASE_URL}/functions/v1/bills-ics?t=${tok}`;
    const web = url.replace(/^https:\/\//, "webcal://");
    const a = el("a", "btn primary", "🔔 Turn on Apple Calendar alerts"); a.href = web; a.title = "On iPhone: Subscribe → Add. On Mac: opens Calendar.";
    const cp = el("button", "btn", "Copy the link instead"); cp.type = "button";
    cp.addEventListener("click", () => { const ok = () => { cp.textContent = "Copied ✓"; setTimeout(() => { cp.textContent = "Copy the link instead"; }, 1600); }; if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(ok, () => prompt("Copy this link:", url)); else prompt("Copy this link:", url); });
    box.append(a, cp);
    box.append(el("div", "hint", "Copied it? iPhone: Calendar app → Calendars → Add Calendar → Add Subscription Calendar → paste. The feed refreshes every few hours."));
  });
}

// ---------- nav ----------
function shift(n) {
  const c = state.cursor;
  if (state.view === "month") {
    state.cursor = new Date(c.getFullYear(), c.getMonth() + n, 1);
    state.mJump = iso(state.cursor); state.mJumpSmooth = true;
    const sc = document.querySelector(".mscroll"); state.mPrevTop = sc ? sc.scrollTop : null;
  }
  else if (state.view === "week") state.cursor = addDays(c, 7 * n);
  else state.cursor = addDays(c, n);
  render();
}

function wire() {
  $("bucket-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; setBucket(b.dataset.bucket); });
  // hover the $ Bills button → a quick summary; click → the Bills view
  const bb = document.querySelector('#bucket-seg button[data-bucket="bills"]');
  if (bb) { bb.addEventListener("mouseenter", () => { if (!isPhone() && !billsMode()) openBillPeek(bb); }); bb.addEventListener("mouseleave", scheduleClosePeek); }
  $("view-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.view = b.dataset.view; localStorage.setItem("fm.view", state.view); state.mTop = null; if (state.view === "day" && state.selected) state.cursor = fromISO(state.selected); render(); });
  $("prev-btn").addEventListener("click", () => shift(-1));
  $("next-btn").addEventListener("click", () => shift(1));
  $("today-btn").addEventListener("click", () => { state.cursor = new Date(); state.mJump = iso(firstOfMonth(state.cursor)); render(); });
  $("add-btn").addEventListener("click", openAdd);
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => phoneTab(b.dataset.tab)));
  $("balance-btn").addEventListener("click", () => {
    const s = weekStart(new Date()), mon = iso(addDays(s, 1)), fri = iso(addDays(s, 5));
    askBrain(`Balance this week (${mon} to ${fri}): apply the scheduling rules to Mon–Fri. Keep every day inside 8 hours counting meetings I attend and days off. Move overflow forward — low first, then normal, toward their targets, never past a drop-dead, never anything promised to someone. Urgent stays put. One-line reason on every move, and tell me what moved.`);
  });
  $("quick-add").addEventListener("submit", async (e) => { e.preventDefault(); const v = $("quick-input").value.trim(); if (!v) return; $("quick-input").value = ""; await quickAdd(v); });
  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (e.key === "Escape") { if (popEl) closeQuickFix(); else if (state.editId) { state.editId = null; render(); } else if (state.panel) closePanel(); }
    if (e.key === "/" && !typing) { e.preventDefault(); $("quick-input").focus(); }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undoLast(); }   // Ctrl+Z = undo the last change
  });
  initMic();
  initFullscreen();
  initInstall();
  initAlerts();
  initMini();
}

// ---------- boot ----------
document.addEventListener("app:ready", async () => {
  await loadAll();
  subscribe();
});
wire();
initAuth();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((reg) => {
    // Installed-app windows stay open for days: check for new app code on every wake and every 15 min.
    const check = () => reg.update().catch(() => {});
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
    setInterval(check, 15 * 60 * 1000);
  }).catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) { hadController = true; return; }       // first install, nothing to swap
    const go = () => { if (userIsTyping()) setTimeout(go, 3000); else location.reload(); };
    toast("AP updated — refreshing"); setTimeout(go, 1200);
  });
}
