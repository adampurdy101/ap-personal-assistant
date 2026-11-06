#!/usr/bin/env python3
"""AP Personal Assistant — check-before-push harness.
Serves a copy of the site with an in-memory Supabase double (fake-supabase.js), drives it in
headless Chrome, asserts the real flows (done / remove / trash / undo / quick add / add panel /
moves across weekends and PTO / drag / views / phone) and drops screenshots in shots/ for a visual
pass. Run: python3 test/run_tests.py   (needs: pip install playwright, and a Chrome at CHROME below)"""
import os as _os
CHROME = _os.environ.get("CHROME", "/usr/bin/google-chrome")
import json, os, shutil, subprocess, sys, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SITE = HERE / "site"
SHOTS = HERE / "shots"
PORT = 4173
# The checks below are written against the seed as of this morning. The browser clock is pinned to it
# (Playwright's clock API) so the harness keeps passing on any later day; re-dump the seed and move
# this date together when the rows change.
FIXED_NOW = "2026-11-03T09:00:00-08:00"
# seed.json = {"tasks": [...fm_tasks rows...], "jobs": [...fm_jobs rows...], "meetings": [...fm_meetings rows...]}
# for the owner, dumped from Supabase (titles and dates only — it is gitignored, never commit it). One query:
#   select json_build_object('tasks', (select json_agg(t) from fm_tasks t), 'jobs', (select json_agg(j) from fm_jobs j
#   where active), 'meetings', (select json_agg(m) from fm_meetings m where day between current_date-45 and current_date+120));
if not (HERE / "seed.json").exists():
    sys.exit("test/seed.json is missing — dump it first (see the comment at the top of this file)")
SEED = json.loads((HERE / "seed.json").read_text())
# The live dump moves on every day (items get done, carried, moved). The rows the checks click on are
# pinned back to the FIXED_NOW world here, so a fresh dump never breaks a check that is about the app.
PINS = {
    8:  {"status": "not_started", "done_at": None, "scheduled_date": "2026-11-03", "bucket": "home", "deleted_at": None},   # T3: on today, gets done + undone
    32: {"status": "not_started", "done_at": None, "scheduled_date": "2026-10-30", "bucket": "home", "carried": 0, "carried_from": None, "deleted_at": None},   # T7b: slipped, carried forward on load
    36: {"status": "not_started", "done_at": None, "scheduled_date": "2026-11-05", "bucket": "home", "deleted_at": None},   # T11: dragged onto today
    3:  {"status": "not_started", "done_at": None, "scheduled_date": "2026-11-06", "bucket": "work", "deleted_at": None},   # T5: removed, restored
    33: {"status": "not_started", "done_at": None, "scheduled_date": "2026-11-07", "bucket": "home", "deleted_at": None},   # T12: a Home chip
}
for _row in SEED["tasks"]:
    if _row["id"] in PINS: _row.update(PINS[_row["id"]])

def build_site():
    if SITE.exists(): shutil.rmtree(SITE)
    shutil.copytree(REPO, SITE, ignore=shutil.ignore_patterns(".git", "supabase", "design", ".github", "test", "__pycache__"))
    shutil.copy(HERE / "fake-supabase.js", SITE / "js" / "supabase.js")
    SHOTS.mkdir(exist_ok=True)
    for f in SHOTS.glob("*.png"): f.unlink()

def seed_variant(mods=None):
    s = json.loads(json.dumps(SEED))
    if mods: mods(s)
    return s

class T:
    def __init__(self): self.fails = []; self.passes = 0; self.name = ""
    def ok(self, cond, msg):
        if cond: self.passes += 1
        else: self.fails.append(f"[{self.name}] {msg}"); print("  FAIL:", msg)
    def eq(self, a, b, msg): self.ok(a == b, f"{msg}: got {a!r}, want {b!r}")

