#!/usr/bin/env python3
"""Integrity tests for the published site. Runs locally and in .github/workflows/hourly_sync.yml.

Hard rules (a failure blocks the hourly commit + deploy):
  - only remote tech internships: every role is an internship, 100% remote and pure tech
  - only five countries: every role is open to Australia, Germany, Singapore, the UAE or the UK,
    and every company is filed under one of them
  - nothing in the United States: no company, role, country or contact location
  - no company with an India office
  - contacts are HR / talent, founders & CTOs, VPs, directors or heads only (no partnerships)
  - every published email is validated (mail server found + Prospeo verified, listed on the
    company's site, or ZeroBounce valid); company mailboxes are hiring / HR ones only
  - every company LinkedIn link is a canonical linkedin.com/company page
  - countries are listed A -> Z
  - the updater runs hourly ('0 * * * *') and the page re-verifies every 3600 s

Contact coverage is reported, not enforced: it depends on what's publicly available, and numbers
are never invented to fill gaps.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COUNTRIES = ["Australia", "Germany", "Singapore", "United Arab Emirates", "United Kingdom"]
REGIONS = ["Australia", "Europe", "MEA", "SEA", "UK"]
TEAMS = ["Talent & HR", "Founders & CTO", "Leadership"]
OFFICE_RE = re.compile(r"hybrid|in[- ]office|in[- ]person|on-?site (only|required)|days? (a |per )?week in (the )?office|office[- ]based|relocat(e|ion) (to|required)", re.I)
NON_TECH_RE = re.compile(r"\b(sales|sdr|bdr|account executive|marketing|recruit\w*|talent acquisition|human resources|compliance|mlro|legal|customer success|copywriter|gtm|operations manager|product manager|designer|consultant)\b", re.I)
INTERN_RE = re.compile(r"\bintern(ship)?s?\b|\bco-?op\b|praktik(um|ant|antin)\b|pflichtpraktikum|industrial placement|placement year|year in industry", re.I)
INDIA_RE = re.compile(r"\bindia\b|bengaluru|bangalore|hyderabad|mumbai|\bpune\b|gurugram|gurgaon|noida|chennai|new delhi", re.I)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
PARTNER_RE = re.compile(r"partner(ship)?s?\b|alliance|business development|\bbd\b|bizdev", re.I)
FOUNDER_RE = re.compile(r"founder|\bcto\b|chief technology", re.I)
TALENT_RE = re.compile(r"recruit|talent|human resources|\bhr\b|people|campus|early careers|university", re.I)
MAILBOX_RE = re.compile(r"^(careers?|jobs?|hiring|recruit\w*|talent|hr|people|join|work|campus|interns?|internships?|apply|cv|resumes?)([._-]|$)", re.I)
LINKEDIN_CO_RE = re.compile(r"^https://www\.linkedin\.com/(company|school|showcase)/[^/?#\s]+$")

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
    data = json.loads((ROOT / "data/internships.json").read_text())
    html = (ROOT / "index.html").read_text()
    app = (ROOT / "app.js").read_text()
    workflow = (ROOT / ".github/workflows/hourly_sync.yml").read_text()
    companies = data["companies"]
    raw_text = json.dumps(data)

    # 1. No USA anywhere
    check('"United States"' not in raw_text and '"USA"' not in raw_text, "the string United States / USA appears in data/internships.json")
    check("Hide USA" not in html and "United States" not in html, "index.html still mentions Hide USA / United States")
    for c in companies:
        check((c.get("hq") or {}).get("countryCode") not in ("US", "IN"), f"{c['name']}: headquarters in {(c.get('hq') or {}).get('countryCode')}")
        for p in c.get("contacts", []):
            check("united states" not in (p.get("location") or "").lower(), f"{c['name']}: contact {p.get('name')} located in the US")

    # 2. Every role: a remote, pure-tech internship open to one of the five countries
    roles = 0
    for c in companies:
        check(len(c["jobs"]) > 0, f"{c['name']}: company without roles")
        check(c.get("country") in COUNTRIES, f"{c['name']}: country {c.get('country')} is not one of the five")
        check(c.get("region") in REGIONS, f"{c['name']}: region {c.get('region')} outside scope")
        for j in c["jobs"]:
            roles += 1
            where = f"{c['name']} / {j['title']}"
            check(j.get("type") == "internship", f"{where}: not an internship ({j.get('type')})")
            check(INTERN_RE.search(j["title"]) is not None or j.get("src") in ("ashby", "lever", "yc", "jobfound", "remotive", "jobicy", "arbeitnow"), f"{where}: title doesn't say internship")
            check(j.get("remote") is True, f"{where}: not marked remote")
            check(not OFFICE_RE.search(f"{j.get('location') or ''} {j['title']}"), f"{where}: hybrid / office wording")
            check(j.get("tech") is True and not NON_TECH_RE.search(j["title"]), f"{where}: not a pure tech role")
            check(bool(j.get("places")) and set(j["places"]) <= set(COUNTRIES), f"{where}: countries {j.get('places')} outside the five")
            check(j.get("remoteScope", "").startswith("100% Remote"), f"{where}: missing remote scope label")

    # 3. No India offices
    for c in companies:
        check(not INDIA_RE.search(c.get("location") or ""), f"{c['name']}: India in company location")
        check(not any(r in ("India", "South Asia") for r in c.get("regions") or []), f"{c['name']}: India in company regions")

    # 4. Countries A -> Z (dataset + page logic)
    countries = data["meta"].get("countries", [])
    check(countries == sorted(countries, key=az_key), f"meta.countries not A-Z: {countries}")
    check(set(countries) <= set(COUNTRIES), f"meta.countries outside the five: {countries}")
    check(data["meta"].get("scopeCountries") == COUNTRIES, f"meta.scopeCountries should be {COUNTRIES}")
    check("localeCompare(b, \"en\")" in app, "page does not sort countries with localeCompare('en')")
    check(data["meta"].get("regions") == REGIONS, f"meta.regions should be {REGIONS}")

    # 5. Contacts: allowed people only, validated emails, well-formed phones / LinkedIn
    for c in companies:
        if c.get("linkedin"):
            check(LINKEDIN_CO_RE.match(c["linkedin"]) is not None, f"{c['name']}: company LinkedIn is not a canonical company page: {c['linkedin']}")
        for p in c.get("contacts", []):
            who = f"{c['name']}: {p.get('name')} ({p.get('title')})"
            check(p.get("team") in TEAMS, f"{who}: team {p.get('team')} not allowed")
            title = p.get("title") or ""
            check(not PARTNER_RE.search(title) or FOUNDER_RE.search(title) or TALENT_RE.search(title), f"{who}: partnerships contact")
            if p.get("email"):
                check(EMAIL_RE.match(p["email"]) is not None, f"{who}: bad email {p['email']}")
                chk = p.get("emailCheck") or {}
                check(chk.get("mx") is True and bool(chk.get("basis")), f"{who}: email {p['email']} not validated")
                check(chk.get("zeroBounce") not in ("invalid", "spamtrap", "abuse", "do_not_mail"), f"{who}: ZeroBounce rejected {p['email']}")
            if p.get("phone"):
                check(phone_ok(p["phone"]), f"{who}: bad phone {p['phone']}")
            if p.get("linkedin"):
                check(re.match(r"^https?://([a-z]{2,3}\.)?linkedin\.com/in/", p["linkedin"]) is not None, f"{who}: LinkedIn field is not a profile URL: {p['linkedin']}")
        for e in (c.get("channels") or {}).get("emails", []):
            check(MAILBOX_RE.match(e["email"].split("@")[0]) is not None, f"{c['name']}: non-hiring company mailbox {e['email']}")
            check((e.get("emailCheck") or {}).get("mx") is True, f"{c['name']}: company mailbox {e['email']} not validated")
        for x in (c.get("channels") or {}).get("phones", []):
            check(phone_ok(x["phone"]), f"{c['name']}: bad HQ phone {x['phone']}")
    check("INITIAL_LEADS" not in html + app, "page embeds hard-coded leads")

    # 6. Hourly schedule + in-browser hourly verification
    check("cron: '0 * * * *'" in workflow, "hourly_sync.yml is not scheduled '0 * * * *'")
    check("countdownSeconds = 3600" in app, "page does not re-verify every 3600 s")
    check(not (ROOT / ".github/workflows/update.yml").exists(), "old update.yml workflow still present")

    # Report: contact coverage (informational)
    def has(c, pred):
        return any(pred(p) for p in c.get("contacts", []))
    n = len(companies)
    li = sum(1 for c in companies if c.get("linkedin"))
    talent = sum(1 for c in companies if has(c, lambda p: p.get("team") == "Talent & HR"))
    founder = sum(1 for c in companies if has(c, lambda p: p.get("team") == "Founders & CTO"))
    emails = sum(1 for c in companies if has(c, lambda p: p.get("email")) or (c.get("channels") or {}).get("emails"))
    by_country = {k: sum(1 for c in companies if c.get("country") == k) for k in COUNTRIES}

    print(f"Checked {n} startups, {roles} remote tech internships, countries: {by_country}.")
    print(f"Coverage: company LinkedIn {li}/{n} · HR/talent named {talent}/{n} · founder/CTO named {founder}/{n} · validated email {emails}/{n}")
    if failures:
        print(f"\nFAILED ({len(failures)}):")
        for f in failures[:50]:
            print("  -", f)
        sys.exit(1)
    print("All integrity checks passed.")


if __name__ == "__main__":
    main()
