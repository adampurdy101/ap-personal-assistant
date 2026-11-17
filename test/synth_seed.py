"""A made-up data set for the check-before-push harness (run_tests.py) — no real rows, nothing personal.
It is shaped so the same rows work in the two worlds the checks run in:
  · Tue Nov 3, 2026 9:00 a.m.  (FIXED_NOW — run_tests.py pins five rows back to it, see PINS there)
  · Thu Nov 12, 2026 1:57 p.m. (NOW2 — the clock-view checks, rows used as they are here)
Rules the rows follow, so both worlds hold:
  · nothing OPEN is dated before Nov 12 (the Nov 12 world would carry it to today) — the five pinned rows
    (3, 8, 32, 33, 36) are done here and re-opened by PINS for the Nov 3 world
  · the week of Nov 8–14 holds exactly three open tasks, all on Fri Nov 13: 59 (15 min), 63 (half day), 64 (1 h)
  · Thu Nov 12 has three meetings (ENS 8:00 invited · BIM Coordination 9–10 attended · Seattle Staff invited),
    Fri Nov 13 has two (ENS · Weekly check-in 9–10 attended); one canceled series is hidden
  · PTO Nov 18 – Dec 4 (weekdays) + company holidays Nov 26/27, so "+1 week" from Nov 13 / Nov 17 lands on Mon Dec 7
  · bills: unpaid ones in October and on Nov 1 (LATE in the Nov 3 world), nothing due Nov 20
"""
from datetime import date, timedelta
from _kit import OWNER, task, meeting, day_off

T8 = "File the benefits paperwork — call the state office"   # the task the edit / undo checks rename and restore

def _d(s): y, m, d = map(int, s.split("-")); return date(y, m, d)
def _weekdays(a, b):
    d = _d(a)
    while d <= _d(b):
        if d.weekday() < 5: yield d.isoformat()
        d += timedelta(days=1)

