# Look v2 — "AP Personal Assistant" (locked Nov 2, 2026; built Nov 2, 2026 as v32)

Design spec for the next UI pass. Reference render: `look-v2-mock.html` (open in a browser at 1800×1060). Sample data in the mock is placeholder.

## Layout
- Side panel LEFT (330 px), calendar RIGHT. Each in a rounded (12 px) 3 px charcoal `#222` frame on page tint `#f3f3f1`, 22 px gutters.
- Top bar on `#f0f0ec` with a 1.5 px rule under it: brand plate ("AP" monogram + app name, charcoal outline, white fill, maroon `#8c1d2f` text), two segmented controls (Work/Home/Both, Month/Week/Day; active = tan `#efe3cc`, bold), quick-add box, "Tell Assistant" (white, charcoal outline, red outline-mic icon), Tomorrow, Mini, Full screen. 4–6 px corners, 1 px drop shadows.

## Panel (top to bottom)
Every section = white rounded card, 1 px charcoal border, 1 px shadow, olive `#dfe4cf` label strip (10 px caps, 1.4 px tracking), rows split by dotted `#999` lines. Panel background `#f0f0ec`.
1. NEXT UP — red label strip; big symbol + task title + "size · priority · deadline"; buttons ✓ Done (olive), Push → (tan), More….
2. STATUS — maroon bold caps.
3. TODAY — 7 a–4 p timeline bar: meetings hatched gray, red NOW marker, "NOW hh:mm · N h M m left"; then hours line and "First: …".
4. MEETINGS — from the Outlook ICS feed.
5. PROMISES — → you owe X (what, when) / ← X owes you (what, days).
6. TASKS — today's items with priority symbols.
7. QUICK LOOK — "NOV 2" huge black (Inter Display 900), weekday as a red `#d8222a` block with charcoal outline, year bold beside it, week-of-year bar (tan fill), three outlined boxes: day of year · days left · days to next trip/holiday.

## Calendar
- Header tan `#efe3cc`: boxed ‹ ›, month title in its own outlined white box, Today (red outline), "⇄ Balance week" (olive), legend chips on the right.
- Grid = CSS grid, `38px repeat(7, minmax(0,1fr))`, 5 px gaps. Row 0 = week-number gutter cell ("WK") + weekday boxes (full names, title case, semibold 14 px); weekday boxes olive with a 3 px charcoal rule under (box-shadow), SUN/SAT darker olive `#cdd4b4`, today's weekday red fill, charcoal outline, one size up and overlapping neighbours (negative margin, z-index).
- Left gutter: week number per row; current week red.
- Day cells: 7 px radius, 1 px blue `#2a4a8a` hairline, white. Weekends tan `#e2cfae`; next-month weekends `#d6c09a`. Past days olive `#dfe4cf`, 1.5 px dashed `#8a9a6a` border, faint red corner-to-corner X (CSS gradients), red "DONE" stamp; past weekends `#cdd4b4`. Today: white, 3 px dashed red border, red TODAY pill. 7 px charcoal bar on top of a month's first week and left of its first day.
- Load bar: bottom of every non-past day, 7 px, width = hours/8 (tan `#d6be9a`), red when over 8. Hours text top-right ("17 h/8").
- DD tag: red corner tag "DD" on days holding a drop-dead.
- Chips: 3 px corners, 2 px hard shadow; urgent red fill/white text, high tan `#d9bb90`, normal white, low/planned/invited dashed (no shadow), meeting light gray `#c9ccce` with dark text (never black). Hover → ‹ › push-a-day buttons at the chip ends; drag & drop between days. "?" badge (maroon outline circle) when size/priority were defaulted → popover: 15 m · 1 h · ½ day · Full · free-entry hours, then !! ▲ ● – , Save.
- Vertical scroll grab bar on the right edge of the grid (13 px track, charcoal thumb).

## Fonts
Inter (UI), Inter Display Black (big numbers/titles), DejaVu Sans Condensed (small caps labels). Status by shape + wording, never colour alone.
