#!/usr/bin/env python3
"""AP Personal Assistant — sticky alert checks (v55). Needs no seed.json: it builds its own tiny world
(one meeting 14 minutes out). Run: python3 test/alerts_test.py"""
import os, json, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
HERE = Path(__file__).resolve().parent; REPO = HERE.parent; SITE = HERE / "site"; SHOTS = HERE / "shots"; PORT = 4174
OWNER = "30cbcbfa-7261-47de-8c91-3d97557fc5f9"
NOW = "2026-11-03T09:00:00-08:00"
SEED = {"tasks": [], "jobs": [], "bills": [], "accounts": [], "payments": [], "prefs": [], "meetings": [
    {"id": 1, "user_id": OWNER, "title": "BIM Meeting", "day": "2026-11-03", "start_at": "2026-11-03T17:14:00+00:00", "end_at": "2026-11-03T18:14:00+00:00",
     "all_day": False, "source": "pci_outlook", "attending": True, "hidden": False}]}
fails = []
def ok(c, m):
    print(("  ok   " if c else "  FAIL ") + m)
    if not c: fails.append(m)

if SITE.exists(): shutil.rmtree(SITE)
shutil.copytree(REPO, SITE, ignore=shutil.ignore_patterns(".git", "supabase", "design", ".github", "test", "__pycache__"))
shutil.copy(HERE / "fake-supabase.js", SITE / "js" / "supabase.js"); SHOTS.mkdir(exist_ok=True)
srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=SITE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context(viewport={"width": 1600, "height": 900}, timezone_id="America/Los_Angeles", locale="en-US", permissions=["notifications"])
        ctx.add_init_script("window.__SEED = " + json.dumps(SEED) + "; try { localStorage.setItem('fm.bucket','both'); localStorage.setItem('fm.alerts','on'); } catch (e) {}"
            # count every pop-up the app asks for, whatever the headless browser does with it
            + "; window.__POPS = []; (() => { const P = ServiceWorkerRegistration.prototype, f = P.showNotification; P.showNotification = function (t, o) { window.__POPS.push({ t, o }); return Promise.resolve(); }; P.getNotifications = () => Promise.resolve([]); })();")
        for pat in ("**/fonts.googleapis.com/**", "**/fonts.gstatic.com/**"): ctx.route(pat, lambda r: r.abort())
        page = ctx.new_page(); page.clock.install(time=NOW)
        errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="load")
        page.wait_for_selector("#app:not(.hidden)"); page.wait_for_selector(".mweek", state="attached")
        cards = lambda: page.locator("#alert-stack .apal-card:not(.apal-zz)")
        zz = lambda: page.locator("#alert-stack .apal-zz")
        pops = lambda: page.evaluate("window.__POPS.length")
        ok(cards().count() == 0, "no alert card before anything is due")
        page.clock.run_for(10_000)          # the first alert check runs 4 s after load: meeting is 14 min out
        page.wait_for_timeout(300)
        ok(cards().count() == 1, "meeting alert card is up")
        ok("In 15 min — BIM Meeting" in cards().first.inner_text(), "card names the meeting")
        ok(pops() == 1, "one Windows pop-up asked for")
        o = page.evaluate("window.__POPS[0].o")
        ok(o.get("requireInteraction") is True, "pop-up is set to stay until he acts")
        ok([a["action"] for a in o.get("actions", [])] == ["snooze5", "snooze15"], "pop-up has Snooze 5 and Snooze 15 buttons")
        btns = cards().first.locator("button").all_inner_texts()
        ok(btns == ["✓ Clear", "5 min", "15 min", "30 min"], f"card buttons: {btns}")
        page.screenshot(path=str(SHOTS / "alert-01-up.png"))
        page.clock.run_for(60_000); page.wait_for_timeout(200)
        ok(cards().count() == 1, "still up a minute later (does not fade)")
        n = pops(); page.clock.run_for(75_000); page.wait_for_timeout(200)
        ok(pops() > n or page.evaluate("document.hasFocus()"), "nags again after 2 minutes uncleared")
        page.reload(wait_until="load"); page.wait_for_selector("#app:not(.hidden)"); page.wait_for_timeout(500)
        ok(cards().count() == 1, "alert survives a refresh of the app")
        # snooze 5
        cards().first.get_by_text("5 min", exact=True).click(); page.wait_for_timeout(200)
        ok(cards().count() == 0 and zz().count() == 1, "Snooze 5: card drops to a snoozed line")
        ok("Snoozed until" in zz().first.inner_text(), "snoozed line says when it comes back")
        page.screenshot(path=str(SHOTS / "alert-02-snoozed.png"))
        page.clock.run_for(4 * 60_000); page.wait_for_timeout(200)
        ok(cards().count() == 0, "still snoozed at 4 minutes")
        n = pops(); page.clock.run_for(75_000); page.wait_for_timeout(300)
        ok(cards().count() == 1 and zz().count() == 0, "back up after 5 minutes")
        ok(pops() == n + 1, "pops again when the snooze ends")
        # pop-up buttons (messages from the service worker)
        page.evaluate("navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'ap-alert', do: 'snooze', tag: 'mtg-1', min: 15 } }))"); page.wait_for_timeout(200)
        ok(zz().count() == 1, "pop-up's Snooze 15 button snoozes the card too")
        page.evaluate("navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'ap-alert', do: 'clear', tag: 'mtg-1' } }))"); page.wait_for_timeout(200)
        ok(page.locator("#alert-stack .apal-card").count() == 0 and page.locator("#alert-stack").is_hidden(), "closing the pop-up clears it in AP")
        # the 'Now' alert at start time, then Clear
        page.clock.run_for(9 * 60_000); page.wait_for_timeout(300)
        ok(cards().count() == 1 and "Now — BIM Meeting" in cards().first.inner_text(), "'Now' alert comes up at start time")
        cards().first.get_by_text("✓ Clear").click(); page.wait_for_timeout(200)
        ok(page.locator("#alert-stack .apal-card").count() == 0, "Clear removes it")
        page.clock.run_for(5 * 60_000); page.wait_for_timeout(200)
        ok(page.locator("#alert-stack .apal-card").count() == 0, "cleared alert stays gone")
        ok(not errs, f"no page errors: {errs[:3]}")
        b.close()
finally:
    srv.terminate()
print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
