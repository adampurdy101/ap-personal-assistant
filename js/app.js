// ============================================================
//  AP PERSONAL ASSISTANT  ·  app.js
//  Panel LEFT (Next Up · Status · Today · Meetings · Promises · Tasks · Quick Look),
//  calendar RIGHT (Month / Week / Day · Work / Home / Both). Quick add (type or
//  speak), Tomorrow pencil-in, chip push arrows, "?" size/priority popover,
//  Balance week. Data: Supabase fm_tasks / fm_jobs / fm_meetings / fm_moves.
// ============================================================
import { db } from "./supabase.js";
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
  tasks: [],
  jobs: [],
  meetings: [],                                          // PCI Outlook meetings (titles + times only)
  meetingsSync: null,
  showDone: false,
  tomorrowDraft: "",                                     // Tomorrow panel text, kept across redraws
};

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ---------- data ----------
async function loadAll() {
  const from = iso(addDays(new Date(), -45)), to = iso(addDays(new Date(), 120));
  const [t, j, m] = await Promise.all([
    db.from("fm_tasks").select("*").order("sort").order("created_at"),
    db.from("fm_jobs").select("*").eq("active", true).order("bucket").order("sort"),
    db.from("fm_meetings").select("id,title,start_at,end_at,all_day,attending,day,updated_at,source").gte("day", from).lte("day", to).order("start_at"),
  ]);
  if (t.error) { toast("Load failed: " + t.error.message); return; }
  state.tasks = t.data || [];
  state.jobs = j.data || [];
  if (!m.error) {
    state.meetings = m.data || [];
    state.meetingsSync = state.meetings.reduce((a, x) => (x.updated_at > a ? x.updated_at : a), "") || null;
  }
  render();
}

async function saveTask(id, patch) {
  const { error } = await db.from("fm_tasks").update(patch).eq("id", id);
  if (error) { toast("Save failed: " + error.message); return false; }
  const t = state.tasks.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  render();
  return true;
}

async function insertTask(row) {
  const { data, error } = await db.from("fm_tasks").insert(row).select().single();
  if (error) { toast("Add failed: " + error.message); return null; }
  state.tasks.push(data);
  render();
  return data;
}

