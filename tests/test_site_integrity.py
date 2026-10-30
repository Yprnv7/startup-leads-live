#!/usr/bin/env python3
"""Integrity tests for the published site. Runs locally and in .github/workflows/hourly_sync.yml.

Hard rules (a failure blocks the hourly commit + deploy):
  - nothing in the United States: no company, role, country or contact location
  - every role is 100% remote (no hybrid / in-office / relocation) and pure tech
  - every role is workable from Australia, Europe, MEA, New Zealand, SEA or the UK
  - no company with an India office
  - countries are listed A -> Z
  - every email / phone / LinkedIn on the site is well-formed (no placeholders)
  - the updater runs hourly ('0 * * * *') and the page re-verifies every 3600 s

Contact coverage (how many startups have a C-Suite email + phone + LinkedIn) is reported, not
enforced: it depends on what's publicly available, and numbers are never invented to fill gaps.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGIONS = ["Australia", "Europe", "MEA", "New Zealand", "SEA", "UK"]
OFFICE_RE = re.compile(r"hybrid|in[- ]office|in[- ]person|on-?site (only|required)|days? (a |per )?week in (the )?office|office[- ]based|relocat(e|ion) (to|required)", re.I)
NON_TECH_RE = re.compile(r"\b(sales|sdr|bdr|account executive|marketing|recruit\w*|talent acquisition|human resources|compliance|mlro|legal|customer success|copywriter|gtm|operations manager|product manager|designer)\b", re.I)
INDIA_RE = re.compile(r"\bindia\b|bengaluru|bangalore|hyderabad|mumbai|\bpune\b|gurugram|gurgaon|noida|chennai|new delhi", re.I)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
CSUITE_RE = re.compile(r"\b(ceo|cto|cpo|coo|cfo|chief|co-?founder|founder|president|vp,? (of )?engineering|head of (engineering|ai|technology))\b", re.I)

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def az_key(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().casefold()


def phone_ok(p):
    digits = re.sub(r"\D", "", p or "")
    return bool(re.match(r"^[+\d(][+\d\s().-]+$", p or "")) and 7 <= len(digits) <= 15


def main():
    data = json.loads((ROOT / "data/leads.json").read_text())
    html = (ROOT / "index.html").read_text()
    app = (ROOT / "app.js").read_text()
    workflow = (ROOT / ".github/workflows/hourly_sync.yml").read_text()
    companies = data["companies"]
    raw_text = json.dumps(data)

    # 1. No USA anywhere
    check('"United States"' not in raw_text and '"USA"' not in raw_text, "the string United States / USA appears in data/leads.json")
    check("Hide USA" not in html and "United States" not in html, "index.html still mentions Hide USA / United States")
    for c in companies:
        check(c.get("country") != "United States", f"{c['name']}: country is United States")
        for p in c.get("contacts", []):
            check("united states" not in (p.get("location") or "").lower(), f"{c['name']}: contact {p.get('name')} located in the US")

    # 2/3. Every role: remote, pure tech, in the six regions
    roles = 0
    for c in companies:
        check(len(c["jobs"]) > 0, f"{c['name']}: company without roles")
        check(c.get("region") in REGIONS + ["Global"], f"{c['name']}: region {c.get('region')} outside scope")
        for j in c["jobs"]:
            roles += 1
            where = f"{c['name']} / {j['title']}"
            check(j.get("remote") is True, f"{where}: not marked remote")
            check(not OFFICE_RE.search(f"{j.get('location') or ''} {j['title']}"), f"{where}: hybrid / office wording")
            check(j.get("tech") is True and not NON_TECH_RE.search(j["title"]), f"{where}: not a pure tech role")
            check(bool(j.get("regions")) and set(j["regions"]) <= set(REGIONS), f"{where}: regions {j.get('regions')} outside scope")
            check(j.get("remoteScope", "").startswith("100% Remote"), f"{where}: missing remote scope label")
            check(j.get("type") in ("job", "internship"), f"{where}: unknown type {j.get('type')}")

    # 4. No India offices
    for c in companies:
        check(not INDIA_RE.search(c.get("location") or ""), f"{c['name']}: India in company location")
        check(not any(r in ("India", "South Asia") for r in c.get("regions") or []), f"{c['name']}: India in company regions")

    # 5. Countries A -> Z (dataset + page logic)
    countries = data["meta"].get("countries", [])
    check(countries == sorted(countries, key=az_key), f"meta.countries not A-Z: {countries}")
    check("United States" not in countries, "United States listed in meta.countries")
    check("localeCompare(b, \"en\")" in app, "page does not sort countries with localeCompare('en')")
    check(data["meta"].get("regions") == REGIONS, f"meta.regions should be {REGIONS}")

    # 6. Contacts are well-formed (no placeholders, no fake LinkedIn links)
    for c in companies:
        for p in c.get("contacts", []):
            if p.get("email"):
                check(EMAIL_RE.match(p["email"]) is not None, f"{c['name']}: bad email {p['email']}")
            if p.get("phone"):
                check(phone_ok(p["phone"]), f"{c['name']}: bad phone {p['phone']}")
            if p.get("linkedin"):
                check(re.match(r"^https?://([a-z]{2,3}\.)?linkedin\.com/", p["linkedin"]) is not None, f"{c['name']}: LinkedIn field is not a LinkedIn URL: {p['linkedin']}")
        for x in (c.get("channels") or {}).get("phones", []):
            check(phone_ok(x["phone"]), f"{c['name']}: bad HQ phone {x['phone']}")
    check("INITIAL_LEADS" not in html + app, "page embeds hard-coded leads")

    # 7. Hourly schedule + in-browser hourly verification
    check("cron: '0 * * * *'" in workflow, "hourly_sync.yml is not scheduled '0 * * * *'")
    check("countdownSeconds = 3600" in app, "page does not re-verify every 3600 s")
    check(not (ROOT / ".github/workflows/update.yml").exists(), "old update.yml workflow still present")

    # Report: contact coverage (informational)
    def has(c, pred):
        return any(pred(p) for p in c.get("contacts", []))
    hq = lambda c: bool((c.get("channels") or {}).get("phones"))
    full = sum(1 for c in companies if has(c, lambda p: CSUITE_RE.search(p.get("title") or "") and p.get("email") and p.get("linkedin") and (p.get("phone") or hq(c))))
    csuite = sum(1 for c in companies if has(c, lambda p: CSUITE_RE.search(p.get("title") or "")))
    emails = sum(1 for c in companies if has(c, lambda p: p.get("email")))
    phones = sum(1 for c in companies if has(c, lambda p: p.get("phone")) or hq(c))
    interns = sum(1 for c in companies for j in c["jobs"] if j["type"] == "internship")

    print(f"Checked {len(companies)} startups, {roles} roles ({interns} internships), {len(countries)} countries.")
    print(f"Contact coverage: C-Suite named {csuite}/{len(companies)} · any email {emails} · any phone {phones} · "
          f"C-Suite email+phone+LinkedIn {full}/{len(companies)}")
    if failures:
        print(f"\nFAILED ({len(failures)}):")
        for f in failures[:50]:
            print("  -", f)
        sys.exit(1)
    print("All integrity checks passed.")


if __name__ == "__main__":
    main()
