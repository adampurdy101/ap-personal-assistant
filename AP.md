# AP Personal Assistant — technical notes

AP Personal Assistant ("AP") is a personal organizer: a month-first calendar with a Claude
"brain" that files, schedules and reshuffles tasks. This file is the technical reference for
the repo. The owner's operating rulebook (how the assistant manages him) is private and lives
in the Supabase table `fm_rules`, not here. (The `fm_` table prefix is historical and stays.)

## Where
- App: https://adampurdy101.github.io/ap-personal-assistant/ · Code: github.com/adampurdy101/ap-personal-assistant (renamed Nov 2, 2026; GitHub redirects the old links)

## Pieces
| Piece | Does | Lives |
|---|---|---|
| App | Panel left (Quick look · Next up · Status · Today · Meetings · Promises · Tasks), calendar right (Month/Week/Day · Work/Home/Both/$ Bills), Quick add, Tell Assistant, Add task, Balance week, Done log, Trash, Undo | `index.html`, `css/app.css`, `js/app.js`, `js/bills.js` → GitHub Pages |
| Bills | The bill ledger: `$ Bills` view, hover summary, Paid ✓, add/edit, accounts, alerts; a private iCalendar feed for Apple/Google Calendar | `js/bills.js` (data), `js/app.js` (UI), edge function `bills-ics` |
| Brain | Instant filing and reshuffle from the mic / Tell Assistant / Balance week | Supabase edge function `ap-brain` (`supabase/functions/ap-brain`) |
| Scheduled runs | "AP · morning plan" 5:30 a.m., "AP · end of day" 2:30 p.m., Mon–Fri | Claude scheduled tasks (read `fm_rules` for the rulebook) |
| Meetings | Reads the owner's published work calendar (ICS) every 15 min; writes titles + times only | Supabase edge function `ap-meetings` + pg_cron job `ap-meetings-sync` |
| Days off | Company holidays and PTO as all-day rows (`source` = `pcg_holiday` / `pto`) | `fm_meetings`; the sync never touches rows from other sources |
| Data | Tasks, jobs, moves, brain log, rules, meetings, bills | Supabase tables `fm_tasks`, `fm_jobs`, `fm_moves`, `fm_brain_log`, `fm_rules`, `fm_meetings`, `fm_meeting_rules`, `fm_bills`, `fm_bill_payments`, `fm_accounts`, `fm_prefs` (RLS, owner only); `fm_settings` (service role only: calendar link, cron key) |

The Supabase URL and publishable key in `js/config.js` are public by design; Row Level
Security plus the owner-only login protect the data. No secrets live in this repo.

## Look v2 (Nov 2, 2026)
Spec in `design/LOOK-v2.md`, reference render `design/look-v2-mock.html`. Panel LEFT, calendar
RIGHT, each in a rounded charcoal frame; white paper, charcoal hairlines, tan + olive fills,
red only where it matters (today, urgent, drop-deads). The previous look (v31, "Sage & Stone")
is kept on the branch `look-v31` as the fallback.

Calendar cells: week-number gutter down the left (current week red) · load bar at the bottom of
every future workday (hours booked of 8, red when over) · `DD` corner tag on drop-dead days ·
past days olive + dashed + faint red X + DONE · days off hatched with an OFF label · 7 px charcoal
bar where a month starts. Chips: hover shows ‹ › push-a-day arrows; drag and drop between days;
a maroon "?" badge when size/priority are still guesses (click → 2-question popover).

## Bills (v49, Nov 6 2026)
The old stand-alone bill calendar (repo `adampurdy101.github.io`, one JSON blob in `billdata`) was folded into AP so
there is one calendar. Its rows were migrated into real tables; occurrences are computed, never stored.

