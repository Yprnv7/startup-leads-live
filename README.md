# Startup Leads Live

Live dashboard of tech startup **jobs, internships and founder / POC contacts** for outreach.
It updates itself — nobody has to run anything.

**Site:** https://yprnv7.github.io/startup-leads-live/

## Focus markets

The site is built around **Middle East & Africa, Southeast Asia, Germany, the UK and Australia / NZ**.

- It opens on **★ Focus markets** with **Hide USA** on. Pick a single market from the dropdown or the *Markets* card, or choose *All markets*.
- **Hide USA** removes US-only companies and also US-only roles inside global companies (for example a London company's San Francisco roles). Untick it to see everything.
- Daily discovery checks focus-market YC startups first and skips US-only ones. The job boards cover 80+ startups across London, Berlin/Munich, Singapore/Jakarta, Dubai/Riyadh/Cairo/Lagos and Sydney/Melbourne (`config.json` → `ats.boards`). Focus-market roles are kept first when a board has more roles than the per-company cap.
- Every company and role is tagged with its markets (`scripts/markets.mjs`).
- **Tech roles only** (on by default) keeps software, data, AI/ML, DevOps/cloud, security, QA, embedded and IT roles. It drops sales, marketing, HR, ops, product/project management, design and non-software engineering. Each role is classified by `isTechRole` in `scripts/update.mjs`.
- **Sources → LinkedIn** shows companies with a LinkedIn page, contacts with LinkedIn profiles, or roles that link to a LinkedIn job post. LinkedIn has no public jobs API and its terms forbid automated scraping, so LinkedIn job listings aren't pulled automatically. Instead every company has a **LinkedIn jobs ↗** button that opens LinkedIn's own job search for it.

## How it stays up to date

| What | When | How |
|---|---|---|
| New companies added | Every day, 07:00 IST | YC companies that are hiring (focus markets first, US-only skipped), every new post in the monthly HN "Who is hiring?" thread, and company job boards (Greenhouse / Lever / Ashby) found in those posts |
| New HN posts picked up | Every 2 hours | Same HN thread, re-read |
| Every tracked job re-verified | Every 2 hours (YC pages every 6 h) | Job still on the company's board? HN post still up and not "filled"? |
| Live check in your browser | On page load + every 10 min | Greenhouse / Lever / Ashby / HN are checked directly from the page, so a closed role turns red without waiting for the server |
| Page refresh | Every 2 min | The open page reloads the dataset quietly and pops a toast for new or closed companies |

**Red = no longer hiring.** A company turns red the moment none of its tracked roles are still open; individual closed roles are struck through in red with the reason (removed from job board, HN post deleted, post says filled, link 404s). Jobs are only marked closed on positive evidence; a network error never closes anything.

## Points of contact

Every company gets every reachable contact, grouped by team:

- **People:** Talent acquisition / recruiters / HR, partnerships / alliances / business development, founders and leadership. Each has a name, title, location, LinkedIn and verified work email where available. HN posters are included with their HN profile and the email from their post. People come from YC, HN and Prospeo.
- **Company channels:** careers@ / hr@ / partnerships@ / hello@ / press@ emails, phone numbers, LinkedIn / X / Instagram / GitHub / YouTube / Crunchbase profiles, and the contact, careers, partner and team pages. These come from a scan of the company's own website, which re-runs every 30 days.
- **One-click LinkedIn searches** for talent acquisition, recruiters, HR, partnerships, BD and founders at that company.

Prospeo lookups need the repo secret `PROSPEO_API_KEY` and are capped at `contacts.prospeoDailyCredits` (250) credits a day. Talent and partnerships people get their emails revealed first. Without the key, everything else still runs.

## Using it

- Filter by jobs / internships, region (India, Remote, US, Europe), source, "added today", "has founder POC".
- Click a company to see every role, founders (LinkedIn / X / email / HN), website, YC profile and careers page.
- **Contacted** ticks are saved in your own browser only.
- **⬇ CSV** exports exactly what you're looking at (for sheets / CRMs).
- **⚙ Updater** → *Run workflow* forces an update now (needs write access to the repo).

## Adding your own leads

Add companies to `data/manual.json`. Their job links are checked every run: a 404/410 or a page that says the job is closed turns them red.

```json
[
  {
    "name": "Acme AI",
    "website": "https://acme.ai",
    "location": "Bengaluru, India",
    "oneLiner": "AI copilots for logistics",
    "contacts": [{ "name": "Priya Sharma", "title": "Co-founder & CEO", "linkedin": "https://www.linkedin.com/in/...", "email": "priya@acme.ai" }],
    "jobs": [{ "title": "SDE Intern", "type": "internship", "url": "https://jobs.lever.co/acme/..." }]
  }
]
```

## Tuning

`config.json`: companies added per day (`yc.newCompaniesPerDay`), region priority, seed job boards, which role titles count as tech roles.

## Run locally

```bash
node scripts/update.mjs --mode=discover   # Node 20+, no dependencies
python3 -m http.server 8000               # then open http://localhost:8000
```
