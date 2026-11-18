# Startup Leads Live — Interview Defense Guide

## 1. The 30-Second Elevator Pitch
"I built **Startup Leads Live** to solve a real problem I faced firsthand: the signal-to-noise crisis in tech job hunting. Most job boards are cluttered with stale postings, third-party recruiter spam, and generic `careers@` black holes.

Startup Leads Live is an automated labor market intelligence pipeline running on hourly serverless schedules that polls primary Applicant Tracking Systems (Ashby, Greenhouse, Lever), checks whether vacancies are active every 60 minutes, verifies decision-maker business contacts through domain DNS MX checks and SMTP handshakes, and invalidates closed roles in real time. 

It currently monitors **250 verified startups**, tracks **607 live engineering roles**, and is built strictly within **GDPR Article 6(1)(f)** and **India DPDP Act 2023** frameworks with zero personal mobile scraping."

---

## 2. Core Architecture & Pipeline Stages

### Stage 1: Discovery
- **Primary ATS Adapters:** Directly polls Greenhouse, Lever, and Ashby public board APIs and JSON endpoints.
- **Directories:** Hacker News "Who is hiring?" threads and Y Combinator public startup directories.
- **Why not scrape LinkedIn directly?**
  - LinkedIn strictly forbids automated collection in its Terms of Service, rate-limits aggressive scrapers, and introduces severe legal and IP-blocking risks. Querying first-party ATS APIs directly is more reliable, respectful of platform terms, and yields structured JSON with accurate remote flags (`workplaceType: Remote`).

### Stage 2: Deduplication & Quality Filtering
- Deduplication by normalized role title and company domain hash drops ~34% of redundant syndicated postings across aggregators.
- Strict filters defined in `docs/RULES.md`:
  - 100% remote verification (dropping hybrid / mandatory office roles).
  - Pure technical tracks (Software, AI/ML, Data, DevOps, Security).
  - Target countries (UK, Germany, Australia, Singapore, UAE), excluding US-only jobs.

### Stage 3: Enrichment & Verification
- Identifies key hiring managers: Founders, CTOs, and Heads of Talent Acquisition.
- Validates corporate email addresses through DNS MX record resolution and ZeroBounce / Prospeo SMTP handshake verification.
- **Deprecating Personal Mobile Numbers:** To prevent anti-spam violations and maintain professional standards, direct personal mobile scraping is disabled (`prospeoMobileDailyCredits: 0`). Only public corporate switchboards (HQ lines) listed on public company domains are retained.

### Stage 4: Continuous Re-Verification & Delivery
- Vacancy URLs are re-checked hourly. If an employer removes a role or the ATS returns 404, the role is struck through in crimson in the UI, preventing wasted outreach.
- Data is published as static versioned JSON (`data/internships.json`, `data/leads.json`) rendered via a lightweight vanilla JavaScript single-page application hosted on GitHub Pages.

---

## 3. Legal & Privacy Compliance (GDPR & DPDP Act 2023)

### A. GDPR Article 6(1)(f) — Legitimate Interests
- Processing is restricted to professional individuals acting in their corporate capacity (Founders, CTOs, Talent Leads) who reasonably anticipate professional employment inquiries regarding active public vacancies published by their employers.

### B. India DPDP Act 2023
- Complies with data minimization obligations by restricting data to publicly available corporate disclosures made voluntarily on public job boards.

### C. Right to Erasure (Article 17)
- Detailed in `PRIVACY.md`. Any individual or organization can submit a removal request via GitHub issue or email; requests are processed within 24 hours, and requested identifiers are permanently added to blocklists in `config.json`.

---

## 4. Tough Interview Questions & Precise Answers

### Q1: "How do you distinguish this from a spam scraper?"
**Answer:** "Three core engineering and governance choices:
1. **Source Integrity:** We do not scrape personal LinkedIn accounts or gated profiles. We ingest public corporate ATS feeds directly from the companies' own career platforms.
2. **Data Minimization:** We permanently deprecated personal mobile number collection. We only display verified business emails and corporate switchboard lines.
3. **Data Freshness & Transparency:** Unlike spam scrapers that hoard stale databases, every listing is re-verified hourly, closed roles are visibly struck through, and a clear `PRIVACY.md` provides guaranteed 24-hour opt-out deletion."

### Q2: "How would you scale the data layer if the company count grew from 250 to 50,000?"
**Answer:** "Currently, the frontend downloads a pre-compiled JSON file (~760 KB) for instant client-side filtering. At 50,000 companies and hundreds of thousands of roles:
1. **Database:** Migrate storage from flat JSON files to PostgreSQL with pgvector and full-text search (or Meilisearch).
2. **API Layer:** Serve search queries through a FastAPI or Node.js serverless API with cursor-based pagination and Redis edge caching.
3. **Distributed Crawling:** Decouple ATS discovery into an asynchronous Celery or BullMQ worker queue distributed across serverless worker lambdas."

### Q3: "What prevents false positives in email validation?"
**Answer:** "Email validation uses a layered two-step approach: first, DNS resolution confirms that the recipient domain has active MX records; second, API integration with ZeroBounce performs an SMTP handshake to verify mailbox existence without sending a mail. Any address classified as `invalid`, `spamtrap`, or `abuse` is permanently dropped."
