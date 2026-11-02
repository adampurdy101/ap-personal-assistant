# AP Personal Assistant — technical notes

AP Personal Assistant ("AP") is a personal organizer: a month-first calendar with a Claude
"brain" that files, schedules and reshuffles tasks. This file is the technical reference for
the repo. The owner's operating rulebook (how the assistant manages him) is private and lives
in the Supabase table `fm_rules`, not here. (The `fm_` table prefix is historical and stays.)

## Pieces
| Piece | Does | Lives |
|---|---|---|
| App | Panel left (Next up · Status · Today · Meetings · Promises · Tasks · Quick look), calendar right (Month/Week/Day · Work/Home/Both), Quick add, Tell Assistant, Tomorrow, Balance week | `index.html`, `css/app.css`, `js/app.js` → GitHub Pages |
| Brain | Instant filing and reshuffle from the mic / Tell Assistant / Balance week | Supabase edge function `ap-brain` (`supabase/functions/ap-brain`) |
| Scheduled runs | "AP · morning plan" 5:30 a.m., "AP · end of day" 2:30 p.m., Mon–Fri | Claude scheduled tasks (read `fm_rules` for the rulebook) |
| Meetings | Reads the owner's published work calendar (ICS) every 15 min; writes titles + times only | Supabase edge function `ap-meetings` + pg_cron job `ap-meetings-sync` |
| Days off | Company holidays and PTO as all-day rows (`source` = `pcg_holiday` / `pto`) | `fm_meetings`; the sync never touches rows from other sources |
| Data | Tasks, jobs, moves, brain log, rules, meetings | Supabase tables `fm_tasks`, `fm_jobs`, `fm_moves`, `fm_brain_log`, `fm_rules`, `fm_meetings`, `fm_meeting_rules` (RLS, owner only); `fm_settings` (service role only: calendar link, cron key) |

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
| source | `app` · `quick` · `tomorrow` · `brain` · `claude` · `morning` · `eod` · `imported` · `gmail` |

Every change the brain, the app controls or a scheduled run makes is logged in `fm_moves`
(batch_id, kind add/move/update/complete/delete, before, after, reason) so Undo works.

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
- Sources `pcg_holiday` and `pto`: one all-day row per day off (`ext_key` = `pcg-YYYY-MM-DD` / `pto-YYYY-MM-DD`). Written by Claude, never by the sync.
- `attending` comes from `fm_meeting_rules` (title contains). The app's "I go to this" / "I don't go" buttons write that rule for the whole series.
- App: ■ solid = you go (counts against the 8 h day) · ◌ dashed = invited (not counted) · ◇ = all day / holiday / off.

## Brain tools
`list_jobs`, `list_tasks`, `day_load` (tasks + attended meetings per day, OFF days, guessed items),
`add_task`, `update_task` (moves need a reason; refuses promised items and past-drop-dead),
`complete_task`, `delete_task`, `ask_adam` (max 3 A/B/C questions, then stop). Model from the
`AP_MODEL` secret (falls back to `FOREMAN_MODEL`, default `claude-sonnet-4-5`). Anthropic key in Supabase Edge Function secrets only.

## Quick-add grammar
`!!` or "urgent" · `!` or "high" · "low" · `#home` / `#work` · `@<job prefix>` ·
"today" / "tomorrow" / "fri" / "10/30". Example: `Send James layout fri !! @miner`

## Shipping a change
Bump `?v=N` on `css/app.css` and `js/app.js` in `index.html` and `VERSION` in `sw.js` together. GitHub Pages caches files for 10 minutes; the query string makes the browser fetch the new copy right away. Installed-app windows check for new code on wake and every 15 min and reload themselves.

## Stages
1. Calendar, panel, quick add + mic, Tomorrow, brain, undo — done
2. Scheduled runs (morning, end of day) — done
3. Meetings on the calendar (Outlook feed direct, every 15 min) — done · days off — done
4. Look v2 — done. Still to do: dated tasks → Google Calendar alerts; Jobs tab with timeline bars; Gmail asks → unscheduled; hourly nudge
5. Phone-first polish
