#!/usr/bin/env python3
"""Run every check-before-push suite, one after the other. Run: python3 test/all.py
Exit code 0 only when every suite passes. About 6 minutes."""
import subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUITES = ["scroll_test.py", "panel_test.py", "misc_test.py", "daysoff_test.py", "alerts_test.py", "run_tests.py"]

def main():
    bad = []
    for name in SUITES:
        t0 = time.time()
        r = subprocess.run([sys.executable, name], cwd=HERE, capture_output=True, text=True)
        tail = [l for l in (r.stdout + r.stderr).strip().splitlines() if l.strip()]
        verdict = "PASS" if r.returncode == 0 else "FAIL"
        print(f"{verdict}  {name:<18} {tail[-1] if tail and r.returncode == 0 else ''}  ({time.time() - t0:.0f} s)")
        if r.returncode != 0:
            bad.append(name)
            for l in tail[-25:]: print("      " + l)
    print("\nALL SUITES PASS" if not bad else f"\n{len(bad)} suite(s) failed: {', '.join(bad)}")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
