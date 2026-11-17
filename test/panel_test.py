#!/usr/bin/env python3
"""The side panel (v59). Needs no seed. Run: python3 test/panel_test.py
What it guards:
  1. A task clicked in the panel opens RIGHT WHERE IT SITS — same spot on screen, framed, tagged SELECTED. Nothing is pulled to the top.
  2. A task clicked on the calendar opens in the day's list (the day's order) and is brought into view.
  3. The panel keeps its scroll place when the screen is redrawn; a new screen starts at its top; the title bar stays pinned.
  4. Same rule for bills, the Done log, the week task list, Next up and Promises — and on the phone.
  5. The screen is redrawn only when something changed; buttons keep working on live rows after a quiet check."""
import sys
from _kit import Site, Checks, fake, row, shot, meeting
from synth_seed import make_seed

NOW = "2026-11-17T09:00:00-08:00"   # a Tuesday: tasks 121 + 122 on today, 120 carried in from Monday
def world():
    s = make_seed()
    for t in s["tasks"]:
        if t["id"] in (59, 63, 64): t.update(status="done", done_at="2026-11-13T22:00:00+00:00")   # last Friday's are finished
        if t["id"] == 124: t.update(target_date="2026-11-10")                                         # a missed target → a row in the Status card
    # a meeting-heavy Tuesday: the day panel's task cards start below the fold, so "bring it into view" has work to do
    for i, (a, b) in enumerate([("10:00", "10:30"), ("10:30", "11:00"), ("11:00", "12:00"), ("13:00", "13:30"), ("14:00", "15:00"), ("15:00", "15:30")]):
        s["meetings"].append(meeting(9000 + i, f"Review block {i + 1}", "2026-11-17", a, b))
    return s

TOPOF = "(sel) => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().top) : null; }"
INVIEW = """(sel) => { const r = document.getElementById('rail').getBoundingClientRect(), bar = document.querySelector('#rail .sec.head.stick, #rail .sec.ql-card'),
  c = document.querySelector(sel).getBoundingClientRect(); return c.top >= (bar ? bar.getBoundingClientRect().bottom : r.top) - 1 && c.bottom <= r.bottom + 1; }"""   # under whatever is pinned at the top
RAILTOP = "document.getElementById('rail').scrollTop"

