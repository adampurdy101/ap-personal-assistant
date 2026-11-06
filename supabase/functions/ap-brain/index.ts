// ap-brain  ·  verify_jwt = TRUE
// AP Personal Assistant's brain. The app sends what Adam said (brain dump, a
// question, answers to earlier questions). This calls Claude with tools that
// read/write the fm_tasks table AS THE LOGGED-IN USER (his JWT + anon key, RLS
// applies), files everything, reshuffles within the rules, and returns what it did.
// v5 (Nov 6, 2026): days off by voice — add_day_off / remove_day_off write all-day
// PTO rows to fm_meetings (source pto); the app hatches those days on its own.
//
// SECURITY: ANTHROPIC_API_KEY lives only in Supabase Edge Function secrets.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MODEL = Deno.env.get("AP_MODEL") || "claude-sonnet-4-5";
const OWNER_IDS = new Set(["30cbcbfa-7261-47de-8c91-3d97557fc5f9"]);

const ALLOW = ["https://adampurdy101.github.io", "http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:8080"];
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

function userClient(jwt: string) {
  return createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
}
type DB = ReturnType<typeof userClient>;

const SIZE_HOURS: Record<string, number> = { "15m": 0.25, "1h": 1, half: 4, full: 8 };
const DAY_HOURS = 8; // 7 to 4 with lunch
const TASK_FIELDS = "id,title,notes,bucket,priority,status,waiting_on,job,size,scheduled_date,target_date,dropdead_date,planned,promised_to,nag_hours,confirmed";
// Trash: a removed task keeps its row with deleted_at set (the app's Put back / Undo). Every read here skips those.
const OFF_SOURCES = ["pcg_holiday", "pto"]; // all-day rows in fm_meetings that take the whole day off

/* ---------------- tools ---------------- */
const taskProps = {
  title: { type: "string" },
  notes: { type: "string" },
  bucket: { type: "string", enum: ["work", "home"] },
  priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
  status: { type: "string", enum: ["not_started", "working", "waiting", "done"] },
  waiting_on: { type: "string" },
  job: { type: "string", description: "A job name from list_jobs, or null" },
  size: { type: "string", enum: ["15m", "1h", "half", "full"], description: "How long it takes Adam. Default 1h." },
  scheduled_date: { type: "string", description: "YYYY-MM-DD the day it sits on the calendar. Null = unscheduled." },
  target_date: { type: "string", description: "YYYY-MM-DD Adam would like it done by" },
  dropdead_date: { type: "string", description: "YYYY-MM-DD it MUST be done by" },
  promised_to: { type: "string", description: "Person Adam owes this to" },
  nag_hours: { type: "number", description: "0 = no nag; else nag every N hours until done" },
  planned: { type: "boolean", description: "true = penciled in (Adam's intent, dashed)" },
  confirmed: { type: "boolean", description: "true ONLY when Adam himself stated the size and the priority. Otherwise leave false: the app shows a '?' badge so he can set them." },
};