async function deleteTask(id) {
  const { error } = await db.from("fm_tasks").delete().eq("id", id);
  if (error) { toast("Delete failed: " + error.message); return; }
  state.tasks = state.tasks.filter((t) => t.id !== id);
  if (state.openId === id) state.openId = null;
  render();
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
const inBucket = (t) => state.bucket === "both" || t.bucket === state.bucket;
const visible = (t) => inBucket(t) && (state.showDone || t.status !== "done");
const tasksOn = (dateISO) => state.tasks.filter((t) => visible(t) && t.scheduled_date === dateISO).sort(dayOrder);
const unscheduled = () => state.tasks.filter((t) => visible(t) && !t.scheduled_date).sort(byPriority);
// ---------- meetings (PCI Outlook, read-only, work calendar) + off days ----------
const SIZE_HRS = { "15m": 0.25, "1h": 1, half: 4, full: 8 };
const DAY_HRS = 8;
const OFF_SOURCES = new Set(["pcg_holiday", "pto"]);   // all-day rows that take the whole day off
const showMeetings = () => state.bucket !== "home";
const meetingsOn = (dISO) => showMeetings() ? state.meetings.filter((m) => m.day === dISO) : [];
const timedOn = (dISO) => meetingsOn(dISO).filter((m) => !m.all_day);
const allDayOn = (dISO) => meetingsOn(dISO).filter((m) => m.all_day);
const isOff = (m) => m.all_day && OFF_SOURCES.has(m.source);
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
// move a task and log it like the brain does, so Undo and "why" work the same way
async function moveTask(t, toISO, reason, { ask = true } = {}) {
  if (!toISO || toISO === t.scheduled_date) return false;
  if (ask && t.promised_to && !confirm(`"${t.title}" is promised to ${t.promised_to}. Move it anyway?`)) return false;
  if (ask && t.dropdead_date && toISO > t.dropdead_date && !confirm(`That is past its drop-dead (${fmtShort(t.dropdead_date)}). Move it anyway?`)) return false;
  const before = { ...t };
  const patch = { scheduled_date: toISO, planned: false };
  const { error } = await db.from("fm_tasks").update(patch).eq("id", t.id);
  if (error) { toast("Move failed: " + error.message); return false; }
  Object.assign(t, patch);
  const after = { ...t };
  await db.from("fm_moves").insert({ batch_id: "app-" + todayISO(), kind: "move", task_id: t.id, before, after, reason, from_date: before.scheduled_date, to_date: toISO }).then(() => {}, () => {});
  render();
  return true;
}
// order of a day (rulebook 5.3): urgent → promises due → drop-deads within 2 days → planned → high → normal → low
function dayOrder(a, b) {
  const r = (t) => {
    const today = todayISO(), soon = iso(addDays(new Date(), 2));
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
  const cls = "mtg " + (off ? "allday off" : m.all_day ? "allday" : m.attending ? "going" : "invited");
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
  if (t.status === "done") return { text: "Done", cls: "" };
  if (t.dropdead_date && t.dropdead_date < today) return { text: `Overdue ${daysBetween(t.dropdead_date, today)}d`, cls: "overdue" };
  if (t.status === "waiting") return { text: `Waiting on ${t.waiting_on || "…"}`, cls: "warn" };
  if (t.target_date && t.target_date < today) return { text: "Target missed", cls: "warn" };
  if (t.planned) return { text: "Planned", cls: "" };
  return { text: STATUS[t.status] || "Not started", cls: "" };
}

function tooltip(t) {
  const parts = [`${PRI[t.priority].label}`, STATUS[t.status]];
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
  renderCalendar();
  renderRail();
  $("layout").classList.toggle("wide", !!state.panel);
  renderMini();
  updateBadge();
}

function renderTop() {
  document.querySelectorAll("#bucket-seg button").forEach((b) => b.classList.toggle("on", b.dataset.bucket === state.bucket));
  document.querySelectorAll("#view-seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  const btn = $("tell-btn"), inp = $("quick-input");
  if (btn) { btn.classList.toggle("listening", voice.on); const l = btn.querySelector("span"); if (l) l.textContent = voice.on ? "Listening… press to send" : "Tell Assistant"; }
  if (inp) inp.placeholder = voice.on ? "Listening… say it at your pace" : "Quick add (Enter) or tell your assistant anything…";
}

function renderCalendar() {
  const body = $("cal-body");
  body.innerHTML = "";
  if (state.view === "month") renderMonth(body);
  else if (state.view === "week") renderWeek(body);
  else renderDay(body);
}

function chipFor(t) {
  const c = el("span", `chip p-${t.priority}` + (t.planned ? " planned" : "") + (t.bucket === "home" && state.bucket === "both" ? " bucket-home" : "") + (t.status === "done" ? " is-done" : ""));
  c.append(el("span", "sym", PRI[t.priority].mark));
  if (!t.confirmed && t.status !== "done") {
    const q = el("span", "q", "?");
    q.title = "I guessed the size and priority — click to set them";
    q.addEventListener("click", (e) => { e.stopPropagation(); openQuickFix(t, c); });
    c.append(q);
  }
  c.append(document.createTextNode(t.title));
  if (t.scheduled_date && t.status !== "done") {
    const l = el("span", "mv l", "‹"); l.title = "Push a day earlier";
    const r = el("span", "mv r", "›"); r.title = "Push a day later";
    l.addEventListener("click", (e) => { e.stopPropagation(); moveTask(t, nextDay(t.scheduled_date, -1, t.bucket), "Pushed a day earlier with the chip arrow"); });
    r.addEventListener("click", (e) => { e.stopPropagation(); moveTask(t, nextDay(t.scheduled_date, 1, t.bucket), "Pushed a day later with the chip arrow"); });
    c.append(l, r);
  }
  c.title = tooltip(t) + (t.confirmed ? "" : " · size/priority guessed (?)");
  c.draggable = true;
  c.dataset.id = t.id;
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(t.id)); e.dataTransfer.effectAllowed = "move"; });
  c.addEventListener("click", (e) => { e.stopPropagation(); openDay(t.scheduled_date, t.id); });
  return c;
}

