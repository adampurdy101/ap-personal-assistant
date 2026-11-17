"""Shared plumbing for the seed-free checks (scroll_test.py, panel_test.py, …).
Copies the site, swaps js/supabase.js for the in-memory double, serves it, opens it in headless Chrome
with the clock pinned. No personal data: every check builds its own rows."""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SITE = HERE / "site"
SHOTS = HERE / "shots"
OWNER = "30cbcbfa-7261-47de-8c91-3d97557fc5f9"

def build_site():
    if SITE.exists(): shutil.rmtree(SITE)
    shutil.copytree(REPO, SITE, ignore=shutil.ignore_patterns(".git", "supabase", "design", ".github", "test", "__pycache__"))
    shutil.copy(HERE / "fake-supabase.js", SITE / "js" / "supabase.js")
    SHOTS.mkdir(exist_ok=True)

def task(id, title, day, **kw):
    """One fm_tasks row with every column the app reads."""
    row = {"id": id, "user_id": OWNER, "title": title, "notes": None, "bucket": "work", "priority": "normal", "status": "not_started",
           "waiting_on": None, "job": None, "size": "1h", "scheduled_date": day, "target_date": None, "dropdead_date": None, "planned": False,
           "promised_to": None, "nag_hours": 0, "source": "app", "done_at": None, "sort": 0, "created_at": "2026-10-01T16:00:00+00:00",
           "updated_at": "2026-10-01T16:00:00+00:00", "confirmed": True, "deleted_at": None, "carried": 0, "carried_from": None, "start_at": None}
    row.update(kw); return row

def meeting(id, title, day, start="09:00", end="10:00", **kw):
    """One fm_meetings row. Times are Pacific wall-clock for that day (PST, UTC-8 — the checks live in November)."""
    row = {"id": id, "user_id": OWNER, "source": "pci_outlook", "ext_key": f"k-{id}", "title": title, "day": day,
           "start_at": f"{day}T{start}:00-08:00", "end_at": f"{day}T{end}:00-08:00", "all_day": False, "attending": False,
           "hidden": False, "updated_at": "2026-11-01T16:00:00+00:00"}
    row.update(kw); return row

def day_off(id, day, title="PCG holiday — Test Day", source="pcg_holiday"):
    return {"id": id, "user_id": OWNER, "source": source, "ext_key": f"{'pcg' if source == 'pcg_holiday' else 'pto'}-{day}", "title": title, "day": day,
            "start_at": f"{day}T00:00:00+00:00", "end_at": f"{day}T23:59:00+00:00", "all_day": True, "attending": False, "hidden": False,
            "updated_at": "2026-11-01T16:00:00+00:00"}

def seed(tasks=(), meetings=(), jobs=(), bills=(), accounts=(), payments=()):
    return {"tasks": list(tasks), "jobs": list(jobs), "meetings": list(meetings), "bills": list(bills), "accounts": list(accounts), "payments": list(payments), "prefs": []}

class Checks:
    def __init__(self): self.fails = []; self.passes = 0; self.name = ""
    def ok(self, cond, msg):
        if cond: self.passes += 1
        else: self.fails.append(f"[{self.name}] {msg}"); print("  FAIL:", f"[{self.name}] {msg}")
    def eq(self, a, b, msg): self.ok(a == b, f"{msg}: got {a!r}, want {b!r}")
    def done(self):
        print(f"{self.passes} checks passed, {len(self.fails)} failed")
        for f in self.fails: print("  -", f)
        return 0 if not self.fails else 1

class Site:
    """with Site(port) as s: page, errors = s.open(seed_dict, now=…)"""
    def __init__(self, port): self.port = port
    def __enter__(self):
        build_site()
        self.server = subprocess.Popen([sys.executable, "-m", "http.server", str(self.port), "--bind", "127.0.0.1"], cwd=SITE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.8)
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
        return self
    def __exit__(self, *a):
        try: self.browser.close(); self.pw.stop()
        finally: self.server.terminate()
    def open(self, seed_dict, now="2026-11-17T09:00:00-08:00", viewport=(1920, 1080), mobile=False, view=None, bucket="both", storage=None):
        ctx = self.browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, timezone_id="America/Los_Angeles", locale="en-US",
                                       is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
        extra = "".join(f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)}); " for k, v in (storage or {}).items())
        ctx.add_init_script("window.__SEED = " + json.dumps(seed_dict) + f"; try {{ if (!localStorage.getItem('fm.bucket')) localStorage.setItem('fm.bucket', '{bucket}'); "
                            + (f"if (!localStorage.getItem('fm.view')) localStorage.setItem('fm.view', '{view}'); " if view else "") + extra + "} catch (e) {}")
        for pat in ("**/fonts.googleapis.com/**", "**/fonts.gstatic.com/**", "**/s2/favicons**"): ctx.route(pat, lambda r: r.abort())
        ctx.route("**/functions/v1/ap-brain", lambda r: r.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"reply": "Week is balanced. Moved nothing.", "actions": [], "batch_id": "fake-batch-1"})))
        page = ctx.new_page()
        page.clock.install(time=now)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and "ERR_FAILED" not in m.text else None)
        page.goto(f"http://127.0.0.1:{self.port}/index.html", wait_until="load")
        page.wait_for_selector("#app:not(.hidden)")
        page.wait_for_selector(".pday" if mobile else ".tg" if view in ("week", "day") else ".mweek", state="attached", timeout=10000)
        page.wait_for_timeout(600)
        return page, errors

def shot(page, name): page.screenshot(path=str(SHOTS / f"{name}.png"))
def fake(page, expr): return page.evaluate("window.__FAKE." + expr)
def row(page, table, id): return page.evaluate("([t, id]) => window.__FAKE.tables[t].find(r => r.id === id) || null", [table, id])
