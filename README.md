# Startup Leads Live

**100% remote, pure-tech jobs and internships at startups in Australia, Europe, MEA, New Zealand, SEA and the UK, with founder and C-Suite contacts.** It updates itself every hour.

**Site:** https://yprnv7.github.io/startup-leads-live/

## What's on the site (enforced in the data, checked by tests every hour)

- **100% remote only.** A role must be remote by its job board's own flag (Ashby `workplaceType: Remote`, Lever `workplaceType: remote`) or by its stated location. Anything hybrid, in-office, "X days in office" or requiring relocation is dropped.
- **Pure tech only.** Software (backend, frontend, full-stack, systems), AI/ML/LLM, data and quant, DevOps/SRE/cloud/platform, security, mobile, robotics/embedded, and tech internships. Sales, GTM, marketing, recruiting, HR, legal, compliance, ops, PM, design, support and non-software engineering are dropped.
- **Six regions, no USA.** Each role must be workable from Australia, Europe, MEA, New Zealand, SEA or the UK. US-only roles are dropped. Companies are excluded if they are **headquartered in the US** (from the company's location, YC data, or Wikidata), **hire in the US** (job-feed companies with no known HQ), or are on the `excludeCompanies` list in `config.json`.
- **No India offices.** A company is excluded if its location, YC regions or any of its job locations name an Indian city.
- **Countries A → Z** everywhere, using `localeCompare('en')`.
- **Closed roles turn red.** The server re-checks every role hourly. Open pages also re-check Greenhouse, Lever, Ashby and HN roles directly every 60 minutes (countdown in the header, plus a **Sync now** button). A removed role is struck through in crimson with the reason, and a company with no open roles left turns red.

## Sources

Y Combinator (company pages: jobs and founders), HN "Who is hiring?", 60+ startup job boards on Greenhouse / Lever / Ashby (`config.json → ats.boards`, plus boards found in HN posts), [Jobicy](https://jobicy.com) (remote jobs by region) and [Arbeitnow](https://www.arbeitnow.com) (EU remote jobs).

**Others** (one group in the Source filter), read through each site's official feed and credited on every role:
- [Remotive](https://remotive.com): API, at most 4 checks a day as Remotive asks
- [Remote OK](https://remoteok.com): API
- [Working Nomads](https://www.workingnomads.com): API
- [We Work Remotely](https://weworkremotely.com): RSS for the programming, full-stack, back-end, front-end and DevOps categories. Its "Headquarters" field is also used to drop US-based companies.
- [NoDesk](https://nodesk.co): RSS
- [Jobfound](https://jobfound.org): structured job pages from its remote listings, US and India listings skipped

Remote.co refuses automated connections, so it isn't included.

**LinkedIn** isn't scraped: its terms forbid automated collection and it blocks scrapers. Instead, the **Search on LinkedIn Jobs** button opens LinkedIn's own job search using the current filters (remote only, the selected country or region, track or search text, posted in the last 7 days). Every role and company also has LinkedIn links.

**Country filter:** picking a country shows only roles that name that country. Region-wide and worldwide remote roles appear under the region buttons, not under a country.

**RTI tracker:** the header button opens the RTI tracker.

## Contacts

People come from YC founder lists, HN posters, and Prospeo (talent, partnerships and C-Suite people with verified emails). Company emails, HQ phone numbers and social profiles come from a scan of each company's own website. **No contact detail is ever guessed.** Where a person's direct phone isn't known, the card shows the company's HQ line, labelled "HQ line". Where no one is on record, it shows one-click LinkedIn searches for the CEO, CTO and founders.

Prospeo lookups for new companies need the repo secret `PROSPEO_API_KEY`. Every hourly run:
- searches each new company's people, by website or, for companies from job feeds, by company name;
- reveals verified emails, capped at 250 credits a day (`contacts.prospeoDailyCredits`);
- buys **verified mobiles** for the top CEO/CTO/founders (up to 2 per company, newest companies first), capped at **100 credits a day** (`contacts.prospeoMobileDailyCredits`). Prospeo charges 10 credits only when it finds a number. A number is only attached if Prospeo still places the person at that company. Anyone without a number is retried after 90 days.

Companies whose Prospeo record puts the headquarters in the US are excluded automatically.

## Schedule

`.github/workflows/hourly_sync.yml` runs every hour (`0 * * * *`):

1. `node scripts/update.mjs`: at 01:00 UTC it discovers new YC startups; every hour it re-reads every source, verifies every role, and applies the rules above.
2. `node scripts/contacts.mjs`: website contact scan, plus Prospeo if configured.
3. `python3 tests/test_site_integrity.py`: if any rule is broken, nothing is committed or deployed.
4. It commits `data/` and deploys to GitHub Pages.

To force a run, open **Actions → Hourly sync → Run workflow** (needs write access).

## Run locally

```bash
node scripts/update.mjs --mode=verify
node scripts/contacts.mjs
python3 tests/test_site_integrity.py
python3 -m http.server 8000
```

Then open http://localhost:8000.