def make_seed():
    jobs = [{"id": i + 1, "user_id": OWNER, "name": n, "bucket": b, "sort": i, "active": True, "created_at": "2026-10-01T16:00:00+00:00"}
            for i, (n, b) in enumerate([("Miner", "work"), ("Tower A", "work"), ("Lab TI", "work"), ("Lounge", "work"), ("Hospital shops", "work"),
                                        ("Layout", "work"), ("Title blocks", "work"), ("House", "home"), ("Trip", "home"), ("Kids", "home")])]
    done = lambda day, hhmm="22:30": {"status": "done", "done_at": f"{day}T{hhmm}:00+00:00"}
    tasks = [
        # the five rows the checks click on (done here; PINS re-open them for the Nov 3 world)
        task(8,  T8, "2026-11-10", bucket="home", job="House", confirmed=False, **done("2026-11-10")),
        task(3,  "Level 2 leave-outs — model check", "2026-11-06", job="Miner", priority="high", **done("2026-11-06")),
        task(32, "Move the facility payment", "2026-11-04", bucket="home", job="House", **done("2026-11-04")),
        task(36, "Pick up the dry cleaning", "2026-11-05", bucket="home", **done("2026-11-05")),
        task(33, "Oil change — truck", "2026-11-07", bucket="home", job="House", size="half", **done("2026-11-07")),
        # the week of Nov 8–14: three open, untimed, on Friday
        task(59, "Send the RFI log", "2026-11-13", job="Tower A", size="15m", priority="low"),
        task(63, "Build the garage shelves", "2026-11-13", bucket="home", job="House", size="half", priority="low"),
        task(64, "Layout file check before the print", "2026-11-13", job="Layout", size="1h", priority="low"),
        # finished work behind us (Done log: three on Nov 2 = "Yesterday" in the Nov 3 world)
        task(101, "Export the level 1 DWG", "2026-11-02", job="Lounge", **done("2026-11-02", "18:05")),
        task(102, "Clash list to the GC", "2026-11-02", job="Tower A", priority="high", **done("2026-11-02", "21:40")),
        task(103, "Renew the truck tabs", "2026-11-02", bucket="home", size="15m", **done("2026-11-02", "23:10")),
        task(104, "Wall type book — first pass", "2026-10-30", job="Title blocks", size="half", **done("2026-10-30")),
        task(105, "Model the corridor soffits", "2026-10-29", job="Hospital shops", size="full", **done("2026-10-29")),
        task(106, "Pay the contractor deposit", "2026-10-28", bucket="home", job="House", **done("2026-10-28")),
        task(107, "Bid hours to the estimator", "2026-10-27", priority="urgent", promised_to="Pat", **done("2026-10-27")),
        task(108, "Print the Dusty test sheet", "2026-10-26", job="Layout", **done("2026-10-26")),
        task(109, "Title block E1 — revisions", "2026-10-22", job="Title blocks", **done("2026-10-22")),
        task(110, "Book the kennel", "2026-10-21", bucket="home", job="Trip", size="15m", **done("2026-10-21")),
        # ahead of us (both worlds): the two days before the trip, then after it
        task(120, "Coordination sign-off — level 2", "2026-11-16", job="Miner", priority="high", promised_to="Sam", dropdead_date="2026-11-17"),
        task(121, "Pack for the trip", "2026-11-17", bucket="home", job="Trip", size="half"),
        task(122, "Hand off open items", "2026-11-17", job="Tower A", target_date="2026-11-17", confirmed=False),
        task(123, "Shop drawing resubmittal", "2026-12-07", job="Lab TI", size="full", dropdead_date="2026-12-11"),
        task(124, "Year-end PTO check", "2026-12-08", size="15m", priority="low"),
        task(125, "Order the gift", "2026-12-12", bucket="home", job="Kids", planned=True),
        task(126, "Waiting on the GC schedule", "2026-12-09", job="Lounge", status="waiting", waiting_on="the GC"),
        task(127, "Takeoff engine — try it on one floor", None, job="Title blocks", size="half"),          # inbox (no day)
        task(128, "Call the gutter guy", None, bucket="home", job="House", size="15m", confirmed=False),  # inbox (no day)
    ]
    meetings, mid = [], 2000
    def add(row): meetings.append(row); return row
    # ENS: every weekday 8:00–8:30, invited (not attended). The Nov 12 one is id 56.
    for d in _weekdays("2026-09-28", "2027-02-12"):
        mid += 1
        add(meeting(56 if d == "2026-11-12" else mid, "ENS Daily Review", d, "08:00", "08:30"))
    # the two he goes to
    for d in _weekdays("2026-09-28", "2027-02-12"):
        wd = _d(d).weekday(); mid += 1
        if wd == 3: add(meeting(mid, "BIM Coordination", d, "09:00", "10:00", attending=True))
        if wd == 4: add(meeting(mid, "Weekly check-in", d, "09:00", "10:00", attending=True))
    add(meeting(98, "Seattle Staff Meeting", "2026-11-12", "11:00", "12:00"))
    # a series the organizer canceled: hidden on its own, listed in Hidden meetings
    for d in _weekdays("2026-10-05", "2026-12-18"):
        if _d(d).weekday() == 2: mid += 1; add(meeting(mid, "Canceled: Safety stand-down", d, "13:00", "13:30", hidden=True))
    # days off
    oid = 5000
    for d, name in [("2026-11-26", "Thanksgiving"), ("2026-11-27", "Day after Thanksgiving"), ("2026-12-24", "Christmas Eve"), ("2026-12-25", "Christmas Day"),
                    ("2027-01-01", "New Year's Day"), ("2027-01-18", "MLK Day"), ("2027-02-15", "President's Day"), ("2027-03-26", "Good Friday"),
                    ("2027-05-31", "Memorial Day"), ("2027-07-05", "Independence Day"), ("2027-09-06", "Labor Day"), ("2027-11-25", "Thanksgiving"),
                    ("2027-12-24", "Christmas Eve"), ("2027-12-31", "New Year's Eve")]:
        oid += 1; add(day_off(oid, d, f"PCG holiday — {name}"))
    for d in _weekdays("2026-11-18", "2026-12-04"):
        if d in ("2026-11-26", "2026-11-27"): continue
        oid += 1; add(day_off(oid, d, "PTO — trip", source="pto"))

    accounts = [{"id": 1, "user_id": OWNER, "bank": "Credit Union", "nick": "Checking", "last4": "1234", "sort": 0},
                {"id": 2, "user_id": OWNER, "bank": "Rewards Card", "nick": None, "last4": "5678", "sort": 1}]
    def bill(id, name, amount, anchor, recur="monthly", **kw):
        row = {"id": id, "user_id": OWNER, "name": name, "domain": None, "amount": amount, "recur": recur, "anchor_date": anchor, "account_id": 1,
               "remind_days": 2, "autopay": False, "notes": None, "photo": None, "ended_on": None, "deleted_at": None, "sort": id, "legacy_id": None,
               "created_at": "2026-06-01T16:00:00+00:00", "updated_at": "2026-06-01T16:00:00+00:00"}
        row.update(kw); return row
    bills = [bill(1, "Mortgage", 2150, "2026-06-01", autopay=True), bill(2, "Power", 142.37, "2026-06-05"), bill(3, "Water + sewer", 96.1, "2026-06-10"),
             bill(4, "Internet", 79.99, "2026-06-12", account_id=2, autopay=True), bill(5, "Phones", 168, "2026-06-15", account_id=2),
             bill(6, "Car insurance", 211.5, "2026-06-18"), bill(7, "Streaming", 22.99, "2026-06-22", account_id=2, autopay=True),
             bill(8, "Trash service", 54, "2026-06-25"), bill(9, "Gym", 45, "2026-06-28", account_id=None),
             bill(10, "Paycheck savings move", 300, "2026-10-09", recur="biweekly"), bill(11, "Property tax", 3120, "2026-04-30", recur="yearly"),
             bill(12, "Appliance repair", 185, "2026-11-09", recur="once"), bill(13, "Heating oil plan", 240, "2026-09-02", ended_on="2027-02-02")]
    payments, pid = [], 0
    def paid(bid, due, at=None):
        nonlocal pid; pid += 1
        payments.append({"id": pid, "user_id": OWNER, "bill_id": bid, "due_date": due, "paid_at": (at or due) + "T18:00:00+00:00", "amount": None, "source": "migrated", "note": None})
    for b in bills:   # everything through September is paid
        if b["recur"] == "monthly":
            for m in (6, 7, 8, 9):
                due = f"2026-{m:02d}-{b['anchor_date'][8:]}"
                if due >= b["anchor_date"]: paid(b["id"], due)
    for bid, due in [(1, "2026-10-01"), (2, "2026-10-05"), (3, "2026-10-10"), (4, "2026-10-12"), (7, "2026-10-22"), (13, "2026-10-02"), (10, "2026-10-09")]: paid(bid, due)
    # left unpaid on purpose: Phones Oct 15, Car insurance Oct 18, Trash Oct 25, Gym Oct 28, savings Oct 23, Mortgage Nov 1, Heating oil Nov 2
    return {"tasks": tasks, "jobs": jobs, "meetings": meetings, "bills": bills, "accounts": accounts, "payments": payments, "prefs": []}

if __name__ == "__main__":
    s = make_seed(); print({k: len(v) for k, v in s.items()})