// "?" popover: 2 questions — how long, which priority — then Save
let popEl = null;
function closeQuickFix() { if (popEl) { popEl.remove(); popEl = null; } }
document.addEventListener("click", (e) => { if (popEl && !popEl.contains(e.target)) closeQuickFix(); });
function openQuickFix(t, anchor) {
  closeQuickFix();
  const p = el("div", "pop");
  const pick = { size: t.size || "1h", priority: t.priority, hrs: "" };
  p.innerHTML = `<div class="ttl">I guessed these for <b>${esc(t.title)}</b> — set them:</div>`;
  const mk = (label, cls) => { const h = el("span", "h", label); p.append(h); const r = el("div", "r " + cls); p.append(r); return r; };
  const sizes = mk("HOW LONG", "sz");
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
    if (pick.hrs && h > 0) { size = h <= 0.5 ? "15m" : h <= 2 ? "1h" : h <= 5 ? "half" : "full"; note = `Adam: ${h} h`; }
    const patch = { size, priority: pick.priority, confirmed: true };
    if (note) patch.notes = (t.notes ? t.notes + "\n" : "") + note;
    closeQuickFix();
    if (await saveTask(t.id, patch)) toast(`Set: ${SIZE[size]} · ${PRI[pick.priority].label}`);
  });
  pris.append(save);
  p.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(p);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 310, r.left));
  const top = r.bottom + 6 + 170 > window.innerHeight ? Math.max(8, r.top - 176) : r.bottom + 6;
  p.style.left = left + "px"; p.style.top = top + "px";
  popEl = p;
}

function dayCell(d, { other = false, max = 4, fit = 0 } = {}) {
  const dISO = iso(d);
  const cell = el("div", "day");
  if (other) cell.classList.add("other");
  if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add("weekend");
  const isToday = dISO === todayISO();
  if (isToday) cell.classList.add("today");
  else if (dISO < todayISO()) { cell.classList.add("past"); cell.append(el("span", "stamp", "DONE")); }
  if (dISO === state.selected && state.panel === "day") cell.classList.add("selected");

  const items = tasksOn(dISO);
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
    if (t && await moveTask(t, dISO, "Dragged to " + fmtShort(dISO))) toast("Moved to " + fmtShort(dISO));
  });
  return cell;
}