const TOOLS: Anthropic.Tool[] = [
  { name: "list_jobs", description: "Adam's job/bucket names (work and home).", input_schema: { type: "object", properties: {} } },
  {
    name: "list_tasks",
    description: "Open tasks: everything unscheduled plus everything scheduled from today through today+window_days. Call this FIRST before scheduling or moving anything, so you know what is already on the calendar.",
    input_schema: { type: "object", properties: { window_days: { type: "number", description: "default 21" }, include_done: { type: "boolean" } } },
  },
  {
    name: "day_load",
    description: "Hours already booked per day = work tasks (by size; default 1h) + meetings Adam attends, against an 8-hour work day; weekends and days off (PCG holidays, PTO) have 0 hours. Also lists tasks whose size/priority are still guesses (confirmed=false). Use before placing or moving work.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  {
    name: "add_task",
    description: "Create a task. Always give bucket, priority, size and a scheduled_date unless Adam clearly wants it unscheduled. Set target/dropdead when he gave a deadline.",
    input_schema: { type: "object", properties: taskProps, required: ["title", "bucket", "priority"] },
  },
  {
    name: "update_task",
    description: "Change fields on an existing task (move it = change scheduled_date; give a reason when moving). Only pass the fields that change.",
    input_schema: { type: "object", properties: { id: { type: "number" }, reason: { type: "string", description: "Why, in Adam's words (shown to him)" }, ...taskProps }, required: ["id"] },
  },
  { name: "complete_task", description: "Mark a task done.", input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "delete_task", description: "Remove a task to the Trash (it can be put back for 30 days). ONLY when Adam explicitly says delete/remove, or to remove an exact duplicate.", input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  // ---- bills (the ledger: fm_bills · fm_bill_payments · fm_accounts) ----
  {
    name: "list_bills",
    description: "Adam's bills: everything past due (unpaid, up to 75 days back), everything due in the next 14 days, and this month's totals (left to pay / paid). Call this before answering anything about bills or money due, and before mark_bill_paid so you use the right bill id and due date.",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM to summarize (default: this month)" } } },
  },
  {
    name: "mark_bill_paid",
    description: "Mark ONE bill occurrence paid — only when Adam himself says he paid it (\"I paid PSE\", \"the mortgage went through\"). Never on your own. Give bill_id (from list_bills) and the due_date of the occurrence (default: the most recent unpaid one on or before today+7).",
    input_schema: { type: "object", properties: { bill_id: { type: "number" }, due_date: { type: "string", description: "YYYY-MM-DD of the occurrence" }, note: { type: "string" } }, required: ["bill_id"] },
  },
  {
    name: "unmark_bill_paid",
    description: "Undo a paid mark when Adam says it was wrong (\"I didn't actually pay Comcast\").",
    input_schema: { type: "object", properties: { bill_id: { type: "number" }, due_date: { type: "string" } }, required: ["bill_id", "due_date"] },
  },
  {
    name: "add_bill",
    description: "Add a new recurring bill when Adam says he has a new one. Needs name, amount and the first/next due date. recur: monthly (default) | biweekly | yearly | once.",
    input_schema: { type: "object", properties: { name: { type: "string" }, amount: { type: "number" }, anchor_date: { type: "string", description: "YYYY-MM-DD a due date it falls on" }, recur: { type: "string", enum: ["monthly", "biweekly", "yearly", "once"] }, domain: { type: "string", description: "company website for the logo, e.g. pse.com" }, remind_days: { type: "number" }, autopay: { type: "boolean" }, account: { type: "string", description: "bank / nickname / last digits of the account it pays from, matched against his accounts" }, notes: { type: "string" } }, required: ["name", "amount", "anchor_date"] },
  },
  {
    name: "update_bill",
    description: "Change a bill (new amount, new due day, ended — pass ended_on as the last due date — autopay, account). Only the fields that change.",
    input_schema: { type: "object", properties: { id: { type: "number" }, name: { type: "string" }, amount: { type: "number" }, anchor_date: { type: "string" }, recur: { type: "string", enum: ["monthly", "biweekly", "yearly", "once"] }, domain: { type: "string" }, remind_days: { type: "number" }, autopay: { type: "boolean" }, account: { type: "string" }, notes: { type: "string" }, ended_on: { type: "string", description: "YYYY-MM-DD last due date it applies to; null = ongoing" } }, required: ["id"] },
  },
  // ---- days off (all-day PTO rows in fm_meetings; the app hatches the day the moment the row lands) ----
  {
    name: "add_day_off",
    description: "Mark one day or a run of days as PTO / a day off (\"I'm taking Monday off\", \"PTO on the 9th\", \"out Friday\", \"sick today\", \"vacation Dec 14-18\"). NEVER add_task for a day off. Weekends are skipped (already off); days already off are left alone. After this, use day_load and move any WORK task off those days with update_task (one-line reason each).",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD first day off" }, to: { type: "string", description: "YYYY-MM-DD last day off (default = from)" }, title: { type: "string", description: "Short label shown on the day, e.g. 'PTO — Mom's estate sale' or 'Sick day'. Default 'PTO — day off'." } }, required: ["from"] },
  },
  {
    name: "remove_day_off",
    description: "Un-mark a PTO day when Adam says he is working it after all (\"cancel my PTO Friday\", \"I'm not taking the 9th off\"). Company holidays cannot be removed.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] },
  },
  {
    name: "ask_adam",
    description: "Stop and ask Adam 1 to 3 short multiple-choice questions you truly need answered before you can file or schedule correctly (a missing deadline, which job, whether something can slip). Do NOT ask about things you can decide with the rules. After calling this, stop; Adam's answers come back as the next message.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array", maxItems: 3,
          items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 } }, required: ["id", "question", "options"] },
        },
      },
      required: ["questions"],
    },
  },
];

type Action = { kind: string; id?: number; title?: string; from?: string | null; to?: string | null; reason?: string };

async function logMove(db: DB, batch: string, kind: string, taskId: number | null, before: unknown, after: unknown, reason: string) {
  await db.from("fm_moves").insert({ batch_id: batch, kind, task_id: taskId, before, after, reason,
    from_date: (before as { scheduled_date?: string })?.scheduled_date ?? null, to_date: (after as { scheduled_date?: string })?.scheduled_date ?? null });
}

function cleanPatch(input: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const k of Object.keys(taskProps)) {
    if (!(k in input)) continue;
    let v = input[k];
    if (typeof v === "string") { v = v.trim(); if (v === "") v = null; }
    if ((k === "scheduled_date" || k === "target_date" || k === "dropdead_date") && v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) continue;
    p[k] = v;
  }
  return p;
}

