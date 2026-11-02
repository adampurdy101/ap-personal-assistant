// ap-meetings — reads the published PCI Outlook calendar (ICS) and writes
// meeting TITLES and TIMES only into public.fm_meetings so the AP Personal Assistant app can draw them.
// Rows from other sources (pcg_holiday, pto = days off) are never touched here.
// The ICS link lives in public.fm_settings (service-role only), never in the repo.
// Called every 15 min by pg_cron (x-cron-key header) or by the signed-in owner (Refresh).
import ICAL from "npm:ical.js@2.1.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const OWNER = "30cbcbfa-7261-47de-8c91-3d97557fc5f9";
const TZ = "America/Los_Angeles";
const PAST_DAYS = 14;
const AHEAD_DAYS = 90;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const pacificDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function cleanTitle(s: string) {
  return String(s || "(no title)").replace(/^\s*(fw|fwd|re)\s*:\s*/i, "").trim() || "(no title)";
}

function toJS(t: any, tzid?: string | null): Date {
  if (tzid && (!t.zone || t.zone.tzid === "floating")) {
    const z = ICAL.TimezoneService.get(tzid);
    if (z) { const c = t.clone(); c.zone = z; return c.toJSDate(); }
  }
  return t.toJSDate();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: rows, error: sErr } = await sb.from("fm_settings").select("key,value").in("key", ["pci_outlook_ics", "meetings_cron_key"]);
  if (sErr) return json({ error: sErr.message }, 500);
  const s: Record<string, string> = Object.fromEntries((rows || []).map((r: any) => [r.key, r.value]));

  const isCron = !!s.meetings_cron_key && req.headers.get("x-cron-key") === s.meetings_cron_key;
  let ok = isCron;
  if (!ok) {
    const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (tok) { const { data } = await sb.auth.getUser(tok); ok = data?.user?.id === OWNER; }
  }
  if (!ok) return json({ error: "not allowed" }, 401);
  if (!s.pci_outlook_ics) return json({ error: "no calendar link saved" }, 400);

  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }

  const res = await fetch(s.pci_outlook_ics, { headers: { "User-Agent": "AP-Assistant/1.0" } });
  if (!res.ok) return json({ error: `calendar link returned ${res.status}` }, 502);
  const text = await res.text();

  // debug (cron key only): date/rule lines only, never descriptions
  if (isCron && typeof body?.debug === "string") {
    const unfolded = text.replace(/\r\n[ \t]/g, "");
    const blocks = unfolded.split("BEGIN:VEVENT").slice(1);
    const want = body.debug.toLowerCase();
    const hits = blocks
      .filter((b) => (b.match(/^SUMMARY[^:]*:(.*)$/m)?.[1] || "").toLowerCase().includes(want))
      .map((b) => b.split(/\r?\n/).filter((l) => /^(SUMMARY|DTSTART|DTEND|RRULE|EXDATE|RECURRENCE-ID|STATUS)/.test(l)).join(" | "));
    const tzids = [...unfolded.matchAll(/^TZID:(.*)$/gm)].map((m) => m[1].trim());
    return json({ hits: hits.slice(0, 8), tzids });
  }

  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(tz); } catch (_) { /* skip */ }
  }

  const now = new Date();
  const winStart = new Date(now.getTime() - PAST_DAYS * 86400000);
  const winEnd = new Date(now.getTime() + AHEAD_DAYS * 86400000);

  const masters = new Map<string, any>();
  const loose: any[] = [];
  const exceptions: any[] = [];
  for (const v of root.getAllSubcomponents("vevent")) {
    if (v.hasProperty("recurrence-id")) exceptions.push(v);
    else masters.set(String(v.getFirstPropertyValue("uid")), new ICAL.Event(v));
  }
  for (const v of exceptions) {
    const ev = new ICAL.Event(v);
    const m = masters.get(String(v.getFirstPropertyValue("uid")));
    if (m) m.relateException(ev); else loose.push(ev);
  }

  const { data: rules } = await sb.from("fm_meeting_rules").select("match_title,attending").eq("user_id", OWNER);
  const attends = (title: string) => {
    const t = title.toLowerCase();
    let a = false;
    for (const r of rules || []) if (t.includes(String(r.match_title).toLowerCase())) a = !!r.attending;
    return a;
  };

  const out: any[] = [];
  const errors: string[] = [];
  const ymd = (t: any) => `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  const push = (uid: string, item: any, sT: any, eT: any) => {
    const comp = item.component;
    const status = String(comp.getFirstPropertyValue("status") || "").toUpperCase();
    if (status === "CANCELLED") return;
    const tzS = comp.getFirstProperty("dtstart")?.getParameter("tzid");
    const tzE = comp.getFirstProperty("dtend")?.getParameter("tzid") || tzS;
    const allDay = !!sT.isDate;
    let start: Date, end: Date, day: string;
    if (allDay) {
      day = ymd(sT);
      start = new Date(day + "T00:00:00Z");
      end = eT ? new Date(ymd(eT) + "T00:00:00Z") : new Date(start.getTime() + 86400000);
    } else {
      start = toJS(sT, tzS);
      end = eT ? toJS(eT, tzE) : new Date(start.getTime() + 3600000);
      day = pacificDay(start);
    }
    if (end < winStart || start > winEnd) return;
    const title = cleanTitle(item.summary);
    out.push({
      user_id: OWNER, source: "pci_outlook", ext_key: `${uid}|${start.toISOString()}`,
      title, start_at: start.toISOString(), end_at: end.toISOString(), all_day: allDay, day,
      attending: attends(title), updated_at: new Date().toISOString(),
    });
  };

  for (const [uid, ev] of masters) {
    try {
      if (!ev.isRecurring()) { push(uid, ev, ev.startDate, ev.endDate); continue; }
      const it = ev.iterator();
      let next: any, guard = 0;
      while ((next = it.next()) && guard++ < 3000) {
        const js = next.toJSDate();
        if (js > winEnd) break;
        if (js.getTime() < winStart.getTime() - 2 * 86400000) continue;
        const d = ev.getOccurrenceDetails(next);
        push(uid, d.item, d.startDate, d.endDate);
      }
    } catch (e) { errors.push(String(e).slice(0, 120)); }
  }
  for (const ev of loose) { try { push(String(ev.uid), ev, ev.startDate, ev.endDate); } catch (e) { errors.push(String(e).slice(0, 120)); } }

  const byKey = new Map(out.map((r) => [r.ext_key, r]));
  const list = [...byKey.values()];

  for (let i = 0; i < list.length; i += 500) {
    const { error } = await sb.from("fm_meetings").upsert(list.slice(i, i + 500), { onConflict: "source,ext_key" });
    if (error) return json({ error: error.message }, 500);
  }
  const keep = new Set(list.map((r) => r.ext_key));
  const { data: existing } = await sb.from("fm_meetings").select("id,ext_key")
    .eq("source", "pci_outlook").gte("start_at", winStart.toISOString()).lte("start_at", winEnd.toISOString());
  const gone = (existing || []).filter((r: any) => !keep.has(r.ext_key)).map((r: any) => r.id);
  if (gone.length) await sb.from("fm_meetings").delete().in("id", gone);

  const summary = { at: new Date().toISOString(), count: list.length, removed: gone.length, errors: errors.slice(0, 5) };
  await sb.from("fm_settings").upsert({ key: "meetings_last_sync", value: summary });
  return json({ ok: true, ...summary });
});
