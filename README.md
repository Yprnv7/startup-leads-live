# Startup Leads Live

**100% remote, pure-tech internships open in the UK, Germany, Australia, Singapore and the UAE, with HR / talent, founder, CTO, VP, director and head-of contacts and validated emails.** It updates itself every hour.

**Site:** https://yprnv7.github.io/startup-leads-live/ (reads `data/internships.json`)

**RTI tracker:** https://yprnv7.github.io/startup-leads-live/rti/ is unchanged and keeps its previous data: remote tech jobs and internships in Australia, Europe, MEA, New Zealand, SEA and the UK (`data/leads.json`), built every hour by the site's previous pipeline in `scripts/rti/` (own settings in `scripts/rti/config.json`, own state in `data/rti-state.json`, tests in `tests/test_rti_data.py`).

## What's on the site (enforced in the data, checked by tests every hour)

- **Internships only.** The title must say intern / internship / co-op / Praktikum (or the company's own job board must list it as an internship). Full-time jobs, working-student (Werkstudent), thesis, apprentice and trainee posts are dropped.
- **100% remote only.** A role must be remote by its job board's own flag (Ashby `workplaceType: Remote`, Lever `workplaceType: remote`) or by its stated location. Anything hybrid, in-office, "X days in office" or requiring relocation is dropped.
- **Pure tech only.** Software (backend, frontend, full-stack, systems), AI/ML/LLM, data and quant, DevOps/SRE/cloud/platform, security, mobile, robotics/embedded, and tech internships. Sales, GTM, marketing, recruiting, HR, legal, compliance, ops, PM, design, support and non-software engineering are dropped.
- **Five countries, no USA.** Each internship must be open to people in the UK, Germany, Australia, Singapore or the UAE: the posting names the country, or it is remote across a wider area (worldwide, Europe, EMEA, APAC, MENA) and the company is based in that country. Everything else is dropped. Companies are excluded if they are **headquartered in the US** (from the company's location, YC data, Prospeo's company record, Wikidata's headquarters, or the posting itself saying "headquartered in …"), **hire in the US** (job-feed companies with no known HQ), or are on the `excludeCompanies` list in `config.json`.
- **Posting text is checked.** Every posting's full text is read, and a role is dropped if:
  - it clearly requires office or hybrid work and offers no remote option (for example "This is an in-person role", "Hybrid (2 days a week in office)", "will transition to hybrid");
  - an agency is posting for an unnamed client ("Our client is…");
  - its title names a country outside the five.

  Talent marketplaces (Proxify, Lemon.io and others) are excluded in `config.json`. The same role listed twice is shown once.
- **No India offices.** A company is excluded if its location, YC regions or any of its job locations name an Indian city.
- **Countries A → Z** everywhere, using `localeCompare('en')`.
- **Closed roles turn red.** The server re-checks every role hourly. Open pages also re-check Greenhouse, Lever, Ashby and HN roles directly every 60 minutes (the ⋯ menu shows the countdown and has **Sync now**). A removed role is struck through in crimson with the reason, and a company with no open roles left turns red.

## Contacts

- **Who:** HR / talent acquisition / recruiting, founders and co-founders, CTOs, VPs, directors and heads of teams. Partnerships / business development contacts are removed, and so are CEOs, COOs and CFOs who aren't founders (YC-listed founders count as founders). Company mailboxes: hiring / HR ones only (careers@, jobs@, hr@, talent@…). Rules: `scripts/people.mjs`.
- **Company LinkedIn:** every company is looked up in Prospeo (1 credit, `contacts.prospeoCompanyDailyCredits`) and its LinkedIn page is used only when Prospeo's record has the same website as ours, or (for companies known only by name) the same name plus one of our open internships or a headquarters in one of the five countries. Otherwise: YC's profile, then the link on the company's own website. Links are stored as `https://www.linkedin.com/company/<slug>`; the site also links that company's LinkedIn jobs and its HR / recruiters.
- **Emails are validated before they are shown:** the domain must have a mail server (MX record), and the address must be verified by Prospeo, listed on the company's own site, or confirmed "valid" by [ZeroBounce](https://www.zerobounce.net) (set the `ZEROBOUNCE_API_KEY` repository secret to turn it on; `contacts.zerobounceDailyCredits`). ZeroBounce "invalid", "spamtrap", "abuse" or "do_not_mail" removes an address for good. Unconfirmed addresses are held back, not published.

## Sources

Y Combinator (company pages: jobs and founders), HN "Who is hiring?", 60+ startup job boards on Greenhouse / Lever / Ashby (`config.json → ats.boards`, plus boards found in HN posts), [Jobicy](https://jobicy.com) (remote jobs by region) and [Arbeitnow](https://www.arbeitnow.com) (EU remote jobs) and [Himalayas](https://himalayas.app) (remote-only board: every internship search for the five countries plus worldwide).

**Deeper search** (`scripts/discover.mjs`, every run): Prospeo's company search lists companies in the five countries that are hiring interns (software, IT, internet, security, fintech; up to 1,000 people; about 30 credits a week, `config.json → discovery`). For each one the script finds its job board, either linked from its own website or a board on Greenhouse, Lever, Ashby, Workable, Recruitee or SmartRecruiters whose company name matches (a board is never attributed to a company without that check). Those boards are then read like every other source, and only 100% remote tech internships are kept. Boards that have never had a remote internship are re-read every 6 hours.

**Others** (one group in the Source filter), read through each site's official feed and credited on every role:
- [Remotive](https://remotive.com): API, at most 4 checks a day as Remotive asks
- [Remote OK](https://remoteok.com): API
- [Working Nomads](https://www.workingnomads.com): API
- [We Work Remotely](https://weworkremotely.com): RSS for the programming, full-stack, back-end, front-end and DevOps categories. Its "Headquarters" field is also used to drop US-based companies.
- [NoDesk](https://nodesk.co): RSS
- [Jobfound](https://jobfound.org): structured job pages from its remote listings, US and India listings skipped

Remote.co refuses automated connections, so it isn't included.

**LinkedIn** isn't scraped: its terms forbid automated collection and it blocks scrapers. Instead, the **Search on LinkedIn Jobs** button opens LinkedIn's own job search using the current filters (remote only, the selected country or region, track or search text, posted in the last 7 days). Every role and company also has LinkedIn links.

**Using the site:** **Jobs** lists one row per startup (country, tracks, open roles, contacts, newest posting, and a **New** badge for anything added since your last visit). Click a row to open its panel: **Roles** (Apply ↗ / LinkedIn ↗), **People** (C-Suite, then Talent & HR, then Partnerships) and **Outreach** (editable pitch, Copy text, Open in mail app). **Outreach** is a board of every contact by status (Not contacted / Contacted / Replied), or a table with each company once; statuses are saved in your browser. **What changed** is the hourly log of added and closed roles. Search, filters, tab and the open panel are all in the URL, so any view can be shared as a link. On phones, filters open as a bottom sheet.

**Country filter:** picking a country shows only roles that name that country. Region-wide and worldwide remote roles appear under the region, not under a country. Regions and their countries are in one **Region** control, with counts.

**RTI tracker** (`/rti/`): the ⋯ menu's **RTI tracker** link opens your team's RTI Tracker screen, running on this site's live data. It shows every hiring company and its open remote tech roles as "Job posting" signals, with region tabs for Australia, Europe, MEA, New Zealand, SEA, UK and Global remote. Status, notes, India-office changes and CSV/Excel imports are saved in each person's browser, and Download Excel works. The original tracker, with its shared team data, news and freelance projects, lives in a claude.ai shared store that only works on claude.ai, so it's linked from the page rather than copied. `rti/adapter.js` connects the tracker to `data/leads.json`. Its other features:
- **Open to India** lists roles whose posting names India as eligible.
- **Contacts:** each company's drawer shows its C-Suite and other contacts (email, phone, LinkedIn), and links to the company's card on the main site.
- **Download Excel** includes open roles and all contacts.
- **Sources** shows each source's latest read and how many of its roles are on the site.

## Contacts

People come from YC founder lists, HN posters, and Prospeo (talent, partnerships and C-Suite people with verified emails). Company emails, HQ phone numbers and social profiles come from a scan of each company's own website. **No contact detail is ever guessed.** Where a person's direct phone isn't known, the card shows the company's HQ line, labelled "HQ line". Where no one is on record, it shows one-click LinkedIn searches for the CEO, CTO and founders.

Prospeo lookups for new companies need the repo secret `PROSPEO_API_KEY`. Every hourly run:
- searches each new company's people, by website or, for companies from job feeds, by company name;
- reveals verified emails, capped at 250 credits a day (`contacts.prospeoDailyCredits`);
- buys **verified mobiles** for the top CEO/CTO/founders (up to 2 per company, newest companies first), capped at **100 credits a day** (`contacts.prospeoMobileDailyCredits`). Prospeo charges 10 credits only when it finds a number. A number is only attached if Prospeo still places the person at that company. Anyone without a number is retried after 90 days.

Companies whose Prospeo record puts the headquarters in the US are excluded automatically.

## Schedule

`.github/workflows/hourly_sync.yml` runs every hour (`0 * * * *`, with backup runs at :23 and :47 because GitHub often delays or skips on-the-hour schedules):

1. `node scripts/update.mjs`: at 01:00 UTC it discovers new YC startups; every hour it re-reads every source, verifies every role, and applies the rules above.
2. `node scripts/contacts.mjs`: website contact scan, plus Prospeo if configured.
3. `python3 tests/test_site_integrity.py`: if any rule is broken, nothing is committed or deployed.
4. It commits `data/` and deploys to GitHub Pages.

**Always running:** GitHub often skips scheduled runs, so `.github/workflows/ticker.yml` starts the hourly sync itself every hour. Each ticker run lasts about 6 hours and then starts the next one. Its own schedule only restarts it if it ever stops. The main site and the RTI tracker check for new data every minute.

To force a run, open **Actions → Hourly sync → Run workflow** (needs write access).

## Run locally

```bash
node scripts/update.mjs --mode=verify
node scripts/contacts.mjs
python3 tests/test_site_integrity.py
python3 -m http.server 8000
```

Then open http://localhost:8000.
