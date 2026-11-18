# Privacy & Data Governance Policy

**Last Updated:** November 2026  
**Governing Frameworks:**  
- **European Union:** General Data Protection Regulation (GDPR - Regulation (EU) 2016/679), specifically Article 6(1)(f) (Legitimate Interests).
- **India:** Digital Personal Data Protection Act, 2023 (DPDP Act 2023), specifically Section 4 (Grounds for Processing) and Section 8 (General Obligations of Data Fiduciary).

---

## 1. Scope & Objective

**Startup Leads Live** is an automated talent discovery and labor market research pipeline designed to surface legitimate, remote employment and internship opportunities. The platform connects tech professionals directly with hiring companies.

To maintain compliance and protect individual privacy, **Startup Leads Live adheres to strict minimization standards**:
- We collect **business contact information only** (e.g., publicly listed organizational roles, professional business emails, public LinkedIn profile URLs).
- We **do not** collect sensitive personal data, personal home addresses, government identification numbers, or non-business personal communications.
- **Personal mobile numbers are explicitly deprecated and excluded from default discovery.** Phone numbers, where displayed, represent public corporate switchboards (HQ lines) listed on public company domains.

---

## 2. Lawful Basis for Processing

### A. GDPR Article 6(1)(f) — Legitimate Interests (EU / UK / International)
Processing of professional contact data is conducted under **Article 6(1)(f) of the GDPR**, based on the legitimate interest of:
1. Facilitating direct professional employment outreach between qualified candidates and actively hiring organizations.
2. Market transparency for remote tech talent across Ireland, the UK, Germany, and Europe.
3. Necessity and Proportionality: Processing is restricted to professional individuals acting in their corporate capacity (e.g., Founders, CTOs, Heads of Talent Acquisition) who reasonably expect inquiries regarding active employment postings published by their organizations.

### B. India DPDP Act 2023 — Specified Purpose & Public Disclosures
Under the **Digital Personal Data Protection Act, 2023**:
1. Information processed comprises publicly available corporate disclosures made voluntarily by data principals or their authorized employers on public job boards, company careers portals, and public business registers.
2. Data is processed solely for the specified purpose of recruitment matching and professional networking.

---

## 3. Data Provenance & Sources

Data is ingested exclusively from public, accessible endpoints:
1. **Official Applicant Tracking Systems (ATS):** Public job boards hosted directly on Greenhouse, Lever, Ashby, Workable, and SmartRecruiters.
2. **Public Startup Directories:** Y Combinator public startup directories, Hacker News "Who is hiring?" public threads, and official company websites.
3. **Professional Verification APIs:** Domain MX record validation and zero-bounce business mailbox verification (e.g., ZeroBounce, Prospeo) to prevent delivery to closed or invalid addresses.
4. **No Unauthorized Scraping:** The platform does not bypass access barriers, CAPTCHAs, or authentication walls.

---

## 4. Data Storage & Retention

- **Storage Location:** Flat-file structured JSON documents (`data/internships.json`, `data/leads.json`) committed to version-controlled GitHub repositories.
- **Retention Schedule:**
  - Active job postings are re-verified every 60 minutes.
  - Closed job postings are flagged immediately and removed from active search indices.
  - Inactive business contact references are pruned if associated job vacancies have closed or during scheduled monthly state cleanups.

---

## 5. Right to Erasure, Opt-Out & Contact Removal Process (GDPR Art. 17 / DPDP Sec. 12)

Any individual, founder, or corporate entity has the absolute right to request immediate removal of their business contact details or job listings from our repository and published website.

### How to Request Removal:
1. **GitHub Issue:** Open an issue on this repository with the label `data-removal`.
2. **Direct Email:** Send an email to `yeleswarapupranav@gmail.com` with the subject line:  
   `[Data Removal Request] <Your Name / Company Name>`.

### Remediation Guarantee:
- Requests are processed within **24 hours**.
- The requested domain, email address, or person identifier is permanently added to `config.json -> excludeCompanies` or `excludeContacts` blocklists, ensuring subsequent hourly sync runs never re-ingest or republish the information.
