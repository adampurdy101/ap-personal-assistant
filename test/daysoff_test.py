#!/usr/bin/env python3
"""Days off draw however far out they are (v56). Needs no seed. Run: python3 test/daysoff_test.py
The meeting window stops 120 days ahead; PCG holidays and PTO past it must still load and draw."""
import os, json, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
HERE = Path(__file__).resolve().parent; REPO = HERE.parent; SITE = HERE / "site"; PORT = 4175
NOW = "2026-11-17T09:00:00-08:00"
def off(day, title, src="pcg_holiday"):
    return {"id": abs(hash(day)) % 10**6, "source": src, "ext_key": f"x-{day}", "title": title, "day": day, "start_at": day + "T00:00:00+00:00",
            "end_at": day + "T23:59:00+00:00", "all_day": True, "attending": False, "hidden": False, "updated_at": "2026-11-17T17:00:00+00:00"}
SEED = {"tasks": [], "jobs": [], "bills": [], "accounts": [], "payments": [], "prefs": [], "meetings": [
    off("2026-11-26", "PCG holiday — Thanksgiving"), off("2027-02-15", "PCG holiday — President's Day"),
    off("2027-03-26", "PCG holiday — Good Friday"), off("2027-09-06", "PCG holiday — Labor Day"),
    off("2027-12-31", "PCG holiday — New Year's Eve"), off("2027-08-13", "PTO — day off", "pto"),
    {**off("2027-06-10", "Far-out meeting", "pci_outlook"), "all_day": False}]}
def main():
    if SITE.exists(): shutil.rmtree(SITE)
    shutil.copytree(REPO, SITE, ignore=shutil.ignore_patterns(".git", "supabase", "design", ".github", "test", "__pycache__"))
    shutil.copy(HERE / "fake-supabase.js", SITE / "js" / "supabase.js")
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=SITE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8); fails = []; n = 0
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
            ctx = b.new_context(viewport={"width": 1920, "height": 1080}, timezone_id="America/Los_Angeles", locale="en-US")
            ctx.add_init_script("window.__SEED = " + json.dumps(SEED) + "; try { localStorage.setItem('fm.bucket','both'); } catch (e) {}")
            for pat in ("**/fonts.googleapis.com/**", "**/fonts.gstatic.com/**", "**/s2/favicons**"): ctx.route(pat, lambda r: r.abort())
            page = ctx.new_page(); page.clock.install(time=NOW); errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="load")
            page.wait_for_selector(".mweek", state="attached", timeout=10000); page.wait_for_timeout(600)
            def is_off(iso):
                for _ in range(16):
                    r = page.evaluate("(d) => { const c = document.querySelector(`.mscroll .day[data-iso='${d}']`); return c ? c.classList.contains('off') : null; }", iso)
                    if r is not None: return r
                    page.click("#next-btn"); page.wait_for_timeout(250)
                return None
            for day, want in [("2026-11-26", True), ("2027-02-15", True), ("2027-03-26", True), ("2027-08-13", True), ("2027-09-06", True), ("2027-12-31", True), ("2027-06-10", False), ("2027-03-25", False)]:
                got = is_off(day); n += 1
                if got != want: fails.append(f"{day}: off={got}, want {want}")
            if page.locator(".ver").inner_text() != "v56": fails.append("version stamp is not v56")
            n += 1
            if errs: fails.append("page errors: " + "; ".join(errs))
            for _ in range(3): page.click("#next-btn"); page.wait_for_timeout(250)   # March 2027 on screen for the visual pass
            if (HERE / "shots").exists(): page.screenshot(path=str(HERE / "shots" / "daysoff-2027-03.png"))
            b.close()
    finally: srv.terminate()
    print(f"{n - len(fails)}/{n} passed"); [print("  FAIL:", f) for f in fails]; sys.exit(1 if fails else 0)
main()