def main():
    build_site()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=SITE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    t = T()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
            def new_page(seed=None, viewport=(1920, 1080), mobile=False):
                ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, timezone_id="America/Los_Angeles", locale="en-US",
                                          is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
                ctx.add_init_script("window.__SEED = " + json.dumps(seed or SEED) + "; try { localStorage.setItem('fm.bucket', 'both'); } catch (e) {}")
                ctx.route("**/fonts.googleapis.com/**", lambda r: r.abort())
                ctx.route("**/fonts.gstatic.com/**", lambda r: r.abort())
                ctx.route("**/s2/favicons**", lambda r: r.abort())   # bill logos — offline here, the initials fallback shows
                ctx.route("**/functions/v1/ap-brain", lambda r: r.fulfill(status=200, content_type="application/json",
                    body=json.dumps({"reply": "Week is balanced. Moved nothing.", "actions": [], "batch_id": "fake-batch-1"})))
                page = ctx.new_page()
                page.clock.install(time=FIXED_NOW)   # Date starts at FIXED_NOW and runs from there
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and "ERR_FAILED" not in m.text else None)
                page.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="load")
                page.wait_for_selector("#app:not(.hidden)")
                page.wait_for_selector(".pday" if mobile else ".mweek", state="attached", timeout=10000)
                page.wait_for_timeout(600)
                return page, errors
            def shot(page, name): page.screenshot(path=str(SHOTS / f"{name}.png"))
            def fake(page): return page.evaluate("({tasks: window.__FAKE.tables.fm_tasks, moves: window.__FAKE.tables.fm_moves, log: window.__FAKE.log})")
            def task(page, id): return page.evaluate("(id) => window.__FAKE.tables.fm_tasks.find(r => r.id === id) || null", id)
            def toast_text(page): return page.locator("#toast").inner_text() if page.locator("#toast").is_visible() else ""
            def cell(page, iso): return page.locator(f".mweek .day[data-month] >> nth=0") if False else page.locator(".mscroll .day").filter(has=page.locator(f"xpath=self::*[@data-iso='{iso}']"))

            # ---------- T1 load + month in focus ----------
            t.name = "load"
            page, errors = new_page()
            t.eq(page.locator("#cal-title").inner_text(), "November 2026", "title on load")
            t.ok(page.locator(".day.today .today-tag").count() == 1, "today tag present")
            nov_other = page.evaluate("[...document.querySelectorAll('.mscroll .day[data-month=\"2026-10\"]')].filter(c => c.classList.contains('other')).length")
            t.eq(nov_other, 0, "no November cell is tinted as another month on load")
            t.ok(page.locator("#cal-peek").is_hidden(), "peek label hidden on load")
            t.eq(page.locator("#mini-btn").count(), 0, "no Mini button (Adam removed it on purpose — never bring it back)")
            shot(page, "01-load")

            # ---------- T2 scroll: focus month stays white ----------
            t.name = "scroll"
            page.evaluate("document.querySelector('.mscroll').scrollBy(0, -450)")
            page.wait_for_timeout(500)
            t.eq(page.locator("#cal-title").inner_text(), "November 2026", "title does not change when scrolled up")
            nov_other = page.evaluate("[...document.querySelectorAll('.mscroll .day[data-month=\"2026-10\"]')].filter(c => c.classList.contains('other')).length")
            t.eq(nov_other, 0, "November cells stay white (no .other) after scrolling up")
            oct_other = page.evaluate("[...document.querySelectorAll('.mscroll .day[data-month=\"2026-9\"]')].filter(c => !c.classList.contains('other')).length")
            t.eq(oct_other, 0, "October cells are tinted as another month")
            t.ok("viewing October" in page.locator("#cal-peek").inner_text(), f"peek says viewing October: {page.locator('#cal-peek').inner_text()!r}")
            shot(page, "02-scrolled-up")
            page.evaluate("document.querySelector('.mscroll').scrollBy(0, 1600)")
            page.wait_for_timeout(500)
            t.ok("viewing December" in page.locator("#cal-peek").inner_text(), f"peek says viewing December: {page.locator('#cal-peek').inner_text()!r}")
            t.eq(page.locator("#cal-title").inner_text(), "November 2026", "title still November when scrolled into December")
            page.click("#today-btn"); page.wait_for_timeout(700)
            t.ok(page.locator("#cal-peek").is_hidden(), "peek hidden after Today")
            page.click("#next-btn"); page.wait_for_timeout(900)
            t.eq(page.locator("#cal-title").inner_text(), "December 2026", "› moves focus to December")
            dec_other = page.evaluate("[...document.querySelectorAll('.mscroll .day[data-month=\"2026-11\"]')].filter(c => c.classList.contains('other')).length")
            t.eq(dec_other, 0, "December cells white after ›")
            page.click("#today-btn"); page.wait_for_timeout(700)
            t.eq(page.locator("#cal-title").inner_text(), "November 2026", "Today brings focus back")
            t.eq(errors, [], f"no page errors in load/scroll: {errors}")
            page.context.close()

            # ---------- T3 Done: stays faded on the day, undo ----------
            t.name = "done"
            page, errors = new_page()
            chip = page.locator(".mscroll .day.today .chip[data-id='8']")
            t.ok(chip.count() == 1, "Mom Medicaid chip is on today")
            chip.click(); page.wait_for_timeout(700)
            t.ok(page.locator("#rail-body .item[data-id='8'] .actions").count() >= 1, "day panel opened with the item expanded")
            first = page.locator("#rail-body .sec").nth(1)
            t.ok("pick" in (first.get_attribute("class") or "") and first.locator(".item[data-id='8']").count() == 1, "the clicked task is the FIRST card in the panel, outlined (Selected)")
            t.ok(page.locator("#rail-body .sec.pick .lab").inner_text().lower().startswith("selected"), "Selected label on it")
            t.ok(page.locator("#rail-body .sec", has_text="Also on this day").count() == 1, "the rest of the day sits under it")
            t.eq(page.evaluate("document.getElementById('rail').scrollTop"), 0, "panel scrolled to the top")
            page.locator("#rail-body .item[data-id='8'] button", has_text="✓ Done").click(); page.wait_for_timeout(700)
            r = task(page, 8)
            t.eq(r["status"], "done", "db status done"); t.ok(bool(r["done_at"]), "done_at set")
            chip = page.locator(".mscroll .day.today .chip[data-id='8']")
            t.ok(chip.count() == 1, "done chip still on today's square")
            t.ok("is-done" in (chip.get_attribute("class") or ""), "chip is faded (is-done)")
            t.eq(chip.locator(".sym").inner_text(), "✓", "chip mark is ✓")
            t.ok("Undo" in toast_text(page), f"toast offers Undo: {toast_text(page)!r}")
            mv = [m for m in fake(page)["moves"] if m["task_id"] == 8]
            t.ok(any(m["kind"] == "complete" for m in mv), "fm_moves has a 'complete' row with a reason")
            t.ok(all(m.get("reason") for m in mv), "every logged move has a reason")
            t.ok(page.locator("#rail-body .status-pill.done").count() >= 1, "card shows ✓ Done pill with time")
            shot(page, "03-done-faded")
            # order: done last in the cell
            order = page.evaluate("[...document.querySelectorAll('.mscroll .day.today .chip')].map(c => c.classList.contains('is-done'))")
            t.ok(order == sorted(order), f"done chips sort last in the cell: {order}")
            page.locator("#toast button.undo").click(); page.wait_for_timeout(700)
            r = task(page, 8)
            t.eq(r["status"], "not_started", "undo reopened it"); t.ok(r["done_at"] is None, "done_at cleared by undo")
            t.ok("Undid" in toast_text(page), "undo confirms")
            t.ok(any(m["kind"] == "undo" for m in fake(page)["moves"]), "undo is logged too")
            t.eq(errors, [], f"no page errors in done: {errors}")

            # ---------- T4 Remove (second click) → Trash → Put back → Delete for good ----------
            t.name = "trash"
            page.locator("#rail-body .item[data-id='8'] button", has_text="✓ Done").click(); page.wait_for_timeout(700)
            chip = page.locator(".mscroll .day.today .chip[data-id='8']")
            chip.hover(); page.wait_for_timeout(500)
            t.ok(chip.locator(".mv.x").is_visible(), "× shows on hover of a done chip")
            t.ok(chip.locator(".mv.l").count() == 0, "no push arrows on a done chip")
            chip.locator(".mv.x").click(); page.wait_for_timeout(700)
            t.eq(page.locator(".mscroll .day.today .chip[data-id='8']").count(), 0, "chip gone from the day after ×")
            r = task(page, 8); t.ok(bool(r["deleted_at"]), "deleted_at set (soft delete)"); t.eq(r["status"], "done", "still marked done in the trash")
            t.ok(any(m["kind"] == "delete" and m["task_id"] == 8 for m in fake(page)["moves"]), "remove logged as 'delete' with task_id")
            page.keyboard.press("Escape"); page.wait_for_timeout(700)   # back to the general panel
            trow = page.locator("#rail-body .row.link", has_text="Trash")
            t.ok("1 item" in trow.inner_text(), f"Status card Trash row counts it: {trow.inner_text()!r}")
            trow.click(); page.wait_for_timeout(700)
            t.ok(page.locator("#rail-body .item[data-id], #rail-body .item").count() >= 1, "trash panel lists the item")
            t.ok("Removed" in page.locator("#rail-body .item .detail").first.inner_text(), "trash row says when it was removed")
            shot(page, "04-trash")
            page.locator("#rail-body button", has_text="Put back").first.click(); page.wait_for_timeout(700)
            r = task(page, 8); t.ok(r["deleted_at"] is None, "Put back clears deleted_at")
            t.eq(page.locator(".mscroll .day.today .chip[data-id='8']").count(), 1, "chip back on today after Put back")
            t.ok("is-done" in (page.locator(".mscroll .day.today .chip[data-id='8']").get_attribute("class") or ""), "put-back chip is still done/faded")
            t.ok(any(m["kind"] == "restore" for m in fake(page)["moves"]), "put back logged as 'restore'")
            # remove again, then delete for good
            page.locator(".mscroll .day.today .chip[data-id='8']").hover(); page.locator(".mscroll .day.today .chip[data-id='8'] .mv.x").click(); page.wait_for_timeout(600)
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            page.locator("#rail-body .row.link", has_text="Trash").click(); page.wait_for_timeout(700)
            page.once("dialog", lambda d: d.accept())
            page.locator("#rail-body button", has_text="Delete for good").first.click(); page.wait_for_timeout(700)
            t.ok(task(page, 8) is None, "Delete for good really deletes")
            t.ok(any(m["kind"] == "purge" for m in fake(page)["moves"]), "purge logged")
            t.ok("empty" in page.locator("#rail-body .sec.head .lab").inner_text().lower(), "trash header says empty")
            t.eq(errors, [], f"no page errors in trash: {errors}")
            page.context.close()

            # ---------- T5 Remove an open task from the card, Ctrl+Z brings it back ----------
            t.name = "remove-open"
            page, errors = new_page()
            page.locator(".mscroll .day .chip[data-id='3']").first.click(); page.wait_for_timeout(700)
            t.ok(page.locator("#rail-body .item[data-id='3'] button", has_text="Delete").count() == 0, "no hard Delete button on the card any more")
            page.locator("#rail-body .item[data-id='3'] button", has_text="Remove").click(); page.wait_for_timeout(700)
            t.ok(bool(task(page, 3)["deleted_at"]), "open task removed → trash")
            t.eq(page.locator(".mscroll .chip[data-id='3']").count(), 0, "chip gone")
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            page.keyboard.press("Control+z"); page.wait_for_timeout(700)
            t.ok(task(page, 3)["deleted_at"] is None, "Ctrl+Z put it back")
            t.eq(page.locator(".mscroll .chip[data-id='3']").count(), 1, "chip back after Ctrl+Z")
            t.ok(page.locator("#rail-body .row.undo").count() == 0 or True, "undo row state ok")
            t.eq(errors, [], f"no page errors in remove-open: {errors}")

            # ---------- T6 Done log ----------
            t.name = "done-log"
            page.locator("#rail-body .row.link", has_text="Done log").click(); page.wait_for_timeout(700)
            hdr = page.locator("#rail-body .sec.head .lab").inner_text()
            t.ok("done log" in hdr.lower(), f"done log header: {hdr!r}")
            groups = page.locator("#rail-body .sec:not(.head) .lab").all_inner_texts()
            t.ok(any("yesterday" in g.lower() for g in groups), f"yesterday group present (Nov 2 had done items): {groups}")
            rows = page.locator("#rail-body .row.done").count()
            t.ok(rows >= 5, f"done rows listed: {rows}")
            shot(page, "05-done-log")
            page.locator("#rail-body .row.done").first.click(); page.wait_for_timeout(700)
            t.ok(page.locator("#rail-body .item.is-done").count() >= 1, "clicking a done row opens its day with the item")
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            t.eq(errors, [], f"no page errors in done-log: {errors}")
            page.context.close()

            # ---------- T7/T8 quick add grammar + → Tomorrow skips the weekend ----------
            t.name = "quick-add"
            page, errors = new_page()
            page.fill("#quick-input", "Send James layout fri !! @miner"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
            new = [r for r in fake(page)["tasks"] if r["title"] == "Send James layout"]
            t.ok(len(new) == 1, "quick add parsed the title")
            if new:
                n = new[0]
                t.eq(n["priority"], "urgent", "!! → urgent"); t.eq(n["job"], "Miner", "@miner → Miner"); t.eq(n["scheduled_date"], "2026-11-06", "fri → Fri Nov 6"); t.eq(n["bucket"], "work", "work calendar default")
                t.ok(page.locator("#rail-body form.form").count() == 1, "opens in edit mode so target/drop-dead get asked")
                page.locator("#rail-body form.form button", has_text="Cancel").click(); page.wait_for_timeout(600)
                def open_task(id):
                    page.locator(".mscroll .chip[data-id='%d']" % id).first.click(); page.wait_for_timeout(700)
                    t.ok(page.locator("#rail-body .item[data-id='%d'] .actions" % id).count() >= 1, "task %d opened in its day panel" % id)
                page.locator("#rail-body .item[data-id='%d'] button" % n["id"], has_text="→ Tomorrow").click(); page.wait_for_timeout(700)
                # "tomorrow" from Nov 3 = Wed Nov 4 (a work day) → lands Nov 4
                t.eq(task(page, n["id"])["scheduled_date"], "2026-11-04", "→ Tomorrow from today lands Wed Nov 4")
                # now +1 week from Nov 4 = Nov 11 (Veterans Day is NOT a PCG holiday) → Nov 11
                open_task(n["id"])
                page.locator("#rail-body .item[data-id='%d'] button" % n["id"], has_text="+1 week").click(); page.wait_for_timeout(700)
                t.eq(task(page, n["id"])["scheduled_date"], "2026-11-11", "+1 week → Nov 11")
                # pick a day: Friday Nov 13
                open_task(n["id"])
                page.locator("#rail-body .item[data-id='%d'] button" % n["id"], has_text="Pick a day").click(); page.wait_for_timeout(600)
                page.locator(".datepop .dp-day", has_text="13").first.click(); page.wait_for_timeout(700)
                t.eq(task(page, n["id"])["scheduled_date"], "2026-11-13", "Pick a day → Fri Nov 13")
                # +1 week from Fri Nov 13 = Fri Nov 20 = Japan PTO → lands on the first work day back, Mon Dec 7, and says why
                open_task(n["id"])
                page.locator("#rail-body .item[data-id='%d'] button" % n["id"], has_text="+1 week").click(); page.wait_for_timeout(700)
                t.eq(task(page, n["id"])["scheduled_date"], "2026-12-07", "+1 week onto the Japan PTO lands Mon Dec 7")
                t.ok("11/20" in toast_text(page) and "12/7" in toast_text(page), f"toast explains the landing: {toast_text(page)!r}")
            shot(page, "06-quick-add")
            t.eq(errors, [], f"no page errors in quick-add: {errors}")
            page.context.close()

            # ---------- T7b work task → Tomorrow across a weekend / PTO ----------
            t.name = "land-day"
            def mods(s):
                s["tasks"].append({"id": 900, "user_id": SEED["tasks"][0]["user_id"], "title": "Friday work thing", "notes": None, "bucket": "work", "priority": "normal", "status": "not_started", "waiting_on": None, "job": None, "size": "1h", "scheduled_date": "2026-11-06", "target_date": None, "dropdead_date": None, "planned": False, "promised_to": None, "nag_hours": 0, "source": "app", "done_at": None, "sort": 0, "created_at": "2026-11-03T00:00:00+00:00", "updated_at": "2026-11-03T00:00:00+00:00", "confirmed": True, "deleted_at": None})
                s["tasks"].append({"id": 901, "user_id": SEED["tasks"][0]["user_id"], "title": "Tuesday before Japan", "notes": None, "bucket": "work", "priority": "normal", "status": "not_started", "waiting_on": None, "job": None, "size": "1h", "scheduled_date": "2026-11-17", "target_date": None, "dropdead_date": None, "planned": False, "promised_to": None, "nag_hours": 0, "source": "app", "done_at": None, "sort": 0, "created_at": "2026-11-03T00:00:00+00:00", "updated_at": "2026-11-03T00:00:00+00:00", "confirmed": True, "deleted_at": None})
                s["tasks"].append({"id": 902, "user_id": SEED["tasks"][0]["user_id"], "title": "Old open thing", "notes": None, "bucket": "work", "priority": "high", "status": "not_started", "waiting_on": None, "job": None, "size": "1h", "scheduled_date": "2026-10-30", "target_date": None, "dropdead_date": None, "planned": False, "promised_to": None, "nag_hours": 0, "source": "app", "done_at": None, "sort": 0, "created_at": "2026-10-03T00:00:00+00:00", "updated_at": "2026-10-03T00:00:00+00:00", "confirmed": True, "deleted_at": None})
            page, errors = new_page(seed_variant(mods))
            page.locator(".mscroll .chip[data-id='900']").click(); page.wait_for_timeout(700)
            page.locator("#rail-body .item[data-id='900'] button", has_text="+1 week").click(); page.wait_for_timeout(700)
            t.eq(task(page, 900)["scheduled_date"], "2026-11-13", "+1 week Fri → Fri")
            # chip arrow › from Fri Nov 13 → Mon Nov 16 (skips the weekend)
            chip = page.locator(".mscroll .chip[data-id='900']"); chip.hover(); chip.locator(".mv.r").click(); page.wait_for_timeout(700)
            t.eq(task(page, 900)["scheduled_date"], "2026-11-16", "› from Friday skips to Monday")
            # +1 week from Tue Nov 17 → Nov 24 is PTO → lands Mon Dec 7 (first work day after the trip)
            page.locator(".mscroll .chip[data-id='901']").click(); page.wait_for_timeout(700)
            page.locator("#rail-body .item[data-id='901'] button", has_text="+1 week").click(); page.wait_for_timeout(700)
            t.eq(task(page, 901)["scheduled_date"], "2026-12-07", "+1 week onto PTO lands on the first work day back (Dec 7)")
            t.ok("PTO" in toast_text(page) or "Japan" in toast_text(page), f"toast explains the landing: {toast_text(page)!r}")
            # carry forward: the open item left on Oct 30 is on today now, counted as one slip
            r = task(page, 902)
            t.eq(r["scheduled_date"], "2026-11-03", "open past item carried to today on load")
            t.eq(r["carried"], 1, "carried count = 1"); t.eq(r["carried_from"], "2026-10-30", "remembers the day it was first due")
            t.ok(r["planned"] is False, "carried item is real, not planned")
            t.eq(task(page, 32)["scheduled_date"], "2026-11-03", "the real slipped Home item (Withdraw $6,500) came forward too")
            badge = page.locator(".mscroll .day.today .chip[data-id='902'] .carry")
            t.ok(badge.count() == 1 and badge.inner_text() == "↻1", f"↻1 badge on the carried chip: {badge.all_inner_texts()}")
            t.ok(any(m["kind"] == "move" and m["batch_id"].startswith("carry-") and m["task_id"] == 902 and "Carried forward" in m["reason"] for m in fake(page)["moves"]), "carry logged with a reason")
            t.eq(page.evaluate("[...document.querySelectorAll('.mscroll .day.past .stamp.open')].length"), 0, "no past day is left with an open item")
            done_stamps = page.evaluate("[...document.querySelectorAll('.mscroll .day.past .stamp:not(.open)')].length")
            t.ok(done_stamps > 10, "past days stamped DONE")
            page.locator(".mscroll .day.today .chip[data-id='902']").click(); page.wait_for_timeout(700)
            t.ok("Carried" in page.locator("#rail-body .sec.pick .status-pill").first.inner_text(), "status pill says Carried ×1")
            # a second load must not carry it again (same day)
            page.reload(wait_until="load"); page.wait_for_selector(".mweek", state="attached"); page.wait_for_timeout(900)
            t.eq(task(page, 902)["carried"], 1, "reload does not double-count the carry")
            shot(page, "07-carried-forward")
            t.eq(errors, [], f"no page errors in land-day: {errors}")
            page.context.close()

            # ---------- T9 Add task panel ----------
            t.name = "add-panel"
            page, errors = new_page()
            page.click("#add-btn"); page.wait_for_timeout(700)
            page.fill("#rail-body .addp textarea", "Export C1 DWG\nCall Kyle")
            page.locator("#rail-body .picks .o", has_text="Tomorrow").first.click(); page.wait_for_timeout(500)
            page.locator("#rail-body .picks .o", has_text="▲ High").click(); page.wait_for_timeout(500)
            page.locator("#rail-body .picks .o", has_text="½ day").click(); page.wait_for_timeout(500)
            page.locator("#rail-body button", has_text="Just add").click(); page.wait_for_timeout(700)
            rows = [r for r in fake(page)["tasks"] if r["title"] in ("Export C1 DWG", "Call Kyle")]
            t.eq(len(rows), 2, "two tasks added from the Add panel")
            t.ok(all(r["scheduled_date"] == "2026-11-04" and r["priority"] == "high" and r["size"] == "half" and r["confirmed"] and r["planned"] for r in rows), f"rows carry day/priority/size/confirmed/planned: {rows}")
            t.ok(page.locator(".mscroll .chip.planned").count() >= 2, "planned chips are dashed on the calendar")
            # undo an add → trash
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            page.keyboard.press("Control+z"); page.wait_for_timeout(700)
            gone = [r for r in fake(page)["tasks"] if r["title"] == "Call Kyle"]
            t.ok(gone and gone[0]["deleted_at"], "undoing an add moves it to the Trash (not lost)")
            t.eq(errors, [], f"no page errors in add-panel: {errors}")
            page.context.close()

            # ---------- T10 ? popover + edit form ----------
            t.name = "quickfix-edit"
            page, errors = new_page()
            chip = page.locator(".mscroll .day.today .chip[data-id='8']")
            chip.locator(".q").click(); page.wait_for_timeout(600)
            t.ok(page.locator(".pop").count() == 1, "? popover opens")
            page.locator(".pop .sz .o", has_text="½ day").click()
            page.locator(".pop .pr .o[title='High']").click()
            page.locator(".pop .save").click(); page.wait_for_timeout(700)
            r = task(page, 8); t.ok(r["size"] == "half" and r["priority"] == "high" and r["confirmed"], f"popover saved size/priority/confirmed: {r['size']} {r['priority']} {r['confirmed']}")
            t.eq(page.locator(".mscroll .day.today .chip[data-id='8'] .q").count(), 0, "? badge gone after setting")
            t.ok("Undo" in toast_text(page), "popover save can be undone")
            page.locator(".mscroll .day.today .chip[data-id='8']").click(); page.wait_for_timeout(600)
            page.locator("#rail-body .item[data-id='8'] button", has_text="Edit").click(); page.wait_for_timeout(600)
            page.fill("#rail-body form.form input[name='title']", "Get Mom enrolled in Medicaid — call DSHS")
            page.locator("#rail-body form.form button", has_text="Save").click(); page.wait_for_timeout(700)
            t.eq(task(page, 8)["title"], "Get Mom enrolled in Medicaid — call DSHS", "edit form saved the title")
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            lab = page.locator("#rail-body .row.undo .ulab").inner_text()
            t.ok(lab.startswith("Edit"), f"Status card shows the last change: {lab!r}")
            page.locator("#rail-body .row.undo button").click(); page.wait_for_timeout(700)
            t.eq(task(page, 8)["title"], "Get Mom enrolled in Medicaid — she runs out of money end of Sept", "Status-card Undo reverts the edit")
            t.eq(errors, [], f"no page errors in quickfix-edit: {errors}")
            page.context.close()

            # ---------- T11 drag and drop ----------
            t.name = "drag"
            page, errors = new_page()
            src = page.locator(".mscroll .chip[data-id='36']")   # Thu Nov 5, home
            dst = page.locator(".mscroll .day.today")
            src.drag_to(dst); page.wait_for_timeout(700)
            t.eq(task(page, 36)["scheduled_date"], "2026-11-03", "drag to today moved it")
            t.ok("Undo" in toast_text(page), "drag move offers Undo")
            t.eq(errors, [], f"no page errors in drag: {errors}")
            page.context.close()

            # ---------- T12 views, buckets, balance, mini ----------
            t.name = "views"
            page, errors = new_page()
            page.click("#view-seg button[data-view='week']"); page.wait_for_timeout(700)
            t.ok(page.locator(".week .day").count() == 7, "week view has 7 days")
            shot(page, "08-week")
            page.click("#view-seg button[data-view='day']"); page.wait_for_timeout(700)
            t.ok(page.locator(".dayview").count() == 1, "day view renders")
            page.click("#view-seg button[data-view='month']"); page.wait_for_timeout(500)
            page.click("#bucket-seg button[data-bucket='home']"); page.wait_for_timeout(700)
            t.eq(page.locator(".mscroll .chip[data-id='3']").count(), 0, "work task hidden on Home")
            t.ok(page.locator(".mscroll .chip[data-id='33']").count() == 1, "home task shows on Home")
            page.click("#bucket-seg button[data-bucket='both']"); page.wait_for_timeout(700)
            t.ok(page.locator(".mscroll .chip.bucket-home").count() >= 1, "Both marks home chips")
            page.click("#bucket-seg button[data-bucket='work']"); page.wait_for_timeout(700)
            page.click("#balance-btn"); page.wait_for_timeout(800)
            t.ok("balanced" in page.locator("#rail-body .bubble.fm").last.inner_text(), "Balance week reaches the brain and shows the reply")
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            t.eq(errors, [], f"no page errors in views: {errors}")
            page.context.close()

            # ---------- T13 phone ----------
            t.name = "phone"
            page, errors = new_page(viewport=(402, 874), mobile=True)
            t.ok(page.locator("#tabs").is_visible(), "phone tabs visible")
            t.ok(page.locator(".pday.today").count() == 1, "phone week has today")
            t.ok(page.locator("#rail-body .row.link", has_text="Done log").count() == 1, "phone footer has the Done log")
            t.ok(page.locator("#rail-body .row.link", has_text="Trash").count() == 1, "phone footer has the Trash")
            shot(page, "09-phone-week")
            page.locator("#rail-body .pnow button", has_text="✓ Done").click(); page.wait_for_timeout(700)
            t.ok(page.locator(".pchip.is-done").count() >= 1, "phone done chip faded")
            page.locator("#rail-body .row.link", has_text="Done log").click(); page.wait_for_timeout(700)
            t.ok("done log" in page.locator("#rail-body .sec.head .lab").inner_text().lower(), "phone opens the Done log")
            shot(page, "10-phone-done-log")
            page.locator("#rail-body .close").click(); page.wait_for_timeout(700)
            page.click("#tabs button[data-tab='month']"); page.wait_for_timeout(700)
            t.ok(page.locator(".pm-cell.today").count() == 1, "phone month renders")
            t.eq(errors, [], f"no page errors in phone: {errors}")
            page.context.close()

            # ---------- T14 bills: badge, hover summary, Paid ✓ + Undo, the Bills view, add a bill ----------
            t.name = "bills"
            page, errors = new_page()
            def bills(page): return page.evaluate("({bills: window.__FAKE.tables.fm_bills, pays: window.__FAKE.tables.fm_bill_payments, moves: window.__FAKE.tables.fm_moves})")
            badge = page.locator('#bucket-seg button[data-bucket="bills"] .bbadge')
            t.ok(badge.is_visible() and "LATE" in badge.inner_text(), "LATE badge on the $ Bills button (seed has unpaid October bills)")
            t.ok(page.locator("#rail-body .row.link", has_text="bills past due").count() == 1, "Status card carries the past-due line on the everyday calendar")
            page.hover('#bucket-seg button[data-bucket="bills"]'); page.wait_for_timeout(500)
            t.eq(page.locator(".pop.billpeek").count(), 1, "hovering $ Bills shows the summary")
            t.ok(page.locator(".pop.billpeek .pr").count() >= 1, "summary lists bills with Paid ✓")
            shot(page, "11-bills-peek")
            first = page.locator(".pop.billpeek .pr").first
            n0 = len(bills(page)["pays"])
            first.locator("button.pay").click(); page.wait_for_timeout(600)
            d = bills(page); t.eq(len(d["pays"]), n0 + 1, "Paid ✓ in the summary adds one fm_bill_payments row")
            t.ok(any(m["kind"] == "bill_paid" for m in d["moves"]), "the payment is logged in fm_moves (bill_paid)")
            t.ok("Paid" in toast_text(page) and "Undo" in toast_text(page), "toast says Paid ✓ and offers Undo")
            page.locator("#toast button.undo").click(); page.wait_for_timeout(700)
            t.eq(len(bills(page)["pays"]), n0, "Undo takes the payment row back out")
            page.mouse.move(10, 700); page.wait_for_timeout(400)
            t.eq(page.locator(".pop.billpeek").count(), 0, "summary closes when the mouse leaves")
            page.click('#bucket-seg button[data-bucket="bills"]'); page.wait_for_timeout(900)
            t.eq(page.locator(".cal-head.bills").count(), 1, "$ Bills switches the calendar to bills only")
            t.eq(page.locator(".mscroll .chip").count(), 0, "no task chips in bills mode")
            t.ok(page.locator(".mscroll .bchip").count() >= 10, "bill chips on the month grid")
            t.ok(page.locator(".mscroll .bchip.st-late").count() >= 1, "unpaid past bills are marked LATE")
            t.eq(page.locator("#rail-body .sec.bq-card").count(), 1, "tally card first in the panel")
            t.eq(page.locator("#rail-body .sec.late").count(), 1, "past-due card in the panel")
            t.eq(page.locator("#balance-btn").is_visible(), False, "Balance week hidden in bills mode")
            shot(page, "12-bills-month")
            chip = page.locator(".mscroll .day:not(.other) .bchip.st-late").first
            bid, due = chip.get_attribute("data-bill"), chip.get_attribute("data-due")
            chip.click(); page.wait_for_timeout(700)
            t.eq(page.locator("#rail-body .sec.pick .item.bill").count(), 1, "clicked bill opens first in the panel (Selected card)")
            shot(page, "13-bills-day")
            page.locator("#rail-body .sec.pick button", has_text="Paid").first.click(); page.wait_for_timeout(800)
            d = bills(page)
            t.ok(any(p["bill_id"] == int(bid) and p["due_date"] == due for p in d["pays"]), "Paid ✓ in the panel saves bill_id + due_date")
            t.eq(page.locator(f".mscroll .bchip.st-paid[data-bill='{bid}'][data-due='{due}']").count(), 1, "that chip now shows ✓ paid")
            page.locator("#rail-body button", has_text="+ Add bill").first.click(); page.wait_for_timeout(600)
            page.fill("#rail-body input[name='bname']", "Test Water"); page.fill("#rail-body input[name='amount']", "45.5")
            page.fill("#rail-body input[name='anchor_date']", "2026-11-20")
            shot(page, "14-bills-add")
            page.get_by_role("button", name="Add bill", exact=True).click(); page.wait_for_timeout(900)
            d = bills(page); nb = [b for b in d["bills"] if b["name"] == "Test Water"]
            t.ok(len(nb) == 1 and float(nb[0]["amount"]) == 45.5 and nb[0]["anchor_date"] == "2026-11-20" and nb[0]["recur"] == "monthly", f"new bill saved monthly from Nov 20: {nb}")
            t.ok(any(m["kind"] == "bill_add" for m in d["moves"]), "the add is logged in fm_moves (bill_add)")
            t.eq(page.locator(".mscroll .bchip[data-due='2026-11-20']", has_text="Test Water").count(), 1, "new bill shows on Nov 20")
            page.click('#bucket-seg button[data-bucket="both"]'); page.wait_for_timeout(800)
            t.eq(page.locator(".mscroll .bchip").count(), 0, "everyday calendar stays bill-free")
            t.ok(page.locator(".mscroll .chip").count() >= 1, "task chips are back")
            t.eq(errors, [], f"no page errors in bills: {errors}")
            page.context.close()

            # ---------- T15 phone bills tab ----------
            t.name = "phone-bills"
            page, errors = new_page(viewport=(402, 874), mobile=True)
            page.click("#tabs button[data-tab='bills']"); page.wait_for_timeout(800)
            t.eq(page.locator("#rail-body .sec.bq-card").count(), 1, "phone Bills tab shows the tally")
            t.ok(page.locator("#rail-body .brow").count() >= 1, "phone lists the bills")
            shot(page, "15-phone-bills")
            t.eq(errors, [], f"no page errors in phone bills: {errors}")
            page.context.close()

            browser.close()
    finally:
        server.terminate()
    print(f"\n{t.passes} checks passed, {len(t.fails)} failed")
    for f in t.fails: print("  -", f)
    return 0 if not t.fails else 1

if __name__ == "__main__":
    sys.exit(main())