// Month view = one continuous run of weeks. Scroll wheel / scrollbar slides
// partway into next or prior months; the title follows the month on screen.
// Built ONCE for a wide window (±12 months). Scrolling never rebuilds the DOM:
// running out of weeks just appends/prepends more rows. Data refreshes that
// land mid-scroll wait until the scroll settles (a rebuild mid-drag snaps the
// scrollbar back).
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

  // Focus = the month owning the day a third of the way down the screen.
  const probeIdx = Math.min(rows.length - 1, Math.floor((top - firstTop + (sc.clientHeight - head.offsetHeight) / 3) / rowH));
  const f = firstOfMonth(addDays(fromISO(rows[probeIdx].dataset.start), 3));
  if (!sameMonth(f, state.cursor)) {
    state.cursor = f;
    $("cal-title").textContent = f.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const key = monthKey(f);
    sc.querySelectorAll(".day").forEach((c) => c.classList.toggle("other", c.dataset.month !== key));
  }

  // Running out of weeks? Add more rows — no rebuild, no jump.
  const max = monthRows(f) >= 6 ? 3 : 4, key = monthKey(f), ADD = 12;
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
  if (!state.panel) renderQuickLook(r);   // first thing in the general view only
  if (state.panel === "day" && state.selected) return renderDayPanel(r);
  if (state.panel === "unscheduled") return renderUnscheduledPanel(r);
  if (state.panel === "tomorrow") return renderTomorrowPanel(r);
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
    else { brain.batch = null; if ((out.actions || []).length) brain.lastBatch = out.batch_id; }
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
  if (!brain.lastBatch) return;
  const { data: moves, error } = await db.from("fm_moves").select("*").eq("batch_id", brain.lastBatch).order("id", { ascending: false });
  if (error || !moves?.length) { toast("Nothing to undo"); return; }
  for (const m of moves) {
    if (m.kind === "add" && m.task_id) await db.from("fm_tasks").delete().eq("id", m.task_id);
    else if ((m.kind === "move" || m.kind === "update" || m.kind === "complete") && m.task_id && m.before) {
      const b = { ...m.before }; delete b.id; if (m.kind === "complete") b.done_at = null;
      await db.from("fm_tasks").update(b).eq("id", m.task_id);
    } else if (m.kind === "delete" && m.before) {
      const b = { ...m.before }; delete b.id; await db.from("fm_tasks").insert(b);
    }
  }
  await db.from("fm_moves").delete().eq("batch_id", brain.lastBatch);
  brain.log.push({ who: "ap", text: `Undid ${moves.length} change${moves.length === 1 ? "" : "s"}.` });
  brain.lastBatch = null;
  await loadAll();
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
        else if (a.kind === "delete") line = `Deleted "${a.title}"`;
        ul.append(el("li", "", line));
      });
      b.append(ul);
    }
    box.append(b);
  });
  if (brain.busy) box.append(el("div", "hint", "Working on it…"));
  if (voice.on && (voice.key === "brain" || voice.key === "quick")) {
    const live = el("div", "bubble you live"); live.id = "live-bubble";
    live.append(el("div", "who", "You · listening — pause 10 s or press to send"), el("div", "txt", voiceText() || "…"));
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
  const row = el("div", "row link");
  row.append(el("span", "sym" + (t.priority === "urgent" ? " u" : ""), PRI[t.priority].mark));
  if (!t.confirmed && t.status !== "done") { const q = el("span", "sym q", "?"); q.title = "size/priority guessed — click the ? on its chip to set"; row.append(q); }
  row.append(document.createTextNode(t.title));
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
    if (nx.status === "working") bits.push("working");
    txt.append(el("small", "", bits.join(" · ")));
    row.append(txt);
    row.title = tooltip(nx);
    row.addEventListener("click", () => openDay(today, nx.id));
    sNext.append(row);
    const bt = el("div", "nxbtn");
    const ok = el("button", "btn ok", "✓ Done"); ok.addEventListener("click", () => saveTask(nx.id, { status: "done", done_at: new Date().toISOString() }));
    const push = el("button", "btn push", "Push →"); push.title = "Move it to the next work day";
    push.addEventListener("click", async () => { const to = nextDay(today, 1, nx.bucket); if (await moveTask(nx, to, "Pushed from Next up")) toast(`Pushed to ${fmtShort(to)}`); });
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
  const sStat = card(r, "Status");
  sStat.append(el("div", "status" + (parts.length ? "" : " ok"), parts.length ? parts.join(" · ") : "On track"));
  const risky = state.tasks.filter((t) => visible(t) && t.status !== "done" && t.scheduled_date !== today && (
    (t.dropdead_date && t.dropdead_date < today) || (t.target_date && t.target_date < today)
  )).sort(byPriority);
  risky.slice(0, 4).forEach((t) => rowFor(sStat, t));
  const un = unscheduled();
  const inbox = el("div", "row link"); inbox.append(el("b", "", `Inbox: ${un.length} unscheduled`), el("i", "", un.length ? "give each a day →" : ""));
  inbox.addEventListener("click", () => openUnscheduled());
  sStat.append(inbox);

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
      offs.forEach((m) => { const row = el("div", "row wrap"); row.innerHTML = `◇ <b>${esc(m.title)}</b><i>day off</i>`; sM.append(row); });
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
  const sT = card(r, `Tasks · ${open.length}`, { sub: todayItems.length - open.length ? `${todayItems.length - open.length} done` : "" });
  todayItems.forEach((t) => rowFor(sT, t));
  if (!todayItems.length) sT.append(el("div", "empty", "Nothing scheduled today."));
  const sd = el("label", "hint");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = state.showDone;
  cb.addEventListener("change", () => { state.showDone = cb.checked; render(); });
  sd.append(cb, " Show done items");
  sT.append(sd);
  if (state.meetingsSync) sT.append(el("div", "hint", `Outlook checked ${new Date(state.meetingsSync).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · every 15 min`));


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
  const x = el("button", "btn ghost sm close", "✕ Close"); x.title = "Close (Esc)";
  x.addEventListener("click", closePanel);
  s.querySelector(".lab").append(x);
  s.classList.add("head");
  return s;
}

