#!/usr/bin/env python3
"""Everything the other checks do not press (v59). Needs no seed. Run: python3 test/misc_test.py
  A quick add: the word rules (day names, board sizes, high / low)      G week / day / bills navigation
  B Inbox: give a task a day                                             H accounts, bill edit / remove / undo, phone alerts
  C card buttons: Working · Set a time · ? · Make it real · chip ‹      I failures: load error, save error, offline, new version
  D Trash: Empty trash                                                   J typing guard, drag onto a day off, mini window, "/" key
  E Assistant: send, error + Retry, queue, Undo last                     K phone: Add, Assistant, month, bills
  F voice: mic → Assistant, mic → Add list, silence sends, no mic"""
import json, sys
from _kit import Site, Checks, fake, row, shot
from synth_seed import make_seed

NOW = "2026-11-17T09:00:00-08:00"
def world():
    s = make_seed()
    for t in s["tasks"]:
        if t["id"] in (59, 63, 64): t.update(status="done", done_at="2026-11-13T22:00:00+00:00")
    return s
def toast(page): return page.locator("#toast").inner_text() if page.locator("#toast").is_visible() else ""
def tasks(page): return page.evaluate("window.__FAKE.tables.fm_tasks")
SR_STUB = """window.__SR = [];
class FakeSR { constructor() { window.__SR.push(this); this.started = false; } start() { this.started = true; } stop() { this.started = false; setTimeout(() => this.onend && this.onend(), 30); } abort() { this.stop(); } }
window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
window.__say = (text, final = true) => { const r = window.__SR[window.__SR.length - 1]; const res = [{ transcript: text }]; res.isFinal = final; r.onresult({ resultIndex: 0, results: [res] }); };"""

QUICK = [   # typed → what must come out (today = Tue Nov 17, 2026)
    ["Send James layout fri !! @miner", {"title": "Send James layout", "priority": "urgent", "date": "2026-11-20", "job": "Miner"}],
    ["Monthly safety report", {"title": "Monthly safety report", "date": None, "priority": "normal"}],
    ["Wedge anchors for level 2", {"title": "Wedge anchors for level 2", "date": None}],
    ["Monitor the pour thursday", {"title": "Monitor the pour", "date": "2026-11-19"}],
    ["Satellite office layout thurs", {"title": "Satellite office layout", "date": "2026-11-19"}],
    ["Order 5/8 drywall", {"title": "Order 5/8 drywall", "date": None}],
    ["Order 5/8 drywall fri", {"title": "Order 5/8 drywall", "date": "2026-11-20"}],
    ["Order 5/8\" type X on 12/9", {"title": "Order 5/8\" type X", "date": "2026-12-09"}],
    ["Deliver board on 5/8", {"title": "Deliver board", "date": "2027-05-08"}],
    ["Half day 1/2", {"title": "Half day 1/2", "date": None}],
    ["Send layout 10/30", {"title": "Send layout", "date": "2027-10-30"}],
    ["Shops due 12/11 !", {"title": "Shops due", "date": "2026-12-11", "priority": "high"}],
    ["Frame the low wall at grid 4", {"title": "Frame the low wall at grid 4", "priority": "normal"}],
    ["High bay lighting clash", {"title": "High bay lighting clash", "priority": "normal"}],
    ["call James high", {"title": "call James", "priority": "high"}],
    ["call James high fri", {"title": "call James", "priority": "high", "date": "2026-11-20"}],
    ["clean the garage low priority #home", {"title": "clean the garage", "priority": "low", "bucket": "home"}],
    ["urgent call the GC", {"title": "call the GC", "priority": "urgent"}],
    ["high", {"title": "high", "priority": "normal"}],
    ["tomorrow", {"title": "", "date": "2026-11-18"}],
    ["Pick up 3/4 ply today", {"title": "Pick up 3/4 ply", "date": "2026-11-17"}],
    ["RFI 13/45 answer", {"title": "RFI 13/45 answer", "date": None}],
    ["Review rev 11/16/2026 set", {"title": "Review rev 11/16/2026 set", "date": None}],
    ["Call mon", {"title": "Call", "date": "2026-11-23"}],
    ["Tuesday walk with James", {"title": "walk with James", "date": "2026-11-24"}],
]

