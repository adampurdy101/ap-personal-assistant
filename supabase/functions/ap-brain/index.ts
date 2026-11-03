// ap-brain  ·  verify_jwt = TRUE
// AP Personal Assistant's brain. The app sends what Adam said (brain dump, a
// question, answers to earlier questions). This calls Claude with tools that
// read/write the fm_tasks table AS THE LOGGED-IN USER (his JWT + anon key, RLS
// applies), files everything, reshuffles within the rules, and returns what it did.
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

// deno-lint-ignore no-explicit-any
async function runTool(db: DB, name: string, input: any, today: string, batch: string, actions: Action[]): Promise<string> {
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
12. Be plain and short. Your final reply is read on screen: 2-5 lines, what you filed and what you moved and why. No markdown headers, no fluff.`;
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
          const out = await runTool(db, block.name, block.input, today, batch, actions);
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
