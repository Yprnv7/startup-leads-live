# Ingestion & Filtering Rules Reference

This document details the rule set executed during the hourly discovery and verification pipeline in `scripts/update.mjs` and `scripts/contacts.mjs`.

---

## 1. Role Scope & Eligibility Filters

To prevent clutter and focus on genuine tech talent matching:
- **Internships & Early-Career Tech Only:** Titles must match recognized internship patterns (e.g., `intern`, `internship`, `co-op`, `Praktikum`) or be designated as an internship in the ATS taxonomy.
- **100% Remote Verification:** Roles must explicitly carry the ATS remote flag (e.g., Ashby `workplaceType: Remote`, Lever `workplaceType: remote`, Greenhouse remote workplace) or state remote status in the title/location string.
- **Tech Track Focus:** Exclusively covers:
  - Software Engineering (Backend, Frontend, Full-Stack, Systems)
  - Artificial Intelligence, Machine Learning & LLM Engineering
  - Data Engineering, Analytics & Quantitative Modeling
  - DevOps, Platform, Cloud & SRE
  - Information Security & Cryptography
  - Mobile Engineering (iOS, Android)
  - Embedded Systems & Robotics
  *Non-engineering roles (Sales, Marketing, HR, Legal, Product Management, Ops, Design) are automatically filtered out.*

---

## 2. Geographic & Headquarters Boundaries

- **Target Jurisdictions:** United Kingdom, Germany, Australia, Singapore, and the United Arab Emirates.
- **Excluded Headquarters:**
  - Companies headquartered in the United States or whose job feeds lack verifiable non-US incorporation are excluded.
  - Multi-office corporations maintaining active branch offices in high-volume offshore IT service hubs are filtered to prioritize core European and international product startups.

---

## 3. Contact Ingestion & Data Hygiene Rules

- **Allowed Corporate Roles:**
  - Founders & Co-Founders (including YC-verified founder alumni)
  - Chief Technology Officers (CTO) & Heads of Engineering
  - Talent Acquisition, HR Leads & Technical Recruiting Partners
  - Engineering VPs and Directors
- **Excluded Roles:**
  - Executive leadership without engineering/hiring responsibilities (e.g. non-founder COOs, CFOs, CMOs)
  - Business Development and Commercial Partnerships
- **Mailbox & Email Validation:**
  - The domain must possess active DNS MX records.
  - Email addresses are validated through ZeroBounce / Prospeo SMTP handshakes. Addresses returning `invalid`, `spamtrap`, or `abuse` are permanently dropped.
  - Personal mobile numbers are disabled by default (`prospeoMobileDailyCredits: 0`). Only public corporate switchboards (HQ lines) listed on verified websites are retained.

---

## 4. Re-Verification & Role Expiration

- **Hourly Reconciliation:** Every active vacancy URL is probed hourly via HTTP status checks and ATS endpoint parsing.
- **Visual Strikethrough & Deprecation:** Roles removed by the employer or closed on the ATS turn red and are struck through in the web UI, preventing wasted outreach on filled positions.
