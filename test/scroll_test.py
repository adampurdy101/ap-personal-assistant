#!/usr/bin/env python3
"""Month scroll + live connection (v57). Needs no seed. Run: python3 test/scroll_test.py
What it guards:
  1. The live channel never loops: one Refresh press or one dropped connection = one reconnect, not one every 3 s.
  2. A redraw keeps the place he scrolled to — inside the ±12-month window AND far outside it (2027, 2024).
  3. The version stamps agree (index.html ?v= on css + js, the corner stamp, sw.js) so a push always reaches the browser."""
import re, sys
from _kit import Site, Checks, seed, task, meeting, day_off, fake, shot, REPO

NOW = "2026-11-17T09:00:00-08:00"
SEED = seed(
    tasks=[task(1, "Shop drawings — level 2", "2026-11-17"), task(2, "Layout file check", "2026-11-18", priority="high"),
           task(3, "Call the GC", "2026-11-17", bucket="home"), task(4, "Year-end review", "2027-12-20")],
    meetings=[meeting(10, "Coordination", "2026-11-17", attending=True),
              day_off(20, "2026-11-26", "PCG holiday — Thanksgiving"), day_off(21, "2027-12-24", "PCG holiday — Christmas Eve"),
              day_off(22, "2027-12-31", "PCG holiday — New Year's Eve")])

TOP = """() => { const sc = document.querySelector('.mscroll'), head = sc.querySelector('.mhead'), rows = [...sc.querySelectorAll('.mweek')];
  const top = sc.scrollTop; let best = rows[0];
  for (const r of rows) { if (r.offsetTop - head.offsetHeight <= top + 1) best = r; else break; }
  return { iso: best.dataset.start, off: Math.round(top - (best.offsetTop - head.offsetHeight)), rows: rows.length }; }"""
GOTO = """async ([iso, dir]) => { for (let i = 0; i < 600; i++) {
    const sc = document.querySelector('.mscroll'), r = sc.querySelector(`.mweek[data-start="${iso}"]`);
    if (r) { sc.scrollTop = r.offsetTop - sc.querySelector('.mhead').offsetHeight; return true; }
    sc.scrollBy(0, dir * 1400); await new Promise((res) => setTimeout(res, 30)); }
  return false; }"""
def change(page, title):   # a real change on the server + the live event that announces it
    page.evaluate("(t) => { window.__FAKE.tables.fm_tasks[0].title = t; window.__FAKE.emit('fm_tasks'); }", title)