Tables (RLS owner-only, in the `supabase_realtime` publication, `updated_at` touch triggers):
- `fm_bills` — one row per bill: `name`, `domain` (logo = Google favicon of the domain, initials as the fallback),
  `amount`, `recur` (`monthly` · `biweekly` · `yearly` · `once`), `anchor_date` (a date it falls on: monthly = that day
  every month, clamped on short months; biweekly = every 14 days from it; yearly = that month + day), `account_id`,
  `remind_days` (default 2), `autopay`, `notes`, `photo` (data URL), `ended_on` (last due date — paid-off loan,
  cancelled service), `deleted_at` (Trash, like tasks), `legacy_id` (the old app's id).
- `fm_bill_payments` — one row per PAID occurrence: `bill_id` + `due_date` (unique), `paid_at`, `amount`, `source`
  (`app` · `claude` · `migrated`), `note`. No row = not paid. **A bill is paid only on the owner's word**
  (Paid ✓ in the app, or "I paid X" to the brain / a scheduled run) — autopay never marks anything paid.
- `fm_accounts` — what a bill pays from: `bank`, `nick`, `last4`, `sort`.
- `fm_prefs` — `(user_id, key) → value jsonb`; key `bills_feed_token` holds the private feed token (kept from the old app so the
  existing Apple Calendar subscription keeps working).

Status of an occurrence (`js/bills.js` `statusOf`): `paid` · `late` (due before today, unpaid) · `today` · `soon` (inside
`remind_days`) · `open`. Past due looks back 75 days. Every state is shape + wording, never color alone
(dashed red + LATE tag, red + DUE tag, faded + ✓).

In the app: the `$ Bills` button in the bucket segment carries a red `N LATE` badge; hovering it shows the summary
(month tally, past due, due in 7 days, Paid ✓ on each line); clicking it turns the calendar to bills only (bill chips with
the day's $ total, PAID / N LATE stamps on past days) with the panel showing the month tally (left to pay, bar, past due /
due in 7 days / needed now), !! Past due, Due in the next 7 days, Later this month, Paid this month, Accounts, and the
buttons + Add bill / Accounts / Phone alerts. Clicking a chip opens that day with the bill first (Selected card: Paid ✓ ·
Edit · Add photo · Remove bill). The everyday calendar stays bill-free on purpose: the Status card carries
`!! N bills past due` (every view) or `$ Bills: $X left this month · next …`, and desktop alerts fire `remind_days`
before each due date and daily while anything is past due. Phone: a Bills tab in the bottom bar.

Every change is logged in `fm_moves` with `task_id` null and kind `bill_paid` · `bill_unpaid` · `bill_add` · `bill_update` ·
`bill_remove` · `bill_restore`, so Undo and "why did this change" work the same as for tasks.

Feed: edge function `bills-ics` (`verify_jwt` off — the token in the URL is the credential; it reads with the service
role, scoped to the user whose `fm_prefs` row holds that token). One all-day event per due date for the previous month
through 12 months out, an alarm `remind_days` before at 9 AM, paid ones marked ✓ with no alarm. The app's "Phone alerts"
panel shows the `webcal://` link; it never appears in this repo.

## Data model (fm_tasks)
| field | meaning |
|---|---|
| title, notes | what it is |
| bucket | `work` or `home` |
| priority | `urgent` !! · `high` ▲ · `normal` ● · `low` – |
| status | `not_started` · `working` · `waiting` (+ `waiting_on`) · `done` (+ `done_at`) |
| job | name from `fm_jobs` |
| size | `15m` · `1h` · `half` · `full` (default `1h`) |
| scheduled_date | the day it sits on. NULL = unscheduled (inbox) |
| target_date | would like it done by |
| dropdead_date | must be done by; never schedule past it |
| planned | true = penciled in from Tomorrow (dashed) |
| promised_to | a person this is owed to; never moved without the owner's say-so |
| nag_hours | 0 = none; else nag every N hours until done |
| confirmed | true once the owner himself set size + priority; false = guessed (the app shows "?") |
| deleted_at | set = in the Trash (hidden everywhere, Put back restores it); NULL = live. Rows in the Trash past 30 days are deleted for good on the next app load |
| carried, carried_from | how many times an unfinished task was carried forward to today, and the day it was first due on |
| source | `app` · `quick` · `tomorrow` · `brain` · `claude` · `morning` · `eod` · `imported` · `gmail` |

Every change the brain, the app controls or a scheduled run makes is logged in `fm_moves`
(batch_id, kind add/move/update/complete/delete/restore/purge/undo, before, after, reason) so Undo
and "why did this move" both have an answer. App batches are `app-<date>`.

## Done · Trash · Undo (v46, Nov 3 2026)
- **Done** (✓ Done on a card, Next up, the mini window): status `done` + `done_at`. The chip stays on its
  day, faded, ✓ in front, struck through, sorted last. Reopen puts it back. Done items never hide on their own.
- **Remove** (× on a done chip, or Remove on any card): soft delete — `deleted_at` is set, the row leaves the
  calendar and sits in the **Trash** (Status card → Trash) with Put back and Delete for good. The brain's
  `delete_task` does the same. Nothing is hard-deleted except Delete for good / Empty trash / the 30-day sweep.
- **Done log** (Status card → Done log): everything finished in the last 30 days, grouped by day, Trash included.
- **Undo**: every change the app makes pushes an entry on a per-window undo stack (last 25) — the toast
  carries an ↶ Undo button for 8 s, the Status card shows "↶ Undo: <last change>", and Ctrl+Z works outside
  a text box. Brain batches land on the same stack (they call `undoLastBatch`).
- Past-day stamp tells the truth: `DONE` when nothing is open on that day, else `N OPEN` (solid red).
- Work tasks sent to a weekend / holiday / PTO day by → Tomorrow or → +1 week land on the next work day and the
  toast says why; drag/drop or Pick a day onto such a day asks first.
- Month scroll: the month in focus (white cells, title) only changes with ‹ › and Today. Scrolling peeks; a
  "↕ viewing October" note shows by the title while scrolled away.

## Click → Selected first · carry forward (v47, Nov 3 2026)
- Clicking a chip opens the day panel with THAT task as the first card (blue "SELECTED" strip, expanded, panel
  scrolled to the top); the rest of the day follows under "Also on this day". No hunting in the list.
- Carry forward: on every load, every open task sitting on a day before today moves to today (work → the next
  work day), `carried` goes up by one (↻N on the chip, "Carried ×N · was <day>" status) and `carried_from` keeps
  the day it was first due. Logged in `fm_moves` as `carry-<date>` moves. The update is guarded on the old
  `scheduled_date`, so two windows or the morning plan never double-count. Nothing is left behind on a past day.
- The Mini button is gone for good (the owner removed it on purpose); `initMini` stays harmless.

## Scheduling rules (summary)
1. Nothing goes in without bucket, priority, size and a day.
2. A day holds 8 working hours (7–4 with lunch) minus meetings the owner attends. Weekends and days off hold 0.
3. Order: urgent → promises due → drop-deads within 2 days → planned → high → normal → low.
4. Move first, show, undo. Every move carries a one-line reason.
5. Never past a drop-dead. Never move a promised item unless told. Urgent stays on today.
6. Push LOW then NORMAL toward their targets when a day is full.
7. Home calendar: same filing, lighter touch.
8. Done is done; delete only when told or for an exact duplicate.
9. Guessed sizes stay `confirmed=false`; the brain asks before moving real items to make room for a guess.

## Meetings and days off (fm_meetings)
- Source `pci_outlook`: the owner's published Outlook calendar (ICS). The link is stored in `fm_settings`, never in this repo.
  `ap-meetings` expands recurrences (ical.js, the feed's own VTIMEZONEs), keeps 14 days back / 90 ahead,
  upserts by `source + ext_key`, and deletes `pci_outlook` rows in the window that left the feed. Titles and times only.
- Sources `pcg_holiday` and `pto`: one all-day row per day off (`ext_key` = `pcg-YYYY-MM-DD` / `pto-YYYY-MM-DD`). Written by Claude or by the
  brain (v5, Nov 6 2026: `add_day_off` / `remove_day_off` — "I'm taking Monday off" hatches the day the moment the row lands; the app
  subscribes to `fm_meetings` changes). Never by the sync. RLS: the owner may insert/delete only `pto` / `pcg_holiday` all-day rows
  (migration `fm_meetings_owner_days_off`); `pci_outlook` rows stay sync-only. Undo (`off_add` / `off_remove` in `fm_moves`) puts the row back or removes it.
- `attending` comes from `fm_meeting_rules` (title contains). The app's "I go to this" / "I don't go" buttons write that rule for the whole series.
- App: ■ solid = you go (counts against the 8 h day) · ◌ dashed = invited (not counted) · ◇ = all day / holiday / off.

## Brain tools
`list_jobs`, `list_tasks`, `day_load` (tasks + attended meetings per day, OFF days, guessed items),
`add_task`, `update_task` (moves need a reason; refuses promised items and past-drop-dead),
`complete_task`, `delete_task` (soft: sets `deleted_at`), `ask_adam` (max 3 A/B/C questions, then stop),
for bills `list_bills` (past due first), `mark_bill_paid`, `unmark_bill_paid`, `add_bill`, `update_bill` — a bill is
never a task, and the brain marks one paid only when the owner says so — and for days off `add_day_off` (a day or a run; skips weekends
and days already off; lists work tasks sitting on them so the brain moves them) and `remove_day_off` (PTO only; company holidays stay).
A day off is never a task either. Every read skips `deleted_at` rows. Model from the
`AP_MODEL` secret (default `claude-sonnet-4-5`). Anthropic key in Supabase Edge Function secrets only.

## Quick-add grammar
`!!` or "urgent" · `!` or "high" · "low" · `#home` / `#work` · `@<job prefix>` ·
"today" / "tomorrow" / "fri" / "10/30". Example: `Send James layout fri !! @miner`

## Shipping a change
Bump `?v=N` on `css/app.css` and `js/app.js` in `index.html` and `VERSION` in `sw.js` together. GitHub Pages caches files for 10 minutes; the query string makes the browser fetch the new copy right away. Installed-app windows check for new code on wake and every 15 min and reload themselves.

Check before push: `test/run_tests.py` copies the site, swaps `js/supabase.js` for the in-memory double
(`test/fake-supabase.js`), seeds it from `test/seed.json` (your own rows: titles and dates only — keep it
out of the repo, it is gitignored), drives headless Chrome through the real flows (done / remove / trash /
undo / quick add / add panel / moves across weekends and PTO / drag / views / phone / bills: badge, hover summary,
Paid ✓ + Undo, the Bills view, add a bill, phone Bills tab) and drops screenshots in `test/shots/`. The browser clock is
pinned to `FIXED_NOW` (Playwright's clock API) and the few task rows the checks click on are pinned in `PINS`, so a
fresh dump of the seed on any later day keeps the checks green. Needs `pip install playwright` and a Chrome binary.

## Stages
1. Calendar, panel, quick add + mic, Add task, brain, undo — done
2. Scheduled runs (morning, end of day) — done
3. Meetings on the calendar (Outlook feed direct, every 15 min) — done · days off — done
4. Look v2 — done. Done/Trash/Undo + Done log — done (v46). Bills in AP, old bill calendar retired — done (v49). Days off by voice — done (v51). Still to do: dated tasks → Google Calendar alerts; Jobs tab with timeline bars; Gmail asks → unscheduled; hourly nudge; background tint + PTO stripe color options
5. Phone-first polish