/* ---------------- bills: occurrences are computed, never stored (mirror of js/bills.js) ---------------- */
type Bill = { id: number; name: string; domain: string | null; amount: number; recur: string; anchor_date: string; account_id: number | null; remind_days: number; autopay: boolean; notes: string | null; ended_on: string | null };
type Pay = { id: number; bill_id: number; due_date: string; paid_at: string; source: string; note: string | null };
type Acct = { id: number; bank: string; nick: string | null; last4: string | null };
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const dateOf = (s: string) => new Date(s + "T12:00:00Z");
const addDaysISO = (s: string, n: number) => isoDate(new Date(dateOf(s).getTime() + n * 86400000));
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function dueDatesInMonth(b: Bill, y: number, m: number): string[] {
  const a = dateOf(b.anchor_date), out: string[] = [];
  if (b.recur === "monthly") out.push(`${y}-${pad2(m + 1)}-${pad2(Math.min(a.getUTCDate(), daysInMonth(y, m)))}`);
  else if (b.recur === "yearly") { if (a.getUTCMonth() === m) out.push(`${y}-${pad2(m + 1)}-${pad2(Math.min(a.getUTCDate(), daysInMonth(y, m)))}`); }
  else if (b.recur === "once") { if (a.getUTCFullYear() === y && a.getUTCMonth() === m) out.push(b.anchor_date); }
  else if (b.recur === "biweekly") { const n = daysInMonth(y, m); for (let d = 1; d <= n; d++) { const dt = Date.UTC(y, m, d, 12); const diff = Math.round((dt - a.getTime()) / 86400000); if (diff >= 0 && diff % 14 === 0) out.push(`${y}-${pad2(m + 1)}-${pad2(d)}`); } }
  return out.filter((d) => d >= b.anchor_date && (!b.ended_on || d <= b.ended_on));
}
function occurrencesBetween(bills: Bill[], from: string, to: string): { bill: Bill; due: string }[] {
  const out: { bill: Bill; due: string }[] = [];
  const f = dateOf(from), t = dateOf(to);
  for (let y = f.getUTCFullYear(), m = f.getUTCMonth(); y < t.getUTCFullYear() || (y === t.getUTCFullYear() && m <= t.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
    for (const b of bills) for (const due of dueDatesInMonth(b, y, m)) if (due >= from && due <= to) out.push({ bill: b, due });
  }
  return out.sort((p, q) => p.due.localeCompare(q.due));
}
const money = (n: number) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
async function loadLedger(db: DB) {
  const [b, p, a] = await Promise.all([
    db.from("fm_bills").select("id,name,domain,amount,recur,anchor_date,account_id,remind_days,autopay,notes,ended_on").is("deleted_at", null).order("sort"),
    db.from("fm_bill_payments").select("id,bill_id,due_date,paid_at,source,note").gte("due_date", addDaysISO(new Date().toISOString().slice(0, 10), -120)),
    db.from("fm_accounts").select("id,bank,nick,last4"),
  ]);
  if (b.error) throw new Error(b.error.message);
  const bills = (b.data || []).map((x: Bill) => ({ ...x, amount: Number(x.amount) })) as Bill[];
  return { bills, pays: (p.data || []) as Pay[], accts: (a.data || []) as Acct[] };
}
const acctLabel = (accts: Acct[], id: number | null) => { const a = accts.find((x) => x.id === id); return a ? `${a.bank}${a.nick ? " · " + a.nick : ""}${a.last4 ? " ••" + String(a.last4).slice(-4) : ""}` : null; };
function matchAccount(accts: Acct[], text?: string): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const hit = accts.find((a) => `${a.bank} ${a.nick || ""} ${a.last4 || ""}`.toLowerCase().includes(t)) || accts.find((a) => t.includes(String(a.last4 || "").slice(-4)) && a.last4);
  return hit ? hit.id : null;
}