def main():
    t = Checks()
    with Site(4179) as site:
        # ---------- A. quick add ----------
        t.name = "quick-add"
        page, errors = site.open(world(), now=NOW)
        for text, want in QUICK:
            got = page.evaluate("(s) => window.AP.parse(s)", text)
            miss = {k: got.get(k) for k, v in want.items() if got.get(k) != v}
            t.ok(not miss, f"{text!r} → {got} (wanted {want})")
        page.keyboard.press("/"); page.wait_for_timeout(150)
        t.eq(page.evaluate("document.activeElement.id"), "quick-input", "the / key puts the cursor in Quick add")
        page.keyboard.type("Order 5/8 drywall"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
        new = [r for r in tasks(page) if r["title"] == "Order 5/8 drywall"]
        t.ok(len(new) == 1 and new[0]["scheduled_date"] == "2026-11-17" and new[0]["bucket"] == "work", f"typed in the box: filed on today with the size left in the title: {new}")
        t.eq(page.locator("#rail-body .item.picked form.form").count(), 1, "it opens in edit mode, framed, in the day's list")
        page.locator("#rail-body form.form button", has_text="Cancel").click(); page.wait_for_timeout(400)
        page.fill("#quick-input", "tomorrow"); page.keyboard.press("Enter"); page.wait_for_timeout(500)
        t.eq(len([r for r in tasks(page) if not r["title"]]), 0, "a line that is only a date word files nothing")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- B. Inbox ----------
        t.name = "inbox"
        page, errors = site.open(world(), now=NOW)
        inbox = page.locator("#rail-body .row.link", has_text="Inbox")
        t.ok("2 unscheduled" in inbox.inner_text(), f"Status card counts the inbox: {inbox.inner_text()!r}")
        inbox.click(); page.wait_for_timeout(500)
        t.ok("inbox" in page.locator("#rail-body .sec.head .lab").inner_text().lower(), "the Inbox panel opens")
        t.eq(page.locator("#rail-body .item[data-id]").count(), 2, "with both unscheduled tasks")
        page.locator("#rail-body .item[data-id='127'] .head").click(); page.wait_for_timeout(500)
        page.locator("#rail-body .item[data-id='127'] button", has_text="Pick a day").click(); page.wait_for_timeout(400)
        t.eq(page.locator(".datepop .dp-day.off").count() >= 8, True, "the date picker marks the days off")
        page.locator(".datepop .dp-day", has_text="17").first.click(); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 127)["scheduled_date"], "2026-11-17", "Pick a day gives it a day")
        t.eq(page.locator("#rail-body .item[data-id]").count(), 1, "and it leaves the Inbox")
        page.locator("#rail-body .item[data-id='128'] .head").click(); page.wait_for_timeout(400)
        page.locator("#rail-body .item[data-id='128'] button", has_text="Edit").click(); page.wait_for_timeout(400)
        page.fill("#rail-body form.form input[name='scheduled_date']", "2026-12-10")
        page.locator("#rail-body form.form button", has_text="Save").click(); page.wait_for_timeout(600)
        r = row(page, "fm_tasks", 128)
        t.ok(r["scheduled_date"] == "2026-12-10" and r["confirmed"] is True, f"the edit form sets the day and clears the ? ({r['scheduled_date']}, {r['confirmed']})")
        t.ok(any(m["kind"] == "move" and m["task_id"] == 128 for m in page.evaluate("window.__FAKE.tables.fm_moves")), "logged as a move")
        t.ok("Nothing waiting" in page.locator("#rail-body").inner_text(), "the Inbox says it is empty")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- C. card buttons ----------
        t.name = "card"
        page, errors = site.open(world(), now=NOW)
        page.locator(".mscroll .chip[data-id='122']").click(); page.wait_for_timeout(500)
        card = page.locator("#rail-body .item[data-id='122']")
        card.locator("button", has_text="Working").click(); page.wait_for_timeout(500)
        t.eq(row(page, "fm_tasks", 122)["status"], "working", "Working sets the status")
        t.ok("Working" in page.locator("#rail-body .item[data-id='122'] .status-pill").first.inner_text() or "Working" in page.locator("#rail-body .item[data-id='122']").inner_text(), "and the card says so")
        page.locator("#rail-body .item[data-id='122'] button", has_text="Set est. time").click(); page.wait_for_timeout(400)
        page.locator(".pop .sz .o", has_text="15 m").click(); page.locator(".pop .pr .o[title='Low']").click(); page.locator(".pop .save").click(); page.wait_for_timeout(600)
        r = row(page, "fm_tasks", 122)
        t.ok(r["size"] == "15m" and r["priority"] == "low" and r["confirmed"] is True, f"the ? popover from the card saves ({r['size']}, {r['priority']}, {r['confirmed']})")
        page.locator("#rail-body .item[data-id='122'] button", has_text="Set a time").click(); page.wait_for_timeout(400)
        first = page.locator(".pop.timepop .r .o").first.inner_text()
        page.locator(".pop.timepop .r .o").first.click(); page.wait_for_timeout(600)
        t.ok(row(page, "fm_tasks", 122)["start_at"] is not None, f"Set a time from the card saves the first open slot ({first})")
        t.eq(page.locator(".mscroll .chip[data-id='122'] .tm").count(), 1, "the chip shows the time")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # planned → real
        page.locator(".mscroll .chip[data-id='125']").click(); page.wait_for_timeout(500)
        t.ok("planned" in page.locator(".mscroll .chip[data-id='125']").get_attribute("class"), "a planned task is dashed on the calendar")
        page.locator("#rail-body .item[data-id='125'] button", has_text="Make it real").click(); page.wait_for_timeout(500)
        t.eq(row(page, "fm_tasks", 125)["planned"], False, "Make it real clears planned")
        # waiting → shows under Promises as owed to him
        page.locator(".mscroll .chip[data-id='124']").click(); page.wait_for_timeout(500)
        page.locator("#rail-body .item[data-id='124'] button", has_text="Edit").click(); page.wait_for_timeout(400)
        page.select_option("#rail-body form.form select[name='status']", "waiting")
        page.fill("#rail-body form.form input[name='waiting_on']", "the inspector")
        page.locator("#rail-body form.form button", has_text="Save").click(); page.wait_for_timeout(600)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        t.ok(page.locator("#rail-body .row.pr.in", has_text="the inspector owes you").count() == 1, "a Waiting task shows under Promises as owed to him")
        # chip ‹ skips the trip, the holidays and the weekends
        chip = page.locator(".mscroll .chip[data-id='123']"); chip.scroll_into_view_if_needed(); chip.hover(); page.wait_for_timeout(200)
        chip.locator(".mv.l").click(); page.wait_for_timeout(700)
        t.eq(row(page, "fm_tasks", 123)["scheduled_date"], "2026-11-17", "chip ‹ from Mon Dec 7 lands on the last work day before the trip (Tue Nov 17)")
        t.ok(all(m.get("reason") for m in page.evaluate("window.__FAKE.tables.fm_moves")), "every change in this run is logged with a reason")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- D. Empty trash ----------
        t.name = "trash"
        page, errors = site.open(world(), now=NOW)
        for tid in (124, 126):
            page.locator(f".mscroll .chip[data-id='{tid}']").click(); page.wait_for_timeout(500)
            page.locator(f"#rail-body .item[data-id='{tid}'] button", has_text="Remove").click(); page.wait_for_timeout(500)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        tr = page.locator("#rail-body .row.link", has_text="Trash")
        t.ok("2 items" in tr.inner_text(), f"Trash counts both: {tr.inner_text()!r}")
        tr.click(); page.wait_for_timeout(500)
        page.once("dialog", lambda d: d.accept())
        page.locator("#rail-body button", has_text="Empty trash").click(); page.wait_for_timeout(700)
        t.ok(row(page, "fm_tasks", 124) is None and row(page, "fm_tasks", 126) is None, "Empty trash deletes them for good")
        t.ok(any(m["kind"] == "purge" for m in page.evaluate("window.__FAKE.tables.fm_moves")), "and logs it")
        t.ok("empty" in page.locator("#rail-body .sec.head .lab").inner_text().lower(), "the Trash says empty")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- E. Assistant ----------
        t.name = "assistant"
        page, errors = site.open(world(), now=NOW)
        mode = {"v": "ok"}
        def brain(route):
            if mode["v"] == "down": return route.fulfill(status=500, body="boom")
            if mode["v"] == "batch": return route.fulfill(status=200, content_type="application/json", body=json.dumps({"reply": "Moved it a day.", "batch_id": "b-77",
                "actions": [{"kind": "move", "title": "Year-end PTO check", "from": "2026-12-08", "to": "2026-12-09", "reason": "test"}]}))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"reply": "Got it. Nothing changed.", "actions": [], "batch_id": "b-1"}))
        page.context.unroute("**/functions/v1/ap-brain"); page.context.route("**/functions/v1/ap-brain", brain)
        page.fill("#quick-input", "what is on today"); page.click("#tell-btn"); page.wait_for_timeout(900)
        t.eq(page.evaluate("window.AP.panel"), "brain", "typed text + Assistant opens the Assistant panel")
        t.ok("what is on today" in page.locator("#rail-body .bubble.you").last.inner_text(), "his words are in the panel")
        t.ok("Got it" in page.locator("#rail-body .bubble.fm").last.inner_text(), "the reply shows")
        t.eq(page.input_value("#quick-input"), "", "the box is cleared")
        mode["v"] = "down"
        page.fill("#rail-body .brain-input", "move the PTO check a day"); page.keyboard.press("Enter"); page.wait_for_timeout(900)
        t.ok("Didn't get through" in page.locator("#rail-body .bubble.fm").last.inner_text(), "a server error says so in plain words")
        t.eq(page.locator("#rail-body .bubble button", has_text="Retry").count(), 1, "and offers Retry")
        # the server did the move this time (the edge function writes the row and the log itself)
        page.evaluate("""(() => { const T = window.__FAKE.tables; T.fm_tasks.find(r => r.id === 124).scheduled_date = '2026-12-09';
          T.fm_moves.push({ id: 9001, batch_id: 'b-77', kind: 'move', task_id: 124, before: { scheduled_date: '2026-12-08' }, after: { scheduled_date: '2026-12-09' }, reason: 'test' }); })()""")
        mode["v"] = "batch"
        page.locator("#rail-body .bubble button", has_text="Retry").click(); page.wait_for_timeout(1000)
        t.ok("Moved it a day" in page.locator("#rail-body .bubble.fm").last.inner_text(), "Retry gets through")
        t.ok("Year-end PTO check" in page.locator("#rail-body .bubble.fm .acts").last.inner_text(), "what it changed is listed")
        t.eq(page.locator(".mscroll .day[data-iso='2026-12-09'] .chip[data-id='124']").count(), 1, "and the calendar shows the move")
        page.locator("#rail-body button", has_text="Undo last").click(); page.wait_for_timeout(900)
        t.eq(row(page, "fm_tasks", 124)["scheduled_date"], "2026-12-08", "Undo last puts the Assistant's change back")
        t.ok("Undid 1 change" in page.locator("#rail-body .bubble.fm").last.inner_text(), "and says so")
        t.eq(page.locator(".mscroll .day[data-iso='2026-12-08'] .chip[data-id='124']").count(), 1, "the chip is back on its day")
        # two messages in a row: the second waits its turn, neither is lost
        mode["v"] = "ok"
        page.context.unroute("**/functions/v1/ap-brain")
        def slow(route): page.wait_for_timeout(700); route.fulfill(status=200, content_type="application/json", body=json.dumps({"reply": "Done with that one.", "actions": [], "batch_id": "b-2"}))
        page.context.route("**/functions/v1/ap-brain", slow)
        n0 = page.locator("#rail-body .bubble.fm").count()
        page.fill("#rail-body .brain-input", "first thing"); page.keyboard.press("Enter"); page.wait_for_timeout(150)
        page.fill("#rail-body .brain-input", "second thing"); page.keyboard.press("Enter"); page.wait_for_timeout(250)
        t.ok(page.locator("#rail-body .bubble.queued").count() == 1, "a message sent while AP is thinking waits in line")
        page.wait_for_timeout(2600)
        t.eq(page.locator("#rail-body .bubble.fm").count() - n0, 2, "both get an answer")
        t.eq(page.evaluate("window.AP.brain.busy"), False, "and AP is idle again")
        real = [e for e in errors if "status of 500" not in e]   # the one 500 is the outage this block staged on purpose
        t.eq(real, [], f"no page errors: {real}")
        page.context.close()

        # ---------- F. voice ----------
        t.name = "voice"
        page, errors = site.open(world(), now=NOW, init=SR_STUB)
        page.click("#tell-btn"); page.wait_for_timeout(400)
        t.ok(page.evaluate("window.AP.voice.on") and page.evaluate("window.AP.panel") == "brain", "the mic button starts listening and opens the Assistant")
        t.ok("listening" in page.locator("#tell-btn").get_attribute("class"), "the button shows it is listening")
        page.evaluate("window.__say('add call the inspector', false)"); page.wait_for_timeout(200)
        t.ok("call the inspector" in page.locator("#live-bubble .txt").inner_text(), "his words show live while he talks")
        page.evaluate("window.__say('add call the inspector tomorrow', true)"); page.wait_for_timeout(200)
        page.evaluate("window.dispatchEvent(new Event('focus'))"); page.wait_for_timeout(300)   # a refresh mid-sentence must not cut him off
        t.ok(page.evaluate("window.AP.voice.on"), "still listening after a background refresh")
        page.click("#tell-btn"); page.wait_for_timeout(900)
        t.eq(page.evaluate("window.AP.voice.on"), False, "pressing again stops")
        t.ok("call the inspector tomorrow" in page.locator("#rail-body .bubble.you").last.inner_text(), "and sends what he said")
        t.ok("balanced" in page.locator("#rail-body .bubble.fm").last.inner_text(), "the Assistant answers")
        # silence sends by itself
        page.locator("#rail-body .mic").click(); page.wait_for_timeout(300)
        page.evaluate("window.__say('one more thing', true)"); page.clock.run_for(6500); page.wait_for_timeout(700)
        t.eq(page.evaluate("window.AP.voice.on"), False, "six seconds of quiet ends the turn")
        t.ok("one more thing" in page.locator("#rail-body .bubble.you").last.inner_text(), "and sends it")
        # mic in the Add task panel → the list
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.click("#add-btn"); page.wait_for_timeout(400)
        page.locator("#rail-body .addp .mic").click(); page.wait_for_timeout(300)
        page.evaluate("window.__say('Export the level 3 DWG', true)"); page.wait_for_timeout(200)
        page.locator("#rail-body .addp .mic").click(); page.wait_for_timeout(600)
        t.ok("Export the level 3 DWG" in page.input_value("#rail-body .addp textarea"), "the Add task mic drops the words into the list")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()
        page, errors = site.open(world(), now=NOW, init="delete window.SpeechRecognition; delete window.webkitSpeechRecognition; window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;")
        page.click("#tell-btn"); page.wait_for_timeout(400)
        t.ok("Voice needs" in toast(page) and not page.evaluate("window.AP.voice.on"), f"no speech engine: it says so and does not hang ({toast(page)!r})")
        page.context.close()

        # ---------- G. navigation ----------
        t.name = "nav"
        page, errors = site.open(world(), now=NOW)
        page.click("#view-seg button[data-view='week']"); page.wait_for_timeout(600)
        t.ok("Nov 15" in page.locator("#cal-title").inner_text(), f"week view shows this week: {page.locator('#cal-title').inner_text()!r}")
        page.click("#next-btn"); page.wait_for_timeout(500)
        t.ok("Nov 22" in page.locator("#cal-title").inner_text(), "› moves a week")
        t.eq(page.locator(".tg-tray.off").count(), 5, "next week's five days off are marked on the week view")
        page.click("#prev-btn"); page.click("#prev-btn"); page.wait_for_timeout(500)
        t.ok("Nov 8" in page.locator("#cal-title").inner_text(), "‹ moves back")
        page.click("#today-btn"); page.wait_for_timeout(500)
        t.eq(page.locator(".tg-col.today").get_attribute("data-iso"), "2026-11-17", "Today returns to this week")
        page.locator(".tg-head .dow", has_text="Monday").click(); page.wait_for_timeout(500)
        t.ok("Monday, Nov 16" in page.locator("#cal-title").inner_text(), "a weekday header opens that day")
        page.click("#next-btn"); page.wait_for_timeout(400)
        t.ok("Tuesday, Nov 17" in page.locator("#cal-title").inner_text(), "› moves a day in Day view")
        t.eq(page.locator(".dv-side .trow").count(), 3, "today's three tasks are listed beside the clock")
        page.click('#bucket-seg button[data-bucket="bills"]'); page.wait_for_timeout(600)
        t.ok(page.locator(".dayview").count() == 1, "Day view in $ Bills mode draws")
        page.click("#view-seg button[data-view='week']"); page.wait_for_timeout(500)
        t.eq(page.locator(".week .day.bills").count(), 7, "Week view in $ Bills mode draws seven day boxes")
        page.click("#view-seg button[data-view='month']"); page.wait_for_timeout(500)
        t.ok(page.locator(".mscroll .bchip").count() >= 10, "back to the bills month")
        page.click('#bucket-seg button[data-bucket="home"]'); page.wait_for_timeout(500)
        t.eq(page.locator(".mscroll .mtg.going, .mscroll .mtg.invited").count(), 0, "the Home calendar leaves work meetings out")
        t.ok(page.locator(".mscroll .chip[data-id='121']").count() == 1 and page.locator(".mscroll .chip[data-id='122']").count() == 0, "and shows home tasks only")
        page.reload(); page.wait_for_selector(".mweek", state="attached"); page.wait_for_timeout(600)
        t.ok("on" in page.locator('#bucket-seg button[data-bucket="home"]').get_attribute("class"), "the calendar he picked sticks after a reload")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- H. accounts, bill edit ----------
        t.name = "bills"
        page, errors = site.open(world(), now=NOW)
        page.click('#bucket-seg button[data-bucket="bills"]'); page.wait_for_timeout(600)
        page.locator("#rail-body button", has_text="Accounts").click(); page.wait_for_timeout(400)
        page.fill("#rail-body input[name='bank']", "Test Bank"); page.fill("#rail-body input[name='nick']", "Savings"); page.fill("#rail-body input[name='last4']", "9911")
        page.locator("#rail-body button", has_text="Add account").click(); page.wait_for_timeout(500)
        acc = [a for a in page.evaluate("window.__FAKE.tables.fm_accounts") if a["bank"] == "Test Bank"]
        t.ok(len(acc) == 1 and acc[0]["last4"] == "9911", f"an account is added: {acc}")
        r = page.locator("#rail-body .brow", has_text="Test Bank")
        r.locator("button", has_text="Edit").click(); page.wait_for_timeout(300)
        page.fill("#rail-body input[name='nick']", "Rainy day"); page.locator("#rail-body button", has_text="Save changes").click(); page.wait_for_timeout(500)
        t.eq([a for a in page.evaluate("window.__FAKE.tables.fm_accounts") if a["bank"] == "Test Bank"][0]["nick"], "Rainy day", "and edited")
        page.once("dialog", lambda d: d.accept())
        page.locator("#rail-body .brow", has_text="Test Bank").locator("button", has_text="Delete").click(); page.wait_for_timeout(500)
        t.eq(len([a for a in page.evaluate("window.__FAKE.tables.fm_accounts") if a["bank"] == "Test Bank"]), 0, "and deleted")
        page.locator("#rail-body .close").click(); page.wait_for_timeout(400)
        # edit a bill from its in-place card
        rowsel = page.locator("#rail-body .brow[data-at]", has_text="Power").first
        rowsel.click(); page.wait_for_timeout(700)
        page.locator("#rail-body .item.bill.picked button", has_text="Edit").click(); page.wait_for_timeout(500)
        t.ok("edit bill" in page.locator("#rail-body .sec.head .lab").inner_text().lower(), "Edit opens the bill form")
        page.fill("#rail-body input[name='amount']", "151.25")
        page.locator("#rail-body button", has_text="Save changes").click(); page.wait_for_timeout(700)
        t.eq(float([b for b in page.evaluate("window.__FAKE.tables.fm_bills") if b["name"] == "Power"][0]["amount"]), 151.25, "the new amount is saved")
        t.ok(any(m["kind"] == "bill_update" for m in page.evaluate("window.__FAKE.tables.fm_moves")), "and logged")
        page.once("dialog", lambda d: d.accept())
        page.locator("#rail-body .item.bill button", has_text="Remove bill").first.click(); page.wait_for_timeout(700)
        t.ok([b for b in page.evaluate("window.__FAKE.tables.fm_bills") if b["name"] == "Power"][0]["deleted_at"], "Remove bill sends it to the Trash")
        t.eq(page.locator(".mscroll .bchip", has_text="Power").count(), 0, "it is off the calendar")
        page.keyboard.press("Control+z"); page.wait_for_timeout(700)
        t.ok(page.locator(".mscroll .bchip", has_text="Power").count() >= 10, "Ctrl+Z brings the bill back")
        page.locator("#rail-body button", has_text="Phone alerts").click(); page.wait_for_timeout(700)
        t.eq(page.locator("#rail-body a.btn.primary[href^='webcal://']").count(), 1, "Phone alerts shows the calendar link")
        t.eq(len(page.evaluate("window.__FAKE.tables.fm_prefs")), 1, "and keeps its private token")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- I. failures ----------
        t.name = "failures"
        page, errors = site.open(world(), now=NOW, service_workers="block")
        chips0 = page.locator(".mscroll .chip").count()
        page.evaluate("(() => { window.__FAKE.fail = { 'fm_tasks:select': 1 }; window.__FAKE.emit('fm_tasks'); })()"); page.wait_for_timeout(800)
        t.ok("Load failed" in toast(page), f"a failed load says so: {toast(page)!r}")
        t.ok("bad" in page.locator("#refresh-btn").get_attribute("class") and "!!" in page.locator("#refresh-stamp").inner_text(), "the Refresh button shows it is not up to date")
        t.eq(page.locator(".mscroll .chip").count(), chips0, "what was on screen stays on screen")
        page.evaluate("window.__FAKE.emit('fm_tasks')"); page.wait_for_timeout(800)
        t.ok("bad" not in page.locator("#refresh-btn").get_attribute("class"), "the next good load clears the warning")
        page.locator(".mscroll .chip[data-id='121']").click(); page.wait_for_timeout(500)
        page.evaluate("window.__FAKE.fail = { 'fm_tasks:update': 1 }")
        page.locator("#rail-body .item[data-id='121'] button", has_text="✓ Done").click(); page.wait_for_timeout(600)
        t.ok("Save failed" in toast(page), f"a failed save says so: {toast(page)!r}")
        t.eq(row(page, "fm_tasks", 121)["status"], "not_started", "and nothing is changed")
        t.ok("is-done" not in page.locator(".mscroll .chip[data-id='121']").get_attribute("class"), "the chip does not pretend it is done")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.evaluate("Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })")
        page.click("#refresh-btn"); page.wait_for_timeout(500)
        t.ok("Offline" in toast(page), f"Refresh while offline says so: {toast(page)!r}")
        page.evaluate("Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })")
        page.click("#refresh-btn"); page.wait_for_timeout(1200)
        t.ok("Up to date" in toast(page), f"Refresh when current says so: {toast(page)!r}")
        ver = page.locator(".ver").inner_text()
        page.route("**/index.html?fresh=*", lambda r: r.fulfill(status=200, content_type="text/html", body='<span class="ver" title="x">v999</span>'))
        loads = []
        page.on("load", lambda: loads.append(1))
        page.click("#refresh-btn"); page.wait_for_timeout(900)
        t.ok("New version v999" in toast(page), f"a newer version on the server is announced: {toast(page)!r}")
        page.wait_for_timeout(2500)
        t.eq(len(loads), 1, "and the app reloads itself once")
        page.wait_for_selector(".mweek", state="attached"); page.wait_for_timeout(500)
        t.eq(page.locator(".ver").inner_text(), ver, "it comes back up")
        page.context.close()

        # ---------- J. typing guard, drag onto a day off, mini, keys ----------
        t.name = "guards"
        page, errors = site.open(world(), now=NOW)
        page.click("#quick-input"); page.keyboard.type("half a thought")
        d0 = page.evaluate("window.AP.draws")
        page.evaluate("(() => { window.__FAKE.tables.fm_tasks.find(r => r.id === 123).title = 'Changed while typing'; window.__FAKE.emit('fm_tasks'); })()"); page.wait_for_timeout(900)
        t.eq(page.evaluate("window.AP.draws") - d0, 0, "no redraw under his fingers while he types")
        t.eq(page.input_value("#quick-input"), "half a thought", "what he typed is untouched")
        page.fill("#quick-input", ""); page.clock.run_for(2500); page.wait_for_timeout(700)
        t.ok("Changed while typing" in page.locator(".mscroll .chip[data-id='123']").inner_text(), "the change lands as soon as he is done typing")
        page.once("dialog", lambda d: d.accept())
        page.locator(".mscroll .chip[data-id='122']").drag_to(page.locator(".mscroll .day[data-iso='2026-11-18']")); page.wait_for_timeout(700)
        t.eq(row(page, "fm_tasks", 122)["scheduled_date"], "2026-11-18", "dragging work onto a day off asks first, then does it")
        page.keyboard.press("Control+z"); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 122)["scheduled_date"], "2026-11-17", "Ctrl+Z takes it back")
        page.once("dialog", lambda d: d.dismiss())
        page.locator(".mscroll .chip[data-id='122']").drag_to(page.locator(".mscroll .day[data-iso='2026-11-19']")); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 122)["scheduled_date"], "2026-11-17", "saying no to the question leaves it where it was")
        page.once("dialog", lambda d: d.dismiss())
        page.locator(".mscroll .chip[data-id='120']").drag_to(page.locator(".mscroll .day[data-iso='2026-12-08']")); page.wait_for_timeout(600)
        t.eq(row(page, "fm_tasks", 120)["scheduled_date"], "2026-11-17", "a promised task asks before it moves")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()
        page, errors = site.open(world(), now=NOW, query="?mini=1")
        t.ok(page.locator("#mini-root").count() == 1 and errors == [], f"the small window mode still loads clean: {errors}")
        page.context.close()

        # ---------- K. phone ----------
        t.name = "phone"
        page, errors = site.open(world(), now=NOW, viewport=(402, 874), mobile=True)
        page.click("#tabs button[data-tab='add']"); page.wait_for_timeout(500)
        page.fill("#rail-body .addp textarea", "Buy the adapter\nCharge the camera")
        page.locator("#rail-body .picks .o", has_text="Home").click(); page.wait_for_timeout(300)
        page.locator("#rail-body button", has_text="Just add").click(); page.wait_for_timeout(700)
        new = [r for r in tasks(page) if r["title"] in ("Buy the adapter", "Charge the camera")]
        t.ok(len(new) == 2 and all(r["bucket"] == "home" and r["scheduled_date"] == "2026-11-17" for r in new), f"phone Add files both on today, Home: {[(r['title'], r['bucket'], r['scheduled_date']) for r in new]}")
        page.click("#tabs button[data-tab='brain']"); page.wait_for_timeout(500)
        page.fill("#rail-body .brain-input", "how is my day"); page.keyboard.press("Enter"); page.wait_for_timeout(900)
        t.ok("balanced" in page.locator("#rail-body .bubble.fm").last.inner_text(), "phone Assistant answers")
        page.click("#tabs button[data-tab='month']"); page.wait_for_timeout(500)
        t.eq(page.locator(".pm-cell.off").count(), 9, "phone month marks November's nine days off")
        page.locator(".pnav button[aria-label='Next month']").click(); page.wait_for_timeout(400)
        t.ok("December 2026" in page.locator(".pnav .pttl").inner_text(), "phone month › moves a month")
        page.click("#tabs button[data-tab='week']"); page.wait_for_timeout(500)
        page.locator(".pnav button[aria-label='Next week']").click(); page.wait_for_timeout(400)
        t.ok("Nov 22" in page.locator(".pnav .pttl").inner_text(), "phone week › moves a week")
        page.click("#tabs button[data-tab='bills']"); page.wait_for_timeout(600)
        n0 = fake(page, "tables.fm_bill_payments.length")
        page.locator("#rail-body .brow button.pay").first.click(); page.wait_for_timeout(700)
        t.eq(fake(page, "tables.fm_bill_payments.length"), n0 + 1, "phone Bills: Paid ✓ saves")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()
    return t.done()

if __name__ == "__main__":
    sys.exit(main())