def main():
    t = Checks()
    with Site(4176) as site:
        # ---------- 1. live channel: no reconnect loop ----------
        t.name = "live"
        page, errors = site.open(SEED, now=NOW)
        t.eq(fake(page, "live.made"), 1, "one live channel after load")
        page.click("#refresh-btn"); page.wait_for_timeout(1500)
        made = fake(page, "live.made"); reads0 = fake(page, "reads.fm_tasks")
        t.eq(made, 2, "Refresh reconnects once")
        page.clock.run_for(20000); page.wait_for_timeout(300)
        t.eq(fake(page, "live.made"), 2, "no new channels in the 20 s after a Refresh press (it used to reconnect every 3 s)")
        t.ok(fake(page, "reads.fm_tasks") - reads0 <= 2, f"no reload storm after Refresh: {fake(page, 'reads.fm_tasks') - reads0} loads in 20 s")
        t.eq(fake(page, "live.open.length"), 1, "exactly one channel is open")
        page.evaluate("window.__FAKE.drop('CHANNEL_ERROR')"); page.clock.run_for(20000); page.wait_for_timeout(300)
        t.eq(fake(page, "live.made"), 3, "a dropped connection reconnects once")
        t.eq(fake(page, "live.open.length"), 1, "still exactly one channel open after the drop")
        page.evaluate("window.__FAKE.drop('CLOSED'); window.__FAKE.drop('TIMED_OUT')"); page.clock.run_for(30000); page.wait_for_timeout(300)
        t.eq(fake(page, "live.made"), 4, "two failure reports in a row still mean one reconnect")
        change(page, "Shop drawings — level 3"); page.wait_for_timeout(900)
        t.eq(page.locator(".mscroll .chip[data-id='1']").first.inner_text().strip().endswith("level 3"), True, "a live change still reaches the screen")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

        # ---------- 2. a redraw keeps his place ----------
        t.name = "place"
        page, errors = site.open(SEED, now=NOW)
        page.evaluate("document.querySelector('.mscroll').scrollBy(0, 777)"); page.wait_for_timeout(600)
        a = page.evaluate(TOP)
        change(page, "Shop drawings — rev A"); page.wait_for_timeout(1200)
        b = page.evaluate(TOP)
        t.ok(a["iso"] == b["iso"] and abs(a["off"] - b["off"]) <= 1, f"redraw inside the window keeps the exact spot: {a} → {b}")
        # far down: December 2027 is past the 12 months the window is built for
        t.ok(page.evaluate(GOTO, ["2027-12-19", 1]), "scrolled down to the week of Dec 19, 2027"); page.wait_for_timeout(700)
        t.ok("December 2027" in page.locator("#cal-peek").inner_text(), f"peek says December 2027: {page.locator('#cal-peek').inner_text()!r}")
        t.eq(page.locator(".mscroll .day[data-iso='2027-12-24']").get_attribute("class").count("off") >= 1, True, "Christmas Eve 2027 is a day off out there")
        a = page.evaluate(TOP)
        change(page, "Shop drawings — rev B"); page.wait_for_timeout(1500)
        b = page.evaluate(TOP)
        t.eq(b["iso"], a["iso"], "a data change while he is in Dec 2027 does not snap him back")
        t.ok(abs(a["off"] - b["off"]) <= 1, f"…and the spot is exact: {a} → {b}")
        t.ok("December 2027" in page.locator("#cal-peek").inner_text(), "still viewing December 2027 after the redraw")
        t.eq(page.locator("#cal-title").inner_text(), "November 2026", "the month in focus is still November 2026")
        t.eq(page.locator(".mscroll .chip[data-id='4']").count(), 1, "the Dec 2027 task is drawn where he is")
        shot(page, "40-far-dec-2027")
        page.click("#refresh-btn"); page.wait_for_timeout(1800)
        t.eq(page.evaluate(TOP)["iso"], a["iso"], "the Refresh button does not snap him back either")
        page.evaluate("window.dispatchEvent(new Event('resize'))"); page.wait_for_timeout(900)
        t.eq(page.evaluate(TOP)["iso"], a["iso"], "a window resize keeps the place")
        # keep going from there: more rows still load
        page.evaluate("document.querySelector('.mscroll').scrollBy(0, 5000)"); page.wait_for_timeout(700)
        t.ok(page.evaluate(TOP)["iso"] > "2028-02-01", f"scrolling on past the rebuilt window still works: {page.evaluate(TOP)}")
        # far up: 2024
        page.click("#today-btn"); page.wait_for_timeout(900)
        t.ok(page.locator("#cal-peek").is_hidden(), "Today brings him home")
        t.ok(page.evaluate(GOTO, ["2024-10-06", -1]), "scrolled up to October 2024"); page.wait_for_timeout(700)
        a = page.evaluate(TOP)
        change(page, "Shop drawings — rev C"); page.wait_for_timeout(1500)
        b = page.evaluate(TOP)
        t.ok(a["iso"] == b["iso"] and abs(a["off"] - b["off"]) <= 1, f"a redraw in 2024 keeps the place: {a} → {b}")
        # arrows and Today still move the focus
        page.click("#next-btn"); page.wait_for_timeout(1100)
        t.eq(page.locator("#cal-title").inner_text(), "December 2026", "› still moves the month in focus")
        t.ok(page.locator("#cal-peek").is_hidden(), "and lands on it")
        page.click("#today-btn"); page.wait_for_timeout(900)
        t.eq(page.locator("#cal-title").inner_text(), "November 2026", "Today still works")
        t.eq(page.evaluate(TOP)["iso"], "2026-11-01", "Today lands on the first week of November")
        t.eq(errors, [], f"no page errors: {errors}")
        page.context.close()

    # ---------- 3. version stamps agree ----------
    t.name = "version"
    html = (REPO / "index.html").read_text(); sw = (REPO / "sw.js").read_text()
    ver = re.search(r'class="ver"[^>]*>v(\d+)<', html).group(1)
    t.eq(re.findall(r'css/app\.css\?v=(\d+)', html), [ver], "css/app.css?v= matches the corner stamp")
    t.eq(re.findall(r'js/app\.js\?v=(\d+)', html), [ver], "js/app.js?v= matches the corner stamp (or the browser keeps old code for 10 minutes)")
    t.eq(re.findall(r'const VERSION = "ap-v(\d+)"', sw), [ver], "sw.js VERSION matches the corner stamp")
    left = [f.name for f in [REPO / "index.html", REPO / "sw.js", *sorted((REPO / "js").glob("*.js")), *sorted((REPO / "css").glob("*.css"))]
            if re.search(r"^(<<<<<<<|>>>>>>>|=======$)", f.read_text(), flags=re.M)]
    t.eq(left, [], "no merge markers left in a shipped file")
    return t.done()

if __name__ == "__main__":
    sys.exit(main())