/* ---------------- days off: all-day rows in fm_meetings (source pto), ext_key pto-<date> ---------------- */
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayName = (iso: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dateOf(iso).getUTCDay()];
async function addDaysOff(db: DB, uid: string, input: { from?: string; to?: string; title?: string }, batch: string, actions: Action[]): Promise<string> {
  const from = String(input?.from || "");
  const to = String(input?.to || from);
  if (!ISO_RE.test(from) || !ISO_RE.test(to)) return "ERROR: from/to must be YYYY-MM-DD";
  if (to < from) return "ERROR: to is before from";
  if ((dateOf(to).getTime() - dateOf(from).getTime()) / 86400000 > 31) return "ERROR: more than 31 days — split it up or check the dates";
  const title = (String(input?.title || "").trim() || "PTO — day off").slice(0, 80);
  const { data: existing } = await db.from("fm_meetings").select("day,title,source").gte("day", from).lte("day", to).eq("all_day", true).in("source", OFF_SOURCES);
  const already = new Map<string, string>((existing || []).map((m: { day: string; title: string }) => [m.day, m.title] as [string, string]));
  const added: string[] = [], skipped: string[] = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) {
    const dow = dateOf(d).getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekends are already off
    if (already.has(d)) { skipped.push(`${d} ${dayName(d)} already off (${already.get(d)})`); continue; }
    const row = { user_id: uid, source: "pto", ext_key: `pto-${d}`, title, day: d, start_at: `${d}T00:00:00Z`, end_at: `${addDaysISO(d, 1)}T00:00:00Z`, all_day: true, attending: false };
    const { data, error } = await db.from("fm_meetings").insert(row).select("id,day,title,source").single();
    if (error) return `ERROR on ${d}: ${error.message}${added.length ? ` (already marked: ${added.join(", ")})` : ""}`;
    await db.from("fm_moves").insert({ batch_id: batch, kind: "off_add", task_id: null, before: null, after: data, reason: "Adam said he is off this day", to_date: d });
    actions.push({ kind: "off_add", id: data.id, title, to: d });
    added.push(`${d} ${dayName(d)}`);
  }
  // what is sitting on those days — the model moves work off them
  const { data: sitting } = await db.from("fm_tasks").select("id,title,scheduled_date,size,bucket").is("deleted_at", null).neq("status", "done").gte("scheduled_date", from).lte("scheduled_date", to);
  const work = (sitting || []).filter((t: { bucket: string }) => t.bucket === "work");
  const out = [added.length ? `Marked off (hatched in the app): ${added.join(", ")} — "${title}".` : "Nothing new to mark — those days were already off."];
  if (skipped.length) out.push("Skipped: " + skipped.join("; "));
  if (work.length) out.push(`WORK tasks sitting on a day off — move each one with update_task (not past a drop-dead, not promised items): ` + work.map((t: { id: number; title: string; scheduled_date: string; size: string }) => `#${t.id} ${t.title} (${t.size}, on ${t.scheduled_date})`).join("; "));
  else out.push("No work tasks on those days.");
  return out.join("\n");
}
async function removeDayOff(db: DB, input: { date?: string }, batch: string, actions: Action[]): Promise<string> {
  const d = String(input?.date || "");
  if (!ISO_RE.test(d)) return "ERROR: date must be YYYY-MM-DD";
  const { data: rows } = await db.from("fm_meetings").select("id,day,title,source").eq("day", d).eq("all_day", true).in("source", OFF_SOURCES);
  const pto = (rows || []).find((m: { source: string }) => m.source === "pto");
  if (!pto) return (rows || []).length ? `${d} is a company holiday (${rows![0].title}) — that cannot be removed.` : `${d} was not marked as a day off.`;
  const { error } = await db.from("fm_meetings").delete().eq("id", pto.id);
  if (error) return "ERROR: " + error.message;
  await db.from("fm_moves").insert({ batch_id: batch, kind: "off_remove", task_id: null, before: pto, after: null, reason: "Adam said he is working this day after all", from_date: d });
  actions.push({ kind: "off_remove", id: pto.id, title: pto.title, from: d });
  return `${d} ${dayName(d)} is a work day again (was "${pto.title}").`;
}

