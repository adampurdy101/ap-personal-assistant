// bills-ics  ·  verify_jwt = FALSE (the feed token in the URL is the credential)
// A personal, read-only iCalendar feed of the owner's bills, for Apple Calendar /
// Google Calendar subscriptions: one all-day event per due date, an alarm `remind_days`
// before (9 AM local), paid ones marked ✓ with no alarm. Reads the AP ledger tables
// (fm_bills / fm_bill_payments / fm_accounts) with the service role, scoped to the
// user whose fm_prefs row holds this token. Calendar apps can't send auth headers,
// so the token IS the credential — random, unguessable, read-only.
import { createClient } from "npm:@supabase/supabase-js@2";

type Bill = { id: number; name: string; amount: number; recur: string; anchor_date: string; account_id: number | null; remind_days: number; autopay: boolean; ended_on: string | null };
type Pay = { bill_id: number; due_date: string };
type Acct = { id: number; bank: string; nick: string | null; last4: string | null };

const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const money = (n: number) => { const r = Math.round(n * 100) / 100; return "$" + (r % 1 === 0 ? r.toLocaleString("en-US") : r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
const dateOf = (s: string) => new Date(s + "T12:00:00Z");
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
// mirror of js/bills.js dueDaysInMonth
function dueDatesInMonth(b: Bill, y: number, m: number): string[] {
  const a = dateOf(b.anchor_date), out: string[] = [];
  const clamp = `${y}-${pad(m + 1)}-${pad(Math.min(a.getUTCDate(), daysInMonth(y, m)))}`;
  if (b.recur === "monthly") out.push(clamp);
  else if (b.recur === "yearly") { if (a.getUTCMonth() === m) out.push(clamp); }
  else if (b.recur === "once") { if (a.getUTCFullYear() === y && a.getUTCMonth() === m) out.push(b.anchor_date); }
  else if (b.recur === "biweekly") { const n = daysInMonth(y, m); for (let d = 1; d <= n; d++) { const diff = Math.round((Date.UTC(y, m, d, 12) - a.getTime()) / 86400000); if (diff >= 0 && diff % 14 === 0) out.push(`${y}-${pad(m + 1)}-${pad(d)}`); } }
  return out.filter((d) => d >= b.anchor_date && (!b.ended_on || d <= b.ended_on));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return new Response("Not found", { status: 404 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: prefs, error: perr } = await admin.from("fm_prefs").select("user_id,value").eq("key", "bills_feed_token");
  const pref = (prefs || []).find((r: { value: unknown }) => r.value === token);
  if (perr || !pref) return new Response("Not found", { status: 404 });
  const uid = pref.user_id as string;

  const [b, p, a] = await Promise.all([
    admin.from("fm_bills").select("id,name,amount,recur,anchor_date,account_id,remind_days,autopay,ended_on").eq("user_id", uid).is("deleted_at", null),
    admin.from("fm_bill_payments").select("bill_id,due_date").eq("user_id", uid),
    admin.from("fm_accounts").select("id,bank,nick,last4").eq("user_id", uid),
  ]);
  if (b.error) return new Response("Not found", { status: 404 });
  const bills = (b.data || []).map((x) => ({ ...x, amount: Number(x.amount) })) as Bill[];
  const pays = (p.data || []) as Pay[];
  const accts = (a.data || []) as Acct[];
  const paid = new Set(pays.map((x) => x.bill_id + ":" + x.due_date));
  const acctLabel = (id: number | null) => { const x = accts.find((y) => y.id === id); return x ? `${x.bank}${x.nick ? " " + x.nick : ""}${x.last4 ? " ••" + String(x.last4).slice(-4) : ""}` : null; };

  const now = new Date();
  const stamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + "T" + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + "Z";
  const lines: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AP Personal Assistant//Bills//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Bills", "X-WR-CALDESC:Live feed from AP Personal Assistant", "REFRESH-INTERVAL;VALUE=DURATION:PT4H", "X-PUBLISHED-TTL:PT4H",
  ];
  // previous month through 12 months out
  const startY = now.getUTCFullYear(), startM = now.getUTCMonth() - 1;
  for (let k = 0; k <= 13; k++) {
    const ref = new Date(Date.UTC(startY, startM + k, 1));
    const y = ref.getUTCFullYear(), m = ref.getUTCMonth();
    for (const bill of bills) {
      for (const due of dueDatesInMonth(bill, y, m)) {
        const ds = due.replace(/-/g, "");
        const isPaid = paid.has(bill.id + ":" + due);
        const acct = acctLabel(bill.account_id);
        const remind = typeof bill.remind_days === "number" ? bill.remind_days : 2;
        let desc = "Bill payment reminder";
        if (acct) desc += " · pays from " + acct;
        if (bill.autopay) desc += " · autopay";
        if (isPaid) desc += " · marked paid in AP";
        lines.push("BEGIN:VEVENT", "UID:" + bill.id + "-" + ds + "@ap-bills", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + ds, "DTEND;VALUE=DATE:" + ds);
        lines.push("SUMMARY:" + esc((isPaid ? "✓ " : "") + bill.name + " — " + money(bill.amount) + (isPaid ? " (paid)" : " due")));
        lines.push("DESCRIPTION:" + esc(desc));
        if (!isPaid) {
          const hoursBefore = remind * 24 - 9;   // 9 AM local, `remind` days before
          lines.push("BEGIN:VALARM", "TRIGGER:" + (hoursBefore <= 0 ? "PT9H" : "-PT" + hoursBefore + "H"), "ACTION:DISPLAY");
          lines.push("DESCRIPTION:" + esc(bill.name + " — " + money(bill.amount) + " due " + (remind === 0 ? "today" : remind === 1 ? "tomorrow" : "in " + remind + " days")), "END:VALARM");
        }
        lines.push("END:VEVENT");
      }
    }
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n"), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=600" } });
});