function renderDayPanel(r) {
  const d = state.selected;
  const items = tasksOn(d);
  panelHeader(r, fmtLong(d), `${items.length} item${items.length === 1 ? "" : "s"}`);
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
  const sT = card(r, "Tasks", { sub: "click one for detail" });
  if (!items.length) sT.append(el("div", "empty", "Nothing here yet. Quick add puts new things on this day."));
  items.forEach((t) => sT.append(itemCard(t)));
  // coming up (next 5 days)
  const soon = [];
  for (let i = 1; i <= 5; i++) { const dd = iso(addDays(fromISO(d), i)); tasksOn(dd).forEach((t) => soon.push(t)); }
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

function renderTomorrowPanel(r) {
  const tmr = iso(addDays(new Date(), 1));
  panelHeader(r, "Tomorrow", fmtShort(tmr));
  const sW = card(r, "What do you want to work on?", { sub: "one per line" });
  const wrap = el("div", "tomorrow");
  wrap.append(el("div", "hint", "They land as Planned (dashed) on tomorrow; the 5:30 a.m. plan builds the day around them."));
  const ta = el("textarea"); ta.placeholder = voice.on && voice.key === "tomorrow" ? "Listening…" : "Miner L2 leave-outs\nC1 DWG export\n…";
  ta.value = state.tomorrowDraft || "";
  ta.addEventListener("input", () => { state.tomorrowDraft = ta.value; });
  const taWrap = el("div", "ta-wrap"); taWrap.append(ta);
  const mic = el("button", "mic" + (voice.on && voice.key === "tomorrow" ? " listening" : "")); mic.type = "button"; mic.title = voice.on ? "Press to stop" : "Speak it"; mic.setAttribute("aria-label", "Speak tomorrow's list");
  mic.innerHTML = MIC_SVG;
  mic.addEventListener("click", () => voiceToggle("tomorrow"));
  taWrap.append(mic);
  wrap.append(taWrap);
  const act = el("div", "actions");
  const plan = el("button", "btn primary", "Plan it with Assistant");
  plan.addEventListener("click", () => {
    const v = ta.value.trim(); if (!v) return;
    ta.value = ""; state.tomorrowDraft = "";
    askBrain(`Tomorrow (${tmr}) I want to work on: ${v}. Pencil these in on tomorrow as planned, and reshuffle anything else on tomorrow that no longer fits.`);
  });
  const save = el("button", "btn", "Just pencil in (no reshuffle)");
  save.addEventListener("click", async () => {
    const lines = ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    for (const line of lines) {
      const p = parseQuick(line);
      await insertTask({ title: p.title, priority: p.priority, bucket: p.bucket || (state.bucket === "both" ? "work" : state.bucket), scheduled_date: tmr, planned: true, job: p.job, source: "tomorrow" });
    }
    ta.value = ""; state.tomorrowDraft = "";
    toast(`${lines.length} penciled in for tomorrow`);
  });
  act.append(plan, save);
  wrap.append(act);
  sW.append(wrap);

  const existing = tasksOn(tmr);
  const sE = card(r, "Already on tomorrow", { sub: String(existing.length) });
  if (!existing.length) sE.append(el("div", "empty", "Nothing yet."));
  existing.forEach((t) => sE.append(itemCard(t)));
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
  if (!t.confirmed && t.status !== "done") { const q = el("span", "status-pill q", "? size"); q.title = "Size and priority were guessed"; head.append(q); }
  head.append(st, caret);
  head.addEventListener("click", () => { state.openId = state.openId === t.id ? null : t.id; state.editId = null; render(); });
  card.append(head);

  if (state.openId === t.id) {
    if (state.editId === t.id) card.append(editForm(t));
    else {
      const d = el("div", "detail");
      const bits = [];
      if (t.job) bits.push(`<b>Job:</b> ${esc(t.job)}`);
      if (t.size) bits.push(`<b>Size:</b> ${esc(SIZE[t.size])}`);
      bits.push(`<b>Calendar:</b> ${t.bucket === "home" ? "Home" : "Work"}`);
      d.innerHTML = bits.join(" · ") + "<br>"
        + `<b>Scheduled:</b> ${t.scheduled_date ? esc(fmtShort(t.scheduled_date)) : "—"} · `
        + `<b>Target:</b> ${t.target_date ? esc(fmtShort(t.target_date)) : "—"} · `
        + `<b>Drop-dead:</b> ${t.dropdead_date ? esc(fmtShort(t.dropdead_date)) : "—"}`
        + (t.promised_to ? `<br><b>Promised to:</b> ${esc(t.promised_to)}` : "")
        + (t.nag_hours ? `<br><b>Nag:</b> every ${t.nag_hours} hr${t.nag_hours === 1 ? "" : "s"} until done` : "")
        + (t.notes ? `<br><b>Notes:</b> ${esc(t.notes)}` : "");
      card.append(d);

      const a = el("div", "actions");
      const btn = (label, fn, cls = "btn sm") => { const b = el("button", cls, label); b.addEventListener("click", fn); return b; };
      if (t.status !== "done") a.append(btn("✓ Done", () => saveTask(t.id, { status: "done", done_at: new Date().toISOString() }), "btn sm olive"));
      else a.append(btn("Reopen", () => saveTask(t.id, { status: "not_started", done_at: null })));
      if (t.status === "not_started" || t.status === "waiting") a.append(btn("Working", () => saveTask(t.id, { status: "working" })));
      if (t.planned) a.append(btn("Make it real", () => saveTask(t.id, { planned: false })));
      if (!t.confirmed && t.status !== "done") { const q = btn("? Set size + priority", null, "btn sm"); q.addEventListener("click", () => openQuickFix(t, q)); a.append(q); }
      a.append(btn("Tomorrow", () => moveTask(t, iso(addDays(new Date(), 1)), "Moved to tomorrow from the panel")));
      a.append(btn("+1 wk", () => moveTask(t, iso(addDays(t.scheduled_date ? fromISO(t.scheduled_date) : new Date(), 7)), "Pushed a week from the panel")));
      a.append(btn("Edit", () => { state.editId = t.id; render(); }));
      a.append(btn("Delete", async () => { if (confirm(`Delete "${t.title}"?`)) await deleteTask(t.id); }, "btn sm danger"));
      card.append(a);
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
  f.append(sel("Size", "size", [["", "—"], ...Object.entries(SIZE)], t.size || ""));
  f.append(field("Scheduled (on calendar)", "scheduled_date", "date", t.scheduled_date || ""));
  f.append(sel("Status", "status", Object.entries(STATUS), t.status));
  f.append(field("Target date (want it done by)", "target_date", "date", t.target_date || ""));
  f.append(field("Drop-dead date (must be done by)", "dropdead_date", "date", t.dropdead_date || ""));
  f.append(field("Promised to", "promised_to", "text", t.promised_to || ""));
  f.append(field("Waiting on (if status is Waiting)", "waiting_on", "text", t.waiting_on || ""));
  f.append(sel("Nag until done", "nag_hours", [["0", "No nag"], ["1", "Every hour"], ["2", "Every 2 hrs"], ["4", "Every 4 hrs"], ["24", "Once a day"]], String(t.nag_hours || 0)));
  const notes = el("label", "full", "Notes"); const ta = el("textarea"); ta.name = "notes"; ta.value = t.notes || ""; notes.append(ta); f.append(notes);
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
    if (patch.scheduled_date) patch.planned = t.planned && patch.scheduled_date === t.scheduled_date ? t.planned : false;
    if (patch.size) patch.confirmed = true;   // Adam set it himself — the "?" comes off
    state.editId = null;
    if (await saveTask(t.id, patch)) toast("Saved");
  });
  return f;
}

// ---------- panels ----------
function openDay(dateISO, taskId = null) {
  if (!dateISO) return openUnscheduled(taskId);
  state.selected = dateISO; state.panel = "day"; state.openId = taskId; state.editId = null;
  render();
}
function openUnscheduled(taskId = null) { state.panel = "unscheduled"; state.openId = taskId; state.editId = null; render(); }
function openTomorrow() { state.panel = "tomorrow"; state.openId = null; state.editId = null; render({ now: true }); }
function closePanel() { state.panel = null; state.openId = null; state.editId = null; render({ now: true }); }

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
  const row = { title: p.title, priority: p.priority, bucket: p.bucket || (state.bucket === "both" ? "work" : state.bucket), job: p.job, scheduled_date: date, source: "quick" };
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
const SILENCE_MS = 10000;
const IDLE_MS = 30000;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { rec: null, on: false, key: null, finalText: "", interim: "", silence: null, stopTimer: null, restarts: 0 };
const voiceText = () => (voice.finalText + " " + voice.interim).replace(/\s+/g, " ").trim();
// Where the words go when he's done. quick (top bar) and brain (panel mic) are the
// same conversation; tomorrow lands in that panel's list.
const toAssistant = {
  seed: () => ($("quick-input")?.value || document.querySelector(".brain-input")?.value || "").trim(),
  live: (v) => { const i = $("quick-input"); if (i) i.value = v; liveBubble(v); },
  done: (v) => { const i = $("quick-input"); if (i) i.value = ""; const j = document.querySelector(".brain-input"); if (j) j.value = ""; askBrain(v); },
};
const VOICE_TARGETS = {
  quick: toAssistant,
  brain: toAssistant,
  tomorrow: {
    seed: () => "",
    live: (v) => { const t = document.querySelector(".tomorrow textarea"); if (t) t.placeholder = v || "Listening…"; },
    done: (v) => { const d = (state.tomorrowDraft || "").replace(/\s*$/, ""); state.tomorrowDraft = (d ? d + "\n" : "") + v; },
  },
};
function liveBubble(v) { const b = document.querySelector("#live-bubble .txt"); if (b) b.textContent = v || "…"; }
function voiceStart(key) {
  if (!SR) { toast("Voice needs Chrome or Edge — type it instead"); return false; }
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
    (t.dropdead_date && t.dropdead_date <= today))).length;
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
  const items = state.tasks.filter((t) => t.scheduled_date === today && (t.status !== "done" || state.showDone)).sort(byPriority);
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
    b.addEventListener("click", () => saveTask(t.id, t.status === "done" ? { status: "not_started", done_at: null } : { status: "done", done_at: new Date().toISOString() }));
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
  $("bucket-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.bucket = b.dataset.bucket; localStorage.setItem("fm.bucket", state.bucket); render(); });
  $("view-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.view = b.dataset.view; localStorage.setItem("fm.view", state.view); state.mTop = null; if (state.view === "day" && state.selected) state.cursor = fromISO(state.selected); render(); });
  $("prev-btn").addEventListener("click", () => shift(-1));
  $("next-btn").addEventListener("click", () => shift(1));
  $("today-btn").addEventListener("click", () => { state.cursor = new Date(); state.mJump = iso(firstOfMonth(state.cursor)); render(); });
  $("tomorrow-btn").addEventListener("click", openTomorrow);
  $("balance-btn").addEventListener("click", () => {
    const s = weekStart(new Date()), mon = iso(addDays(s, 1)), fri = iso(addDays(s, 5));
    askBrain(`Balance this week (${mon} to ${fri}): apply the scheduling rules to Mon–Fri. Keep every day inside 8 hours counting meetings I attend and days off. Move overflow forward — low first, then normal, toward their targets, never past a drop-dead, never anything promised to someone. Urgent stays put. One-line reason on every move, and tell me what moved.`);
  });
  $("quick-add").addEventListener("submit", async (e) => { e.preventDefault(); const v = $("quick-input").value.trim(); if (!v) return; $("quick-input").value = ""; await quickAdd(v); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (state.editId) { state.editId = null; render(); } else if (state.panel) closePanel(); }
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); $("quick-input").focus(); }
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