// deno-lint-ignore no-explicit-any
async function runTool(db: DB, uid: string, name: string, input: any, today: string, batch: string, actions: Action[]): Promise<string> {
  if (name === "add_day_off") return addDaysOff(db, uid, input, batch, actions);
  if (name === "remove_day_off") return removeDayOff(db, input, batch, actions);
  if (name === "list_bills") {
    const { bills, pays, accts } = await loadLedger(db);
    const paid = (b: Bill, due: string) => pays.find((p) => p.bill_id === b.id && p.due_date === due);
    const ym = /^\d{4}-\d{2}$/.test(String(input?.month || "")) ? String(input.month) : today.slice(0, 7);
    const [y, m] = ym.split("-").map(Number);
    const monthOcc = occurrencesBetween(bills, `${ym}-01`, `${ym}-${pad2(daysInMonth(y, m - 1))}`);
    const total = monthOcc.reduce((s, o) => s + o.bill.amount, 0), paidSum = monthOcc.filter((o) => paid(o.bill, o.due)).reduce((s, o) => s + o.bill.amount, 0);
    const late = occurrencesBetween(bills, addDaysISO(today, -75), addDaysISO(today, -1)).filter((o) => !paid(o.bill, o.due));
    const soon = occurrencesBetween(bills, today, addDaysISO(today, 14)).filter((o) => !paid(o.bill, o.due));
    const line = (o: { bill: Bill; due: string }) => `#${o.bill.id} ${o.bill.name} ${money(o.bill.amount)} due ${o.due}${o.bill.autopay ? " (autopay)" : ""}${acctLabel(accts, o.bill.account_id) ? " from " + acctLabel(accts, o.bill.account_id) : ""}`;
    const out = [`MONTH ${ym}: ${money(total - paidSum)} left of ${money(total)} · ${monthOcc.filter((o) => paid(o.bill, o.due)).length} of ${monthOcc.length} paid`];
    out.push(late.length ? `PAST DUE (${late.length}, ${money(late.reduce((s, o) => s + o.bill.amount, 0))}): ` + late.map((o) => line(o) + ` — ${Math.round((dateOf(today).getTime() - dateOf(o.due).getTime()) / 86400000)} days late`).join("; ") : "PAST DUE: none");
    out.push(soon.length ? `DUE NEXT 14 DAYS: ` + soon.map(line).join("; ") : "DUE NEXT 14 DAYS: none");
    out.push(`ALL BILLS: ` + bills.map((b) => `#${b.id} ${b.name} ${money(b.amount)} ${b.recur} (day ${Number(b.anchor_date.slice(8, 10))})`).join("; "));
    return out.join("\n");
  }
  if (name === "mark_bill_paid" || name === "unmark_bill_paid") {
    const { bills, pays } = await loadLedger(db);
    const bill = bills.find((b) => b.id === Number(input?.bill_id));
    if (!bill) return "ERROR: no bill with that id — call list_bills";
    let due = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.due_date || "")) ? String(input.due_date) : "";
    if (!due) {
      const cands = occurrencesBetween([bill], addDaysISO(today, -75), addDaysISO(today, 7)).filter((o) => !pays.some((p) => p.bill_id === bill.id && p.due_date === o.due));
      if (!cands.length) return `Nothing unpaid for ${bill.name} between 75 days ago and next week.`;
      due = cands[cands.length - 1].due;
    }
    const existing = pays.find((p) => p.bill_id === bill.id && p.due_date === due);
    if (name === "mark_bill_paid") {
      if (existing) return `${bill.name} due ${due} is already marked paid.`;
      const { data, error } = await db.from("fm_bill_payments").insert({ bill_id: bill.id, due_date: due, source: "brain", note: input?.note ? String(input.note).slice(0, 200) : null }).select().single();
      if (error) return "ERROR: " + error.message;
      await db.from("fm_moves").insert({ batch_id: batch, kind: "bill_paid", task_id: null, before: { bill_id: bill.id, name: bill.name, due_date: due, paid: false }, after: { ...data, name: bill.name }, reason: "Adam said he paid it" });
      actions.push({ kind: "bill_paid", id: bill.id, title: `${bill.name} ${money(bill.amount)} (due ${due})` });
      return `Marked paid: ${bill.name} ${money(bill.amount)} due ${due}.`;
    }
    if (!existing) return `${bill.name} due ${due} was not marked paid.`;
    const { error } = await db.from("fm_bill_payments").delete().eq("id", existing.id);
    if (error) return "ERROR: " + error.message;
    await db.from("fm_moves").insert({ batch_id: batch, kind: "bill_unpaid", task_id: null, before: { ...existing, name: bill.name }, after: { bill_id: bill.id, name: bill.name, due_date: due, paid: false }, reason: "Adam said it was not paid" });
    actions.push({ kind: "bill_unpaid", id: bill.id, title: `${bill.name} (due ${due})` });
    return `Un-marked: ${bill.name} due ${due} is unpaid again.`;
  }
  if (name === "add_bill" || name === "update_bill") {
    const { bills, accts } = await loadLedger(db);
    const row: Record<string, unknown> = {};
    for (const k of ["name", "amount", "anchor_date", "recur", "domain", "remind_days", "autopay", "notes", "ended_on"]) if (input?.[k] !== undefined && input[k] !== null) row[k] = input[k];
    if ("account" in (input || {})) row.account_id = matchAccount(accts, input.account);
    if (typeof row.domain === "string") row.domain = String(row.domain).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase() || null;
    if (row.anchor_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.anchor_date))) return "ERROR: anchor_date must be YYYY-MM-DD";
    if (name === "add_bill") {
      if (!(Number(row.amount) > 0)) return "ERROR: amount must be > 0";
      row.recur ??= "monthly"; row.remind_days ??= 2; row.sort = Number(String(row.anchor_date).slice(8, 10));
      const { data, error } = await db.from("fm_bills").insert(row).select("id,name,amount,anchor_date,recur").single();
      if (error) return "ERROR: " + error.message;
      await db.from("fm_moves").insert({ batch_id: batch, kind: "bill_add", task_id: null, before: null, after: data, reason: "Adam said he has a new bill" });
      actions.push({ kind: "bill_add", id: data.id, title: `${data.name} ${money(Number(data.amount))} ${data.recur}` });
      return "Added bill: " + JSON.stringify(data);
    }
    const bill = bills.find((b) => b.id === Number(input?.id));
    if (!bill) return "ERROR: no bill with that id — call list_bills";
    if (!Object.keys(row).length) return "ERROR: nothing to change";
    const before: Record<string, unknown> = {}; for (const k of Object.keys(row)) before[k] = (bill as Record<string, unknown>)[k] ?? null;
    const { data, error } = await db.from("fm_bills").update(row).eq("id", bill.id).select("id,name,amount,anchor_date,recur,ended_on,autopay,account_id").single();
    if (error) return "ERROR: " + error.message;
    await db.from("fm_moves").insert({ batch_id: batch, kind: "bill_update", task_id: null, before: { id: bill.id, name: bill.name, ...before }, after: { id: bill.id, ...row }, reason: String(input?.reason || "Adam changed a bill") });
    actions.push({ kind: "bill_update", id: bill.id, title: bill.name });
    return "Updated bill: " + JSON.stringify(data);
  }
  if (name === "list_jobs") {
    const { data, error } = await db.from("fm_jobs").select("name,bucket").eq("active", true).order("bucket").order("sort");
    return error ? "ERROR: " + error.message : JSON.stringify(data);
  }
  if (name === "list_tasks") {
    const win = Math.max(1, Math.min(90, Number(input?.window_days) || 21));
    const until = new Date(new Date(today + "T12:00:00Z").getTime() + win * 86400000).toISOString().slice(0, 10);
    let q = db.from("fm_tasks").select(TASK_FIELDS).is("deleted_at", null).or(`scheduled_date.is.null,and(scheduled_date.gte.${today},scheduled_date.lte.${until}),dropdead_date.lt.${today},target_date.lt.${today}`).order("scheduled_date", { nullsFirst: true }).limit(200);
    if (!input?.include_done) q = q.neq("status", "done");
    const { data, error } = await q;
    return error ? "ERROR: " + error.message : (data?.length ? JSON.stringify(data) : "No open tasks.");
  }
  if (name === "day_load") {
    const { data, error } = await db.from("fm_tasks").select("id,title,scheduled_date,size,status,bucket,confirmed").is("deleted_at", null).gte("scheduled_date", input.from).lte("scheduled_date", input.to).neq("status", "done");
    if (error) return "ERROR: " + error.message;
    const { data: mtgs } = await db.from("fm_meetings").select("day,title,start_at,end_at,all_day,attending,source").gte("day", input.from).lte("day", input.to);
    const work: Record<string, number> = {}, unconfirmed: Record<string, string[]> = {}, mtg: Record<string, number> = {}, off: Record<string, string> = {};
    for (const t of data || []) {
      if (t.bucket === "work") work[t.scheduled_date] = (work[t.scheduled_date] || 0) + (SIZE_HOURS[t.size || "1h"] ?? 1);
      if (!t.confirmed) (unconfirmed[t.scheduled_date] ||= []).push(`#${t.id} ${t.title}`);
    }
    for (const m of mtgs || []) {
      if (m.all_day && OFF_SOURCES.includes(m.source)) off[m.day] = m.title;
      else if (!m.all_day && m.attending) mtg[m.day] = (mtg[m.day] || 0) + Math.max(0, (new Date(m.end_at).getTime() - new Date(m.start_at).getTime()) / 3600000);
    }
    const out: string[] = [];
    const a = new Date(input.from + "T12:00:00Z"), b = new Date(input.to + "T12:00:00Z");
    for (let d = a; d <= b; d = new Date(d.getTime() + 86400000)) {
      const k = d.toISOString().slice(0, 10), dow = d.getUTCDay(), name = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
      const weekend = dow === 0 || dow === 6;
      const w = work[k] || 0, m = weekend || off[k] ? 0 : (mtg[k] || 0), cap = weekend || off[k] ? 0 : DAY_HOURS;
      let line = off[k] ? `${k} ${name}: OFF (${off[k]}) — no work goes here${w ? `; ${w}h of tasks sitting on it must move` : ""}`
        : weekend ? `${k} ${name}: weekend (home only)${w ? `; ${w}h of work tasks on it should move` : ""}`
        : `${k} ${name}: ${w}h tasks + ${m}h meetings = ${w + m}h of ${cap}h${w + m > cap ? " — OVER" : ""}`;
      if (unconfirmed[k]?.length) line += ` · size/priority still guessed: ${unconfirmed[k].join("; ")}`;
      out.push(line);
    }
    return out.join("\n");
  }
  if (name === "add_task") {
    const row = { ...cleanPatch(input), source: "brain" } as Record<string, unknown>;
    if (!row.size) row.size = "1h";
    if (!row.status) row.status = "not_started";
    if (row.confirmed !== true) row.confirmed = false;
    const { data, error } = await db.from("fm_tasks").insert(row).select(TASK_FIELDS).single();
    if (error) return "ERROR: " + error.message;
    await logMove(db, batch, "add", data.id, null, data, "");
    actions.push({ kind: "add", id: data.id, title: data.title, to: data.scheduled_date });
    return "Added: " + JSON.stringify(data);
  }
  if (name === "update_task") {
    const id = Number(input?.id); if (!Number.isFinite(id)) return "ERROR: missing id";
    const { data: before } = await db.from("fm_tasks").select(TASK_FIELDS).eq("id", id).is("deleted_at", null).maybeSingle();
    if (!before) return "ERROR: no task with that id (or it is in the Trash)";
    if (before.promised_to && input.scheduled_date && input.scheduled_date !== before.scheduled_date && !/promis|adam said|adam ok|he said/i.test(String(input.reason || ""))) {
      return `REFUSED: task ${id} is promised to ${before.promised_to}. Do not move it unless Adam explicitly said to; if he did, include 'Adam said' in the reason.`;
    }
    const patch = cleanPatch(input);
    if (patch.dropdead_date && patch.scheduled_date && String(patch.scheduled_date) > String(patch.dropdead_date)) return "REFUSED: scheduled_date is past the drop-dead date.";
    if (!patch.dropdead_date && before.dropdead_date && patch.scheduled_date && String(patch.scheduled_date) > before.dropdead_date) return `REFUSED: scheduled_date is past the drop-dead date ${before.dropdead_date}.`;
    if (patch.scheduled_date && patch.scheduled_date !== before.scheduled_date) patch.planned = patch.planned ?? false;
    const { data, error } = await db.from("fm_tasks").update(patch).eq("id", id).select(TASK_FIELDS).single();
    if (error) return "ERROR: " + error.message;
    const moved = "scheduled_date" in patch && patch.scheduled_date !== before.scheduled_date;
    await logMove(db, batch, moved ? "move" : "update", id, before, data, String(input.reason || ""));
    actions.push({ kind: moved ? "move" : "update", id, title: data.title, from: before.scheduled_date, to: data.scheduled_date, reason: String(input.reason || "") });
    return "Updated: " + JSON.stringify(data);
  }
  if (name === "complete_task") {
    const id = Number(input?.id); if (!Number.isFinite(id)) return "ERROR: missing id";
    const { data: before } = await db.from("fm_tasks").select(TASK_FIELDS).eq("id", id).is("deleted_at", null).maybeSingle();
    if (!before) return "ERROR: no task with that id (or it is in the Trash)";
    const { data, error } = await db.from("fm_tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", id).select(TASK_FIELDS).single();
    if (error) return "ERROR: " + error.message;
    await logMove(db, batch, "complete", id, before, data, "");
    actions.push({ kind: "complete", id, title: data.title });
    return "Done: " + data.title;
  }
  if (name === "delete_task") {
    // soft delete: the row stays with deleted_at set, so the app's Trash can Put it back and Undo works
    const id = Number(input?.id); if (!Number.isFinite(id)) return "ERROR: missing id";
    const { data: before } = await db.from("fm_tasks").select(TASK_FIELDS).eq("id", id).is("deleted_at", null).maybeSingle();
    if (!before) return "ERROR: no task with that id (or it is already in the Trash)";
    const { error } = await db.from("fm_tasks").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (error) return "ERROR: " + error.message;
    await logMove(db, batch, "delete", id, before, null, "Adam said remove/delete");
    actions.push({ kind: "delete", id, title: before.title });
    return "Removed to the Trash: " + before.title;
  }
  return "ERROR: unknown tool";
}