def main():
    t = Checks()
    with Site(4178) as site:
        # ---------- 1. overview: a row opens right where it sits ----------
        t.name = "overview"
        page, errors = site.open(world(), now=NOW, viewport=(1920, 760))   # a short window, so the panel has to scroll
        page.evaluate("document.getElementById('rail').scrollTop = 9999"); page.wait_for_timeout(300)
        top0 = page.evaluate(RAILTOP)
        t.ok(top0 > 100, f"the overview panel is scrolled down ({top0})")
        sel = "#rail-body [data-at='today:122']"
        page.locator(sel).click(); page.wait_for_timeout(120)   # the last row of the panel: its card needs room, so the list glides up for it
        card = page.locator(sel)
        t.ok("picked" in card.get_attribute("class") and "SELECTED" in card.locator(".pick-tag").inner_text(), "it is framed and tagged SELECTED")
        t.ok(card.locator(".actions button", has_text="Done").count() == 1, "with the full set of buttons")
        t.eq(fake(page, "tables.fm_tasks.length") > 0 and page.evaluate("window.AP.panel"), None, "the panel did not switch to another screen")
        page.wait_for_timeout(900)   # the glide that shows its buttons
        t.ok(page.evaluate(INVIEW, sel), "after the nudge the whole card is in view")
        t.ok(page.evaluate(RAILTOP) > 0, "and the panel was not sent back to its top")
        shot(page, "50-overview-in-place")
        # buttons two across in the narrow panel — none cut off
        over = page.evaluate("(() => { const r = document.getElementById('rail').getBoundingClientRect(); return [...document.querySelectorAll('#rail-body .item.picked .actions button')].filter(b => b.getBoundingClientRect().right > r.right - 12).length; })()")
        t.eq(over, 0, "no button of the open card is cut off by the panel edge")
        # the same task in another list (Status / Promises) stays a plain row
        t.eq(page.locator("#rail-body .item.opened").count(), 1, "only the row he clicked is open")
        # a quiet redraw keeps everything where it is
        st = page.evaluate(RAILTOP)
        page.evaluate("(() => { window.__FAKE.tables.fm_tasks.find(r => r.id === 124).title = 'Year-end PTO check (edited elsewhere)'; window.__FAKE.emit('fm_tasks'); })()"); page.wait_for_timeout(900)
        t.ok(abs(page.evaluate(RAILTOP) - st) <= 1, f"a redraw from a data change keeps the panel's scroll place ({st} → {page.evaluate(RAILTOP)})")
        t.eq(page.locator(sel + ".picked").count(), 1, "and the card is still open")
        # click its header → closes back to the row
        page.locator(sel + " .head").click(); page.wait_for_timeout(300)
        t.ok("row" in page.locator(sel).get_attribute("class"), "a click on the open card's header closes it back to a row")
        # Edit in the narrow panel: one field per line, the form is in view from its top
        page.locator(sel).click(); page.wait_for_timeout(900)
        page.locator(sel + " button", has_text="Edit").click(); page.wait_for_timeout(900)
        t.eq(page.locator(sel + " form.form").count(), 1, "Edit opens the form inside the card")
        wide = page.evaluate("(() => { const f = document.querySelector('#rail-body .item.picked form.form').getBoundingClientRect(), r = document.getElementById('rail').getBoundingClientRect(); return f.right <= r.right; })()")
        t.ok(wide, "the form fits the narrow panel")
        page.fill(sel + " form.form input[name='title']", "Hand off open items to James")
        page.locator(sel + " form.form button", has_text="Save").click(); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 122)["title"], "Hand off open items to James", "Save from the in-place form writes the row")
        t.eq(page.locator(sel + ".picked").count(), 1, "the card stays open after Save")
        # Done closes the card; the row is faded at the end of today's list
        page.locator(sel + " button", has_text="✓ Done").click(); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 122)["status"], "done", "Done from the in-place card")
        t.eq(page.locator("#rail-body .item.picked").count(), 0, "Done closes the card")
        t.ok("done" in page.locator(sel).get_attribute("class"), "it is a faded ✓ row now")
        page.keyboard.press("Control+z"); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 122)["status"], "not_started", "Ctrl+Z brings it back")
        # Next up: More… opens the card under the buttons, Less closes it
        page.evaluate("document.getElementById('rail').scrollTop = 0"); page.wait_for_timeout(200)
        page.locator("#rail-body .sec.focus button", has_text="More").click(); page.wait_for_timeout(500)
        t.eq(page.locator("#rail-body .sec.focus .item.picked").count(), 1, "Next up → More… opens the card inside Next up")
        t.eq(page.evaluate("window.AP.panel"), None, "still on the overview")
        page.locator("#rail-body .sec.focus button", has_text="Less").click(); page.wait_for_timeout(400)
        t.eq(page.locator("#rail-body .sec.focus .item.picked").count(), 0, "Less closes it")
        # Promises
        page.locator("#rail-body [data-at='owe:120']").click(); page.wait_for_timeout(700)
        t.eq(page.locator("#rail-body [data-at='owe:120'].item.picked").count(), 1, "a promise row opens in place too")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 2. day panel: from the calendar, then inside the panel ----------
        t.name = "day"
        page, errors = site.open(world(), now=NOW, viewport=(1920, 900))
        page.locator(".mscroll .chip[data-id='122']").click(); page.wait_for_timeout(500)
        t.eq(page.evaluate("window.AP.panel"), "day", "a chip on the calendar opens its day in the panel")
        t.eq(page.locator("#rail-body .item.picked[data-id='122']").count(), 1, "with that task open, framed, tagged")
        t.ok(page.evaluate(INVIEW, "#rail-body .item.picked"), "the card is brought into view (meetings sit above it)")
        ids = page.evaluate("[...document.querySelectorAll('#rail-body .item[data-id]')].map(c => Number(c.dataset.id))")
        t.eq(ids, [120, 121, 122], "the list keeps the day's order — the clicked one is not moved to the top")
        shot(page, "51-day-from-calendar")
        # the title bar stays pinned while the list scrolls
        bar = page.evaluate("(() => { const r = document.getElementById('rail').getBoundingClientRect(), b = document.querySelector('#rail .sec.head.stick').getBoundingClientRect(); return Math.round(b.top - r.top); })()")
        t.ok(page.evaluate(RAILTOP) > 0 and 0 <= bar <= 8, f"the panel's title bar (date · Close) stays pinned at the top while scrolled (offset {bar})")
        page.locator("#rail-body .item[data-id='121'] .head").click(); page.wait_for_timeout(800)
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.picked')].map(c => Number(c.dataset.id))"), [121], "the card he just clicked is the SELECTED one")
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.opened')].map(c => Number(c.dataset.id))"), [121, 122], "the one he opened before stays open — nothing closes under him")
        t.ok(page.evaluate(INVIEW, "#rail-body .item.picked"), "a card opened in the list ends up fully in view")
        page.locator("#rail-body .item[data-id='122'] .head").click(); page.wait_for_timeout(500)
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.opened')].map(c => Number(c.dataset.id))"), [121], "a click on an open card's header closes just that one")
        # same day, another chip on the calendar: that task is the open, selected one
        page.locator(".mscroll .chip[data-id='120']").click(); page.wait_for_timeout(500)
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.opened')].map(c => Number(c.dataset.id))"), [120], "another chip of the same day: that task is the one open card")
        t.ok(page.evaluate(INVIEW, "#rail-body .item.picked"), "and it is in view")
        # Close → the overview starts at its top; a day cell click → that day, top
        page.locator("#rail-body .close").click(); page.wait_for_timeout(400)
        t.eq(page.evaluate(RAILTOP), 0, "back on the overview: starts at its top")
        t.eq(page.locator("#rail-body .item.picked").count(), 0, "nothing left open")
        page.locator(".mscroll .day[data-iso='2026-12-07']").click(position={"x": 60, "y": 100}); page.wait_for_timeout(500)
        t.eq(page.evaluate(RAILTOP), 0, "a day opened from its square starts at the top")
        t.eq(page.locator("#rail-body .item.picked").count(), 0, "with no card forced open")
        # Coming up row: opens in place, the panel stays on this day
        hdr = page.locator("#rail-body .sec.head .lab").inner_text()
        soon = page.locator("#rail-body [data-at^='soon:']").first
        key = soon.get_attribute("data-at")
        soon.click(); page.wait_for_timeout(800)
        t.eq(page.locator(f"#rail-body [data-at='{key}'].item.picked").count(), 1, "a Coming up row opens in place")
        t.eq(page.locator("#rail-body .sec.head .lab").inner_text(), hdr, "and the panel stays on the day he was on")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 2b. "right where it sits", to the pixel — a tall window, so no card needs the list to make room ----------
        t.name = "spot"
        page, errors = site.open(world(), now=NOW, viewport=(1920, 2400))
        t.ok(page.locator("#rail-body [data-at='risk:124']").count() == 1, "the Status card lists the past-target task")
        sel = "#rail-body [data-at='risk:124']"
        y0 = page.evaluate(TOPOF, sel)
        page.locator(sel).click(); page.wait_for_timeout(150)
        y1 = page.evaluate(TOPOF, sel); page.wait_for_timeout(800); y2 = page.evaluate(TOPOF, sel)
        t.ok("picked" in page.locator(sel).get_attribute("class") and 0 <= y1 - y0 <= 8 and y2 == y1, f"overview: the clicked row became its card on the same spot — 7 px of air above it, no more ({y0} → {y1} → {y2})")
        page.locator(sel + " .head").click(); page.wait_for_timeout(400)
        t.ok(abs(page.evaluate(TOPOF, sel) - y0) <= 2, f"overview: closing it leaves the row on the same spot ({y0} → {page.evaluate(TOPOF, sel)})")
        page.locator(".mscroll .chip[data-id='120']").click(); page.wait_for_timeout(600)
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.picked')].map(c => Number(c.dataset.id))"), [120], "day panel: the first task is open")
        for tid, why, opened in ((121, "a card under an open one", [120, 121]), (122, "the next one down", [120, 121, 122]), (120, "closing the first", [121, 122])):
            c = f"#rail-body .item[data-id='{tid}']"
            y0 = page.evaluate(TOPOF, c)
            page.locator(c + " .head").click(); page.wait_for_timeout(150)
            y1 = page.evaluate(TOPOF, c); page.wait_for_timeout(700); y2 = page.evaluate(TOPOF, c)
            t.ok(abs(y1 - y0) <= 2 and abs(y2 - y0) <= 2, f"day panel: {why} — it stays under the mouse ({y0} → {y1} → {y2})")
            t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.opened')].map(c => Number(c.dataset.id))"), opened, f"open cards after the click: {opened}")
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.picked')].map(c => Number(c.dataset.id))"), [122], "the last one opened carries the SELECTED tab")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)   # closes the day panel
        page.locator("#rail-body [data-at='today:121']").click(); page.wait_for_timeout(600)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        t.eq(page.locator("#rail-body .item.opened").count(), 0, "Esc on the overview closes the cards left open")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 3. Done log, week task list ----------
        t.name = "lists"
        page, errors = site.open(world(), now=NOW)
        page.locator("#rail-body .row.link", has_text="Done log").click(); page.wait_for_timeout(500)
        first = page.locator("#rail-body .row.done[data-at]").first
        key = first.get_attribute("data-at"); y0 = page.evaluate(TOPOF, f"#rail-body [data-at='{key}']")
        first.click(); page.wait_for_timeout(300)
        t.eq(page.locator(f"#rail-body [data-at='{key}'].item.picked").count(), 1, "a Done log row opens in place")
        t.ok(abs(page.evaluate(TOPOF, f"#rail-body [data-at='{key}']") - y0) <= 2, "on the same spot")
        t.ok("done log" in page.locator("#rail-body .sec.head .lab").inner_text().lower(), "still in the Done log")
        page.locator(f"#rail-body [data-at='{key}'] button", has_text="Reopen").click(); page.wait_for_timeout(600)
        tid = int(key.split(":")[1])
        t.eq(row(page, "fm_tasks", tid)["status"], "not_started", "Reopen from the Done log works")
        page.keyboard.press("Control+z"); page.wait_for_timeout(500)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        page.click("#view-seg button[data-view='week']"); page.wait_for_timeout(600)
        page.click("#wk-modes button[data-mode='2']"); page.wait_for_timeout(600)
        tr = page.locator("#rail-body .trow[data-at='wk:121'] .tr-title")
        t.eq(tr.count(), 1, "week Task list shows today's task as a row")
        tr.click(); page.wait_for_timeout(500)
        t.eq(page.locator("#rail-body [data-at='wk:121'].item.picked").count(), 1, "its title opens the task right in the list")
        page.locator("#rail-body [data-at='wk:121'] .head").click(); page.wait_for_timeout(400)
        t.eq(page.locator("#rail-body .trow[data-at='wk:121']").count(), 1, "and closes back to the row with its Set time button")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 4. bills ----------
        t.name = "bills"
        page, errors = site.open(world(), now=NOW)
        page.click('#bucket-seg button[data-bucket="bills"]'); page.wait_for_timeout(700)
        late = page.locator("#rail-body .sec.late .brow[data-at]").first
        key = late.get_attribute("data-at"); y0 = page.evaluate(TOPOF, f"#rail-body [data-at='{key}']")
        late.click(); page.wait_for_timeout(200)
        cardsel = f"#rail-body [data-at='{key}']"
        t.eq(page.locator(cardsel + ".item.bill.picked").count(), 1, "a bill row opens in place as its card")
        t.ok(abs(page.evaluate(TOPOF, cardsel) - y0) <= 2, "on the same spot")
        t.ok("SELECTED" in page.locator(cardsel + " .pick-tag").inner_text(), "tagged SELECTED")
        page.wait_for_timeout(700)
        t.eq(page.evaluate("(() => { const r = document.getElementById('rail').getBoundingClientRect(); return [...document.querySelectorAll('#rail-body .item.picked .actions button')].filter(b => b.getBoundingClientRect().right > r.right - 12).length; })()"), 0, "its buttons fit the narrow panel")
        shot(page, "52-bill-in-place")
        n0 = fake(page, "tables.fm_bill_payments.length")
        page.locator(cardsel + " button", has_text="Paid").first.click(); page.wait_for_timeout(700)
        t.eq(fake(page, "tables.fm_bill_payments.length"), n0 + 1, "Paid ✓ from the in-place card saves the payment")
        t.eq(page.locator("#rail-body .sec.late .item.picked").count(), 0, "the paid bill leaves Past due")
        page.keyboard.press("Control+z"); page.wait_for_timeout(600)
        t.eq(fake(page, "tables.fm_bill_payments.length"), n0, "Ctrl+Z un-pays it")
        late = page.locator("#rail-body .sec.late .brow[data-at]").first; key = late.get_attribute("data-at")
        late.click(); page.wait_for_timeout(700)
        page.locator(f"#rail-body [data-at='{key}'] .head").click(); page.wait_for_timeout(400)
        t.eq(page.locator(f"#rail-body .brow[data-at='{key}']").count(), 1, "a click on the bill card's header closes it back to its row")
        chip = page.locator(".mscroll .day:not(.other) .bchip").first
        bid = chip.get_attribute("data-bill"); chip.click(); page.wait_for_timeout(600)
        t.eq(page.locator(f"#rail-body .item.bill.picked[data-bill='{bid}']").count(), 1, "a bill chip on the calendar opens its day with that bill framed")
        t.ok(page.evaluate(INVIEW, "#rail-body .item.picked"), "and in view")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 5. redraw only on change; rows stay live ----------
        t.name = "quiet"
        page, errors = site.open(world(), now=NOW)
        page.wait_for_timeout(500)
        d0 = page.evaluate("window.AP.draws"); r0 = fake(page, "reads.fm_tasks")
        txt0 = page.locator("#rail-body .tlnow").inner_text()
        page.clock.run_for(95000); page.wait_for_timeout(400)   # three quiet 30 s checks
        t.ok(fake(page, "reads.fm_tasks") - r0 >= 2, f"the 30 s check still loads ({fake(page, 'reads.fm_tasks') - r0} loads)")
        t.eq(page.evaluate("window.AP.draws") - d0, 0, "identical data does not redraw the screen")
        t.ok(page.locator("#rail-body .tlnow").inner_text() != txt0 and "9:01" in page.locator("#rail-body .tlnow").inner_text(), f"the clock on the Today card still moves: {page.locator('#rail-body .tlnow').inner_text()!r}")
        t.ok("9:0" in page.locator("#refresh-stamp").inner_text(), "the Refresh stamp shows the last check")
        # a button drawn before those quiet checks still acts on the live row — no stale copy, no double chip
        page.locator(".mscroll .chip[data-id='121']").click(); page.wait_for_timeout(500)
        page.locator("#rail-body .item[data-id='121'] button", has_text="✓ Done").click(); page.wait_for_timeout(500)
        t.eq(row(page, "fm_tasks", 121)["status"], "done", "Done after quiet checks saves")
        t.eq(page.locator(".mscroll .chip[data-id='121']").count(), 1, "one chip, not two")
        t.ok("is-done" in page.locator(".mscroll .chip[data-id='121']").get_attribute("class"), "and it shows done at once")
        # a real change draws once and lands
        d1 = page.evaluate("window.AP.draws")
        page.evaluate("(() => { window.__FAKE.tables.fm_tasks.find(r => r.id === 123).title = 'Shop drawing resubmittal — rev 2'; window.__FAKE.emit('fm_tasks'); })()"); page.wait_for_timeout(900)
        t.ok(1 <= page.evaluate("window.AP.draws") - d1 <= 2, f"a real change redraws ({page.evaluate('window.AP.draws') - d1}×)")
        t.ok("rev 2" in page.locator(".mscroll .chip[data-id='123']").inner_text(), "and shows on the calendar")
        # the Assistant's reply shows even when it changed no data
        page.click("#balance-btn"); page.wait_for_timeout(900)
        t.ok("balanced" in page.locator("#rail-body .bubble.fm").last.inner_text(), "Balance week: the reply shows")
        t.eq(page.locator("#rail-body .hint", has_text="Working on it").count(), 0, "and it does not hang on 'Working on it…'")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # minimized: data keeps loading slowly, so alerts know about new meetings
        page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })")
        r1 = fake(page, "reads.fm_tasks")
        page.evaluate("window.__FAKE.emit('fm_tasks')"); page.clock.run_for(125000); page.wait_for_timeout(300)
        n = fake(page, "reads.fm_tasks") - r1
        t.ok(1 <= n <= 3, f"a hidden window still loads after a live change, at a slow pace ({n} loads in 2 min)")
        # midnight: the day rolls over without a data change
        page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })")
        page.clock.run_for(15 * 3600 * 1000 + 120000); page.wait_for_timeout(600)
        t.eq(page.locator(".mscroll .day.today").get_attribute("data-iso"), "2026-11-18", "after midnight the calendar moves TODAY to the new day by itself")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 6. phone ----------
        t.name = "phone"
        page, errors = site.open(world(), now=NOW, viewport=(402, 874), mobile=True)
        page.locator(".pchip", has_text="Hand off open items").first.click(); page.wait_for_timeout(600)
        t.eq(page.locator("#rail-body .item.picked[data-id='122']").count(), 1, "phone: a tapped task opens framed in its day")
        t.ok(page.evaluate(INVIEW, "#rail-body .item.picked"), "phone: and it is in view")
        page.locator("#rail-body .item[data-id='121'] .head").click(); page.wait_for_timeout(700)
        t.eq(page.evaluate("[...document.querySelectorAll('#rail-body .item.picked')].map(c => Number(c.dataset.id))"), [121], "phone: another card opens in place and is the selected one")
        shot(page, "53-phone-day")
        page.locator("#rail-body .close").click(); page.wait_for_timeout(500)
        t.ok(page.locator(".pday.today").count() == 1, "phone: Back returns to the week")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()
    return t.done()

if __name__ == "__main__":
    sys.exit(main())