function systemPrompt(today: string, now: string): string {
  const base = new Date(today + "T12:00:00Z");
  const weekday = base.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const cal: string[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    cal.push(`${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${d.toISOString().slice(0, 10)}`);
  }
  return `You are AP, Adam's personal assistant and office manager (the app is "AP Personal Assistant"). Adam is a VDC/BIM specialist at a drywall/framing subcontractor (Revit, AutoCAD, Navisworks, Dusty layout). He has ADD. Your job: he talks, you file, schedule and keep his calendar true so he can just look and do the next thing. He does NOT want to manage this; you do.

Today is ${weekday} ${today}${now ? `, ${now}` : ""} (Pacific). Upcoming: ${cal.join(" · ")}. Use these dates exactly; never compute dates yourself.

RULES
1. Call list_jobs and list_tasks before adding or moving anything. Match new items to existing tasks (update, don't duplicate).
2. Every task gets: bucket (work unless clearly home), priority, size (default 1h), and a scheduled_date. Unscheduled only if Adam says "someday" or similar.
3. Work days are Mon-Fri, 7am-4pm, 8 working hours. Use day_load; it already counts meetings Adam attends. Do not put more than 8h on a day. Days marked OFF (PCG holidays, PTO) and weekends hold NO work — move anything that lands there. Weekends: home bucket only, unless Adam says otherwise.
4. Two dates: target (wants it by) and drop-dead (must be by). Set them when he gives a deadline. Never schedule past a drop-dead. If a drop-dead is at risk, say so plainly.
5. Reshuffle: when a day is full or Adam pencils in new intent, push LOW then NORMAL items toward their target, never past drop-dead. Never move anything with promised_to unless Adam explicitly says so. Urgent stays on today. Give a one-line reason on every move.
6. Priority: urgent = today or someone is blocked; high = this week or a person is waiting; normal = default; low = whenever.
7. People: if Adam says he told someone X or owes someone X, set promised_to. If he is waiting on someone, status=waiting + waiting_on.
8. Ask with ask_adam ONLY when you cannot decide with these rules (missing deadline on something that clearly has one, which job it belongs to, whether a promised item can slip). Max 3 short A/B/C questions. Otherwise decide and go.
9. Brain dumps: split into separate tasks. Dates like "end of week" = Friday; "next week" = the following Monday unless he says a day.
10. Sizes and priorities you guess stay confirmed=false (the app shows a "?" badge). Set confirmed=true only when Adam himself states the size and the priority. When a day is over 8h and tasks on it are still guesses, ask him for their size/priority in ONE short ask_adam question before moving things.
11. "Balance this week" means: apply rules 3-5 to Mon-Fri of that week — low first, then normal, toward their targets; never past a drop-dead; never a promised item; urgent stays. Every move gets a one-line reason.
12. Be plain and short. Your final reply is read on screen: 2-5 lines, what you filed and what you moved and why. No markdown headers, no fluff.
13. BILLS live in the bill ledger, not in tasks: never add_task for a bill. "I paid X" / "X went through" → list_bills, then mark_bill_paid for that bill (the occurrence he means; default the latest unpaid). "I didn't pay X" → unmark_bill_paid. A new bill → add_bill (ask for the amount or due date only if he gave neither). Any question about bills, money due or past due → list_bills and answer from it. A bill is paid ONLY when Adam says so — never mark one paid because a date passed or an alert fired. Past-due bills are the first thing to mention when he asks how he is doing.
14. DAYS OFF are never tasks. "I'm taking Monday off", "PTO on the 9th", "out Friday", "sick today", "vacation Dec 14-18", "mark the 9th as PTO" → add_day_off (never add_task). The app hatches that day the moment the row lands, exactly like the Japan trip and the company holidays, and the day drops to 0 hours. Then day_load for those days and move every WORK task off them with update_task, one-line reason each (home items can stay). "I'm working the 9th after all" / "cancel my PTO Friday" → remove_day_off. Company holidays cannot be removed. If a day off already exists as a task, remove_day_off is not needed — delete_task that task and add_day_off instead.
15. WHAT YOU CONTROL: everything the calendar draws from — tasks, days off, bills, which meetings count. Hatched day = a day-off row; chip = a task; "?" = a guessed size. You do not pick colors or layout; if Adam asks for a look change, say that is done in a Claude chat and carry on with the filing. Never tell him to report something to "the app developer" — he and Claude are the developers. If you cannot do something, say exactly what in one line.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(req, { error: "unauthorized" }, 401);
  const db = userClient(jwt);
  const { data: userData, error: userErr } = await db.auth.getUser();
  if (userErr || !userData?.user) return json(req, { error: "unauthorized" }, 401);
  if (!OWNER_IDS.has(userData.user.id)) return json(req, { error: "forbidden" }, 403);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(req, { reply: "Brain not connected: ANTHROPIC_API_KEY missing on the server." });

  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "").slice(0, 4000).trim();
  if (!text) return json(req, { error: "missing_text" }, 400);
  const today = /^\d{4}-\d{2}-\d{2}/.test(String(body.today || "")) ? String(body.today).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const now = String(body.now || "").slice(0, 12);
  const batch = String(body.batch_id || crypto.randomUUID());
  const history: Anthropic.MessageParam[] = Array.isArray(body.history)
    ? body.history.filter((m: { role?: string; content?: string }) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
      .slice(-10).map((m: { role: string; content: string }) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, 4000) }))
    : [];

  const anthropic = new Anthropic({ apiKey, defaultHeaders: { "anthropic-workspace-id": "wrkspc_015q3sE1pfNpE6yuyx43qXdA" } });
  const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: text }];
  const actions: Action[] = [];

  try {
    let lastText = "";
    for (let i = 0; i < 12; i++) {
      const response = await anthropic.messages.create({ model: MODEL, max_tokens: 1500, system: systemPrompt(today, now), tools: TOOLS, messages });
      const turnText = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
      if (turnText) lastText = turnText;

      if (response.stop_reason === "tool_use") {
        const ask = response.content.find((b) => b.type === "tool_use" && b.name === "ask_adam") as Anthropic.ToolUseBlock | undefined;
        if (ask) {
          const qs = (ask.input as { questions: unknown[] }).questions;
          const reply = turnText || "Quick questions before I file this:";
          await db.from("fm_brain_log").insert({ batch_id: batch, said: text, reply, actions: { actions, questions: qs } });
          return json(req, { reply, questions: qs, actions, batch_id: batch, pending: true });
        }
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const out = await runTool(db, userData.user.id, block.name, block.input, today, batch, actions);
          results.push({ type: "tool_result", tool_use_id: block.id, content: out });
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      const reply = turnText || lastText || "Done.";
      await db.from("fm_brain_log").insert({ batch_id: batch, said: text, reply, actions });
      return json(req, { reply, actions, batch_id: batch });
    }
    await db.from("fm_brain_log").insert({ batch_id: batch, said: text, reply: "(ran out of steps)", actions });
    return json(req, { reply: "That took more steps than I expected. Here's what landed so far; tell me the rest again.", actions, batch_id: batch });
  } catch (e) {
    console.error("ap-brain error:", e);
    const msg = e instanceof Anthropic.AuthenticationError ? "The Anthropic key on the server is invalid."
      : e instanceof Anthropic.RateLimitError ? "Rate limited for a moment. Try again in a few seconds."
      : "Something went wrong in the brain. Try again. (" + String((e as Error)?.message || e).slice(0, 120) + ")";
    return json(req, { reply: msg, actions, batch_id: batch, error: true });
  }
});
