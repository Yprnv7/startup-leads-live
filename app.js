    // Startup Leads — 100% remote, pure-tech roles in Australia, Europe, MEA, New Zealand, SEA and the UK.
    // Data comes from data/leads.json, rebuilt every hour by .github/workflows/hourly_sync.yml.
    // The page re-checks open roles against the live job boards every 60 minutes.

    const DATA_URL = "data/leads.json";
    const VERSION_URL = "data/version.json";
    const HOURLY_CRON = "0 * * * *";
    const REGIONS = ["Australia", "Europe", "MEA", "New Zealand", "SEA", "UK"];
    const REGION_SHORT = { Australia: "AU", Europe: "EU", MEA: "MEA", "New Zealand": "NZ", SEA: "SEA", UK: "UK" };
    // Region-wide remote tokens and the regions they cover (mirrors scripts/markets.mjs).
    const WIDE = {
      Worldwide: REGIONS,
      "Europe-wide": ["Europe", "UK"],
      EMEA: ["Europe", "MEA", "UK"],
      "APAC-wide": ["Australia", "New Zealand", "SEA"],
      "MENA-wide": ["MEA"],
      "Africa-wide": ["MEA"],
    };
    const CSUITE_RE = /\b(ceo|cto|cpo|coo|cfo|chief|co-?founder|founder|president|vp,? (?:of )?engineering|vice president,? engineering|head of (?:engineering|ai|technology|machine learning|data|platform))\b/i;
    const TALENT_RE = /recruit|talent|human resources|\bhr\b|people/i;
    const PARTNER_RE = /partner(?:ship)?s?\b|alliance|business development/i;
    const STACK = ["Python", "TypeScript", "JavaScript", "Go", "Golang", "Rust", "Java", "Kotlin", "Swift", "Scala", "C++", "C#", "Ruby", "Elixir", "PHP", "Node.js", "React", "React Native", "Flutter", "Next.js", "Vue", "Django", "Rails", "PyTorch", "TensorFlow", "LLM", "Kubernetes", "AWS", "GCP", "Azure", "Terraform", "Postgres", "Kafka", "Spark", "dbt", "Snowflake", "Linux", "iOS", "Android", "Solidity", "Web3", "ROS", "CUDA"];
    const SOURCE_LABEL = { yc: "Y Combinator", hn: "HN Who's Hiring", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", jobicy: "Jobicy", arbeitnow: "Arbeitnow", manual: "Manual",
      remotive: "Remotive", remoteok: "Remote OK", workingnomads: "Working Nomads", weworkremotely: "We Work Remotely", nodesk: "NoDesk", jobfound: "Jobfound" };
    const OTHERS = ["remotive", "remoteok", "workingnomads", "weworkremotely", "nodesk", "jobfound"];
    // LinkedIn Jobs search terms per engineering track, and LinkedIn location names per region.
    const TRACK_KEYWORDS = { "AI / ML & LLM Systems": "machine learning engineer", "Backend & Distributed Systems": "backend engineer", "Data & Quant Engineering": "data engineer",
      "DevOps, Cloud & SRE": "devops engineer", "Full-Stack & Product Engineering": "full stack engineer", "Mobile & Autonomous Systems": "mobile engineer" };
    const REGION_LINKEDIN = { Australia: "Australia", Europe: "European Union", MEA: "Middle East", "New Zealand": "New Zealand", SEA: "Southeast Asia", UK: "United Kingdom" };

    let raw = null;               // data/leads.json
    let leads = [];               // adapted companies
    let lastVersion = null;
    let lastLiveCheck = null;
    let liveChecking = false;
    const liveClosed = new Map(); // role id -> reason, found by in-browser checks since the last dataset
    let countdownSeconds = 3600;  // next in-browser hourly verification
    let shown = 30;
    let activeRoleTab = "ALL", activeRegion = "ALL", activeCountry = "ALL", activeDiscipline = "ALL";
    let activeCSuiteFilter = "ALL", activeSource = "ALL", activeSort = "COUNTRY_AZ", searchQuery = "", viewMode = "CARDS";
    let contactStatusMap = {};
    const localEvents = [];

    const $ = id => document.getElementById(id);
    function escapeHtml(s) {
      return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function ago(iso) {
      if (!iso) return "—";
      const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.floor(s / 60)} min ago`;
      if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
      const d = Math.floor(s / 86400);
      return d === 1 ? "yesterday" : `${d} days ago`;
    }
    const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    const regionOfCountry = c => raw?.meta?.regionOf?.[c];

    function showToast(msg) {
      const el = $("toastBanner");
      $("toastText").textContent = msg;
      el.classList.remove("hidden");
      clearTimeout(window._toastTimeout);
      window._toastTimeout = setTimeout(() => el.classList.add("hidden"), 2800);
    }
    function copyToClipboard(text, label) {
      const done = () => showToast("Copied " + (label || text));
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    }
    function fallbackCopy(text, done) {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      ta.remove();
    }
    function loadStatus() {
      try { contactStatusMap = JSON.parse(localStorage.getItem("startup_leads_contact_status_v6") || "{}"); } catch (e) { contactStatusMap = {}; }
    }
    function saveStatus() {
      try { localStorage.setItem("startup_leads_contact_status_v6", JSON.stringify(contactStatusMap)); } catch (e) {}
    }

    // ------------------------------------------------------------------ data → view model
    function contactTier(p) {
      const t = p.title || "";
      if (CSUITE_RE.test(t)) return "C-Suite";
      if (p.source === "HN" || TALENT_RE.test(t)) return "Talent & HR";
      if (PARTNER_RE.test(t)) return "Partnerships";
      return "Leadership";
    }
    const TIER_ORDER = { "C-Suite": 0, "Talent & HR": 1, Partnerships: 2, Leadership: 3 };
    const contactKey = (companyId, p) => companyId + "::" + (p.linkedin || p.email || p.name || "").toLowerCase();
    const linkedInSearch = (company, role) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${role} ${company}`)}`;

    function adapt(c) {
      const roles = c.jobs.map(j => {
        const closedLive = liveClosed.has(j.id) && j.status === "open";
        return {
          id: j.id, title: j.title, src: j.src, via: j.via,
          category: j.type === "internship" ? "Remote Internship" : "Remote Job",
          remoteScope: j.remoteScope || "100% Remote",
          track: j.track || "Backend & Distributed Systems",
          places: j.places || [], regions: j.regions || [],
          url: j.url, applyUrl: j.applyUrl && j.applyUrl !== j.url ? j.applyUrl : null,
          salary: j.salary, postedAt: j.postedAt, firstSeen: j.firstSeen,
          status: closedLive ? "closed" : j.status,
          closedAt: closedLive ? new Date().toISOString() : j.closedAt,
          closedReason: closedLive ? liveClosed.get(j.id) + " (detected live)" : j.closedReason,
        };
      });
      const open = roles.filter(r => r.status === "open");
      const hqPhone = c.channels?.phones?.[0]?.phone || null;
      const contacts = (c.contacts || []).map(p => ({ ...p, tier: contactTier(p) }))
        .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (b.email ? 1 : 0) - (a.email ? 1 : 0));
      const text = roles.map(r => r.title).join(" ") + " " + (c.oneLiner || "") + " " + (c.tags || []).join(" ");
      const techStack = STACK.filter(t => new RegExp(`(^|[^\\w])${t.replace(/[.+#]/g, m => "\\" + m)}([^\\w]|$)`, "i").test(text)).slice(0, 8);
      const scopes = new Set(open.flatMap(r => r.places));
      const remoteScope = scopes.has("Worldwide") ? "100% Remote (Global)"
        : `100% Remote (${REGIONS.filter(r => open.some(x => x.regions.includes(r))).map(r => REGION_SHORT[r]).join("/") || "—"})`;
      return {
        id: c.id, company: c.name, country: c.country || null, region: c.region || null,
        website: c.website, logo: c.logo, oneLiner: c.oneLiner || "", batch: c.batch ? `YC ${shortBatch(c.batch)}` : "",
        source: c.source, sources: c.sources || [c.source], firstSeen: c.firstSeen,
        status: open.length ? "open" : "closed", closedAt: c.closedAt,
        roles, openCount: open.length, remoteScope, techStack,
        contacts, hqPhone, companyEmails: c.channels?.emails || [], social: c.channels?.social || {}, pages: c.channels?.pages || {},
        linkedinPage: c.linkedin || c.channels?.social?.linkedin || null,
        boardUrl: c.careersUrl || c.profileUrl || c.website || roles[0]?.url,
        profileUrl: c.profileUrl,
      };
    }
    function shortBatch(b) { const m = /(Winter|Spring|Summer|Fall)\s+20(\d\d)/.exec(b || ""); return m ? m[1][0] + m[2] : b; }

    // ------------------------------------------------------------------ filtering
    function roleCovers(role, { region, country }) {
      // A country shows only roles that name that country (no region-wide or worldwide roles).
      if (country && country !== "ALL") return role.places.includes(country);
      if (region && region !== "ALL") return role.regions.includes(region);
      return true;
    }
    function roleMatches(role, opts = {}) {
      const tab = opts.tab ?? activeRoleTab;
      if (tab === "JOB" && role.category !== "Remote Job") return false;
      if (tab === "INTERN" && role.category !== "Remote Internship") return false;
      if (!roleCovers(role, { region: activeRegion, country: activeCountry })) return false;
      if (activeDiscipline !== "ALL" && role.track !== activeDiscipline) return false;
      return true;
    }
    function contactMatch(item) {
      const pocs = item.contacts;
      switch (activeCSuiteFilter) {
        case "CSUITE_DIRECT": return pocs.some(p => p.tier === "C-Suite" && p.email && (p.phone || item.hqPhone) && p.linkedin);
        case "HAS_EMAIL": return pocs.some(p => p.email) || item.companyEmails.length > 0;
        case "HAS_PHONE": return pocs.some(p => p.phone) || Boolean(item.hqPhone);
        case "HAS_LINKEDIN": return pocs.some(p => p.linkedin) || Boolean(item.linkedinPage);
        case "UNCONTACTED": return !pocs.some(p => (contactStatusMap[contactKey(item.id, p)] || "Not Contacted") !== "Not Contacted");
        default: return true;
      }
    }
    function sourceMatch(item) {
      if (activeSource === "ALL") return true;
      if (activeSource === "others") return item.sources.some(s => OTHERS.includes(s));
      if (activeSource === "linkedin") return item.roles.some(r => r.via === "linkedin") || Boolean(item.linkedinPage) || item.contacts.some(p => p.linkedin);
      return item.sources.includes(activeSource);
    }
    function searchMatch(item) {
      if (!searchQuery) return true;
      const hay = [item.company, item.country, item.region, item.oneLiner, ...item.techStack,
        ...item.roles.map(r => `${r.title} ${r.track} ${r.remoteScope} ${r.places.join(" ")}`),
        ...item.contacts.map(p => `${p.name} ${p.title} ${p.email || ""} ${p.phone || ""}`)].join(" ").toLowerCase();
      return searchQuery.toLowerCase().split(/\s+/).every(t => hay.includes(t));
    }
    // Companies (with only their matching roles) for the current filters; tab can be overridden for counts.
    function getFilteredLeads(tab) {
      const rows = [];
      for (const item of leads) {
        const roles = item.roles.filter(r => roleMatches(r, { tab }));
        if (!roles.length) continue;
        if (!contactMatch(item) || !sourceMatch(item) || !searchMatch(item)) continue;
        const openRoles = roles.filter(r => r.status === "open");
        rows.push({ ...item, visibleRoles: roles, visibleOpen: openRoles.length, status: openRoles.length ? "open" : "closed" });
      }
      const name = (a, b) => a.company.localeCompare(b.company, "en");
      // Companies without one home country ("Global") go after the A → Z countries.
      const byCountry = (a, b) => (!a.country) - (!b.country) || (a.country || "").localeCompare(b.country || "", "en") || name(a, b);
      const sorters = {
        COUNTRY_AZ: byCountry,
        COMPANY_AZ: name,
        MOST_ROLES: (a, b) => b.visibleOpen - a.visibleOpen || name(a, b),
        NEWEST_HOURLY: (a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)) || name(a, b),
      };
      // Hiring companies first; companies whose roles all closed follow, in red.
      return rows.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || sorters[activeSort](a, b));
    }

    // Countries (A → Z) that have matching roles, optionally limited to a region.
    function getAlphabeticalCountries(region) {
      const set = new Set();
      for (const item of leads) for (const r of item.roles) {
        if (r.status !== "open") continue;
        for (const p of r.places) if (regionOfCountry(p) && (region === "ALL" || regionOfCountry(p) === region)) set.add(p);
      }
      return [...set].sort((a, b) => a.localeCompare(b, "en"));
    }
    const companiesInCountry = c => leads.filter(i => i.roles.some(r => r.status === "open" && roleCovers(r, { country: c }))).length;

    // ------------------------------------------------------------------ rendering
    function populateAlphabeticalCountryDropdown() {
      const countries = getAlphabeticalCountries(activeRegion);
      if (activeCountry !== "ALL" && !countries.includes(activeCountry)) activeCountry = "ALL";
      $("countrySelectAlpha").innerHTML = [`<option value="ALL">All countries (A → Z · ${countries.length})</option>`,
        ...countries.map(c => `<option value="${escapeHtml(c)}" ${activeCountry === c ? "selected" : ""}>${escapeHtml(c)} (${companiesInCountry(c)})</option>`)].join("");
    }

    function renderKpisAndCounts(filtered) {
      const open = filtered.filter(i => i.status === "open");
      let roles = 0, interns = 0, pocs = 0, emails = 0, phones = 0, linkedins = 0;
      const countries = new Set();
      for (const item of open) {
        for (const r of item.visibleRoles) if (r.status === "open") {
          roles++;
          if (r.category === "Remote Internship") interns++;
          r.places.forEach(p => regionOfCountry(p) && countries.add(p));
        }
        const cs = item.contacts.filter(p => p.tier === "C-Suite");
        pocs += cs.length;
        emails += cs.filter(p => p.email).length;
        phones += cs.filter(p => p.phone || item.hqPhone).length;
        linkedins += cs.filter(p => p.linkedin).length;
      }
      $("kpiStartupsCount").textContent = open.length;
      $("kpiTotalRolesCount").textContent = roles;
      $("kpiInternshipsCount").textContent = interns;
      $("kpiPocsCount").textContent = pocs;
      $("kpiPocBreakdown").textContent = `${emails} emails · ${phones} phones · ${linkedins} LinkedIn`;
      $("kpiPocBadge").textContent = pocs ? `${Math.round((linkedins / pocs) * 100)}% on LinkedIn` : "—";
      $("kpiCountriesCount").textContent = countries.size;
      $("activeFilterCountLabel").textContent = open.length;
      $("activeRolesCountLabel").textContent = roles;
      const closed = filtered.length - open.length;
      $("closedCountLabel").textContent = closed ? ` · ${closed} closed (red)` : "";
      const count = tab => getFilteredLeads(tab).reduce((n, i) => n + i.visibleRoles.filter(r => r.status === "open").length, 0);
      $("tabCountAll").textContent = count("ALL");
      $("tabCountJobs").textContent = count("JOB");
      $("tabCountInterns").textContent = count("INTERN");
      const active = activeRoleTab !== "ALL" || activeRegion !== "ALL" || activeCountry !== "ALL" || activeDiscipline !== "ALL" || activeCSuiteFilter !== "ALL" || activeSource !== "ALL" || searchQuery;
      $("resetAllFiltersBtn").classList.toggle("invisible", !active);
    }

    function contactRow(item, p) {
      const key = contactKey(item.id, p);
      const st = contactStatusMap[key] || "Not Contacted";
      const phone = p.phone || item.hqPhone;
      const phoneLabel = p.phone ? "Direct" : "HQ line";
      const links = [
        p.email ? `<button type="button" data-copy-val="${escapeHtml(p.email)}" class="underline decoration-dotted text-[var(--accent-emerald)] font-medium" title="Copy email">${escapeHtml(p.email)}</button>
                   <a href="mailto:${escapeHtml(p.email)}" class="text-[var(--ink-muted)] hover:underline" title="Write email">mail ↗</a>` : `<span class="text-[var(--ink-muted)]">no email on record</span>`,
        phone ? `<button type="button" data-copy-val="${escapeHtml(phone)}" class="underline decoration-dotted" title="Copy ${phoneLabel.toLowerCase()}">${escapeHtml(phone)}</button>
                 <span class="text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">${phoneLabel}</span>` : "",
        p.linkedin ? `<a href="${escapeHtml(p.linkedin)}" target="_blank" rel="noopener noreferrer" class="underline font-medium">LinkedIn ↗</a>`
                   : `<a href="${linkedInSearch(item.company, p.name)}" target="_blank" rel="noopener noreferrer" class="underline text-[var(--ink-muted)]">Find on LinkedIn ↗</a>`,
        p.twitter ? `<a href="${escapeHtml(p.twitter)}" target="_blank" rel="noopener noreferrer" class="underline text-[var(--ink-muted)]">X ↗</a>` : "",
        p.hn ? `<a href="${escapeHtml(p.hn)}" target="_blank" rel="noopener noreferrer" class="underline text-[var(--ink-muted)]">HN ↗</a>` : "",
      ].filter(Boolean).join('<span class="opacity-30">·</span>');
      return `
        <div class="surface-subtle rounded-md p-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs font-mono-tabular">
          <div class="space-y-0.5 min-w-0">
            <div class="font-sans font-semibold text-sm">${escapeHtml(p.name)}
              <span class="text-xs font-mono-tabular font-normal text-[var(--ink-secondary)]">— ${escapeHtml(p.title || "")}</span>
              <span class="ml-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border hairline-border text-[var(--ink-muted)]">${escapeHtml(p.tier)}</span>
            </div>
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] pt-0.5">${links}</div>
          </div>
          <div class="flex items-center gap-2 self-start md:self-center">
            <select data-status-key="${escapeHtml(key)}" class="contact-status-select select-clean rounded px-2 py-1 text-[11px]" aria-label="Contact status">
              ${["Not Contacted", "Contacted", "Replied"].map(o => `<option ${st === o ? "selected" : ""}>${o}</option>`).join("")}
            </select>
          </div>
        </div>`;
    }

    function renderStartupCards(filtered) {
      const container = $("cardsFeedContainer");
      if (!filtered.length) {
        container.innerHTML = `<div class="surface-card rounded-xl p-10 text-center space-y-2">
          <div class="font-serif-editorial text-2xl">No remote tech roles match these filters</div>
          <p class="text-xs text-[var(--ink-secondary)]">Reset the filters to see every 100% remote role across Australia, Europe, MEA, New Zealand, SEA and the UK.</p></div>`;
        $("showMoreBtn").classList.add("hidden");
        return;
      }
      container.innerHTML = filtered.slice(0, shown).map(item => {
        const closed = item.status === "closed";
        const roles = item.visibleRoles;
        const c = item.contacts;
        const csuite = c.filter(p => p.tier === "C-Suite");
        const rest = c.filter(p => p.tier !== "C-Suite");
        const pocs = [...csuite, ...rest].slice(0, 6);
        const channelBits = [
          ...item.companyEmails.slice(0, 3).map(e => `<button type="button" data-copy-val="${escapeHtml(e.email)}" class="underline decoration-dotted">${escapeHtml(e.email)}</button> <span class="text-[var(--ink-muted)]">${escapeHtml(e.team)}</span>`),
          item.hqPhone ? `<button type="button" data-copy-val="${escapeHtml(item.hqPhone)}" class="underline decoration-dotted">${escapeHtml(item.hqPhone)}</button> <span class="text-[var(--ink-muted)]">HQ</span>` : "",
          item.linkedinPage ? `<a href="${escapeHtml(item.linkedinPage)}" target="_blank" rel="noopener noreferrer" class="underline">Company LinkedIn ↗</a>` : "",
          item.website ? `<a href="${escapeHtml(item.website)}" target="_blank" rel="noopener noreferrer" class="underline">Website ↗</a>` : "",
        ].filter(Boolean);
        return `
          <article class="surface-card rounded-xl p-5 space-y-4 transition ${closed ? "is-closed" : "hover:border-[var(--ink-primary)]"}" data-company="${escapeHtml(item.id)}">
            <div class="flex flex-wrap items-start justify-between gap-2 pb-3 border-b hairline-border">
              <div class="space-y-1 min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs font-mono-tabular font-semibold px-2 py-0.5 rounded bg-[var(--ink-primary)] text-[var(--bg-surface)]">${escapeHtml(item.country || "Global")}</span>
                  <span class="text-xs font-mono-tabular px-2 py-0.5 rounded surface-subtle">Region: ${escapeHtml(item.region || "Global")}</span>
                  <span class="text-xs font-mono-tabular px-2 py-0.5 rounded ${closed ? "badge-closed" : "badge-remote"} font-medium">${closed ? "No longer hiring" : escapeHtml(item.remoteScope)}</span>
                  ${item.batch ? `<span class="text-xs font-mono-tabular px-2 py-0.5 rounded surface-subtle">${escapeHtml(item.batch)}</span>` : ""}
                </div>
                <div class="flex flex-wrap items-baseline gap-2.5 pt-1">
                  <h2 class="font-serif-editorial text-2xl sm:text-3xl company-name">${escapeHtml(item.company)}</h2>
                  <span class="text-xs font-mono-tabular text-[var(--ink-muted)]">${escapeHtml(item.sources.map(s => SOURCE_LABEL[s] || s).join(" · "))}</span>
                </div>
              </div>
              <div class="flex items-center gap-2 text-xs font-mono-tabular">
                <span class="text-[var(--ink-muted)]" title="Last server verification">Verified ${escapeHtml(ago(raw.meta.lastVerifyAt))}</span>
                ${item.boardUrl ? `<a href="${escapeHtml(item.boardUrl)}" target="_blank" rel="noopener noreferrer" class="pill-btn px-2.5 py-1 rounded font-medium">Job board ↗</a>` : ""}
              </div>
            </div>
            ${item.oneLiner || item.techStack.length ? `
            <div class="space-y-2">
              ${item.oneLiner ? `<p class="text-xs sm:text-sm text-[var(--ink-secondary)] leading-relaxed">${escapeHtml(item.oneLiner)}</p>` : ""}
              ${item.techStack.length ? `<div class="flex flex-wrap items-center gap-1.5">${item.techStack.map(t => `<span class="text-[11px] font-mono-tabular px-2 py-0.5 rounded surface-subtle">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            </div>` : ""}
            <div class="surface-subtle rounded-lg p-3.5 space-y-2">
              <div class="flex items-center justify-between text-[11px] font-mono-tabular uppercase tracking-wider text-[var(--ink-secondary)]">
                <span>100% remote tech roles (${roles.filter(r => r.status === "open").length} open${roles.some(r => r.status === "closed") ? `, ${roles.filter(r => r.status === "closed").length} closed` : ""})</span>
                <span class="hidden sm:inline">No on-site · No hybrid</span>
              </div>
              <div class="divide-y hairline-border text-xs">
                ${roles.map(r => `
                  <div class="py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${r.status === "closed" ? "role-closed" : ""}">
                    <div class="min-w-0 space-y-0.5">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-medium role-title">${escapeHtml(r.title)}</span>
                        <span class="text-[10px] font-mono-tabular px-1.5 py-0.5 rounded ${r.category === "Remote Internship" ? "badge-intern" : "badge-remote"}">${escapeHtml(r.category)}</span>
                      </div>
                      <div class="text-[11px] font-mono-tabular text-[var(--ink-muted)]">${escapeHtml([r.remoteScope, r.track, r.salary, r.postedAt ? "posted " + fmtDate(r.postedAt) : "seen " + fmtDate(r.firstSeen), OTHERS.includes(r.src) || ["jobicy", "arbeitnow"].includes(r.src) ? "via " + SOURCE_LABEL[r.src] : ""].filter(Boolean).join(" · "))}</div>
                      ${r.status === "closed" ? `<div class="text-[11px] font-mono-tabular text-[var(--accent-crimson)]">Closed — ${escapeHtml(r.closedReason || "no longer listed")}</div>` : ""}
                    </div>
                    <div class="flex items-center gap-3 font-mono-tabular shrink-0">
                      ${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="underline font-medium">${r.status === "closed" ? "Listing" : "Apply"} ↗</a>` : ""}
                      ${r.applyUrl ? `<a href="${escapeHtml(r.applyUrl)}" target="_blank" rel="noopener noreferrer" class="underline text-[var(--ink-muted)]">Direct ↗</a>` : ""}
                      <a href="https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(item.company + " " + r.title)}" target="_blank" rel="noopener noreferrer" class="underline text-[var(--ink-muted)]" title="Search this role on LinkedIn Jobs">LinkedIn ↗</a>
                    </div>
                  </div>`).join("")}
              </div>
            </div>
            <div class="border hairline-border rounded-lg p-3.5 space-y-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-tabular uppercase tracking-wider text-[var(--ink-secondary)]">
                <span>C-Suite &amp; decision-makers (${csuite.length} C-Suite · ${c.length} total)</span>
                <button type="button" data-open-outreach="${escapeHtml(item.id)}" class="underline font-semibold text-[var(--ink-primary)]">Draft C-Suite outreach →</button>
              </div>
              <div class="grid grid-cols-1 gap-2">
                ${pocs.length ? pocs.map(p => contactRow(item, p)).join("") : `
                  <div class="text-xs font-mono-tabular text-[var(--ink-secondary)]">No named contact on record yet.
                    <a class="underline" target="_blank" rel="noopener noreferrer" href="${linkedInSearch(item.company, "CEO")}">Find CEO ↗</a> ·
                    <a class="underline" target="_blank" rel="noopener noreferrer" href="${linkedInSearch(item.company, "CTO")}">Find CTO ↗</a> ·
                    <a class="underline" target="_blank" rel="noopener noreferrer" href="${linkedInSearch(item.company, "founder")}">Find founders ↗</a></div>`}
                ${c.length > pocs.length ? `<div class="text-[11px] font-mono-tabular text-[var(--ink-muted)]">+ ${c.length - pocs.length} more in the C-Suite directory view</div>` : ""}
              </div>
              ${channelBits.length ? `<div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 border-t hairline-border text-[11px] font-mono-tabular">${channelBits.join('<span class="opacity-30">·</span>')}</div>` : ""}
            </div>
          </article>`;
      }).join("");
      const more = filtered.length - shown;
      $("showMoreBtn").classList.toggle("hidden", more <= 0);
      $("showMoreBtn").textContent = `Show ${Math.min(more, 30)} more of ${more}`;
    }

    function renderCSuiteDirectoryTable(filtered) {
      const rows = [];
      for (const item of filtered) for (const p of item.contacts) {
        const st = contactStatusMap[contactKey(item.id, p)] || "Not Contacted";
        const phone = p.phone || item.hqPhone;
        rows.push(`
          <tr class="hover:bg-black/5 dark:hover:bg-white/5 ${item.status === "closed" ? "text-[var(--accent-crimson)]" : ""}">
            <td class="py-2.5 px-3 font-semibold">${escapeHtml(item.country || "Global")}<div class="text-[10px] text-[var(--ink-muted)]">${escapeHtml(item.region || "")}</div></td>
            <td class="py-2.5 px-3 font-sans font-semibold">${escapeHtml(item.company)}<div class="text-[10px] font-mono-tabular text-[var(--ink-secondary)]">${item.visibleOpen} remote tech roles</div></td>
            <td class="py-2.5 px-3 font-sans font-medium">${escapeHtml(p.name)}<div class="text-[10px] font-mono-tabular text-[var(--ink-secondary)]">${escapeHtml(p.title || "")} · ${escapeHtml(p.tier)}</div></td>
            <td class="py-2.5 px-3">${p.email ? `<button type="button" data-copy-val="${escapeHtml(p.email)}" class="underline decoration-dotted text-[var(--accent-emerald)]">${escapeHtml(p.email)}</button>` : "—"}</td>
            <td class="py-2.5 px-3">${phone ? `<button type="button" data-copy-val="${escapeHtml(phone)}" class="underline decoration-dotted">${escapeHtml(phone)}</button><div class="text-[10px] text-[var(--ink-muted)]">${p.phone ? "Direct" : "HQ line"}</div>` : "—"}</td>
            <td class="py-2.5 px-3"><div class="flex items-center gap-2">
              ${p.linkedin ? `<a href="${escapeHtml(p.linkedin)}" target="_blank" rel="noopener noreferrer" class="underline">LinkedIn ↗</a>` : `<a href="${linkedInSearch(item.company, p.name)}" target="_blank" rel="noopener noreferrer" class="underline text-[var(--ink-muted)]">Find ↗</a>`}
              <span class="text-[10px] px-1.5 py-0.5 rounded surface-subtle">${escapeHtml(st)}</span></div></td>
          </tr>`);
      }
      $("cSuiteTableBody").innerHTML = rows.join("") || `<tr><td colspan="6" class="py-6 px-3 text-center text-[var(--ink-muted)]">No contacts for these filters.</td></tr>`;
    }

    function renderSidebars() {
      const countries = getAlphabeticalCountries("ALL");
      $("sidebarCountriesAlphaList").innerHTML = countries.map(c => {
        const startups = companiesInCountry(c);
        const roles = leads.reduce((n, i) => n + i.roles.filter(r => r.status === "open" && roleCovers(r, { country: c })).length, 0);
        return `<button type="button" data-sidebar-country="${escapeHtml(c)}" class="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left transition ${activeCountry === c ? "pill-btn-active" : "hover:bg-black/5 dark:hover:bg-white/5"}">
          <span class="font-medium">${escapeHtml(c)}</span><span class="text-[11px] opacity-80">${startups} startups · ${roles} roles</span></button>`;
      }).join("");
      $("sidebarRegionsList").innerHTML = REGIONS.map(reg => {
        const count = leads.filter(i => i.roles.some(r => r.status === "open" && r.regions.includes(reg))).length;
        return `<button type="button" data-sidebar-region="${escapeHtml(reg)}" class="p-2.5 rounded-lg border hairline-border text-left transition ${activeRegion === reg ? "pill-btn-active" : "surface-subtle hover:border-[var(--ink-primary)]"}">
          <div class="font-semibold">${escapeHtml(reg)}</div><div class="text-[11px] opacity-75 mt-0.5">${count} remote startups</div></button>`;
      }).join("");
      const label = e => ({
        company_added: `${e.company} added`,
        company_closed: `${e.company} no longer hiring`,
        company_reopened: `${e.company} hiring again`,
        job_added: `${e.company}: new role — ${e.job}`,
        job_closed: `${e.company}: closed — ${e.job}`,
        job_reopened: `${e.company}: reopened — ${e.job}`,
      }[e.type] || e.type);
      const known = new Set(leads.map(i => i.id));
      const events = [...localEvents, ...(raw.meta ? raw.events || [] : [])].filter(e => e.local || known.has(e.companyId)).slice(0, 60);
      $("hourlyActivityFeed").innerHTML = events.map(e => {
        const bad = /closed/.test(e.type);
        return `<div class="p-2.5 rounded-md surface-subtle space-y-0.5">
          <div class="flex items-center justify-between text-[10px] text-[var(--ink-muted)]">
            <span>${escapeHtml(ago(e.t))}</span>
            <span class="uppercase font-semibold ${bad ? "text-[var(--accent-crimson)]" : "text-[var(--accent-emerald)]"}">${bad ? "closed" : e.local ? "live" : "ok"}</span>
          </div>
          <div class="text-[11px] leading-snug">${escapeHtml(e.local ? e.text : label(e))}${e.reason ? `<div class="text-[var(--ink-muted)]">${escapeHtml(e.reason)}</div>` : ""}</div></div>`;
      }).join("") || `<div class="text-[11px] text-[var(--ink-muted)]">No activity yet.</div>`;
    }

    function refreshAll() {
      populateAlphabeticalCountryDropdown();
      const filtered = getFilteredLeads();
      renderKpisAndCounts(filtered);
      renderStartupCards(filtered);
      renderCSuiteDirectoryTable(filtered);
      renderSidebars();
      document.querySelectorAll(".role-tab-btn").forEach(b => b.classList.toggle("seg-btn-active", b.dataset.roleTab === activeRoleTab));
      document.querySelectorAll(".region-pill-btn").forEach(b => b.classList.toggle("pill-btn-active", b.dataset.regionPill === activeRegion));
      updateLinkedInButton();
    }

    function updateLiveLabel() {
      if (!raw) return;
      const hours = (Date.now() - Date.parse(raw.meta.lastVerifyAt || raw.meta.generatedAt)) / 3600e3;
      $("liveSyncDot").className = "inline-block w-2 h-2 rounded-full " + (liveChecking ? "bg-amber-500 pulse-live" : hours > 3 ? "bg-amber-500" : "bg-emerald-600");
      $("liveStatusText").textContent = liveChecking ? "Checking roles live…" : `Live · server check ${ago(raw.meta.lastVerifyAt || raw.meta.generatedAt)}`;
      $("lastHourlyCheckNote").textContent = `Server: hourly (${HOURLY_CRON}) · Browser: ${lastLiveCheck ? "checked " + ago(lastLiveCheck) : "checking…"}`;
    }

    // ------------------------------------------------------------------ data loading + hourly live engine
    async function load(force) {
      try {
        const vr = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" }).catch(() => null);
        const version = vr && vr.ok ? (await vr.json()).v : null;
        if (raw && !force && version && version === lastVersion) { updateLiveLabel(); return false; }
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const next = await res.json();
        const before = raw ? new Map(leads.map(i => [i.id, i.status])) : null;
        raw = next;
        lastVersion = version;
        for (const id of [...liveClosed.keys()]) {
          const job = raw.companies.flatMap(c => c.jobs).find(j => j.id === id);
          if (!job || job.status === "closed") liveClosed.delete(id);
        }
        leads = raw.companies.map(adapt);
        if (before) {
          const added = leads.filter(i => !before.has(i.id));
          const closed = leads.filter(i => before.get(i.id) === "open" && i.status === "closed");
          if (added.length) showToast(`${added.length} new startup${added.length === 1 ? "" : "s"} added`);
          if (closed.length) showToast(`${closed[0].company}${closed.length > 1 ? ` and ${closed.length - 1} more` : ""} stopped hiring`);
        }
        refreshAll();
        updateLiveLabel();
        return true;
      } catch (e) {
        $("liveStatusText").textContent = "Offline · retrying (" + e.message + ")";
        return false;
      }
    }

    // Greenhouse, Lever, Ashby and HN (Algolia) allow cross-origin reads, so open roles are re-checked
    // straight from the browser. Roles are only marked closed on positive evidence, never on errors.
    async function fetchJson(url) {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 404) return { gone: true };
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }
    async function boardIds(board) {
      const [ats, ...rest] = board.split(":");
      const token = encodeURIComponent(rest.join(":"));
      if (ats === "greenhouse") { const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`); return d.gone ? d : new Set(d.jobs.map(j => String(j.id))); }
      if (ats === "lever") { const d = await fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json`); return d.gone ? d : new Set(d.map(j => j.id)); }
      if (ats === "ashby") { const d = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`); return d.gone ? d : new Set((d.jobs || []).map(j => j.id)); }
      return null;
    }
    const FILLED_RE = /\b(no longer hiring|positions? (?:(?:have|has) been |are |is )?filled|hiring (?:is )?(?:now )?closed|roles? (?:(?:is|are|has been|have been) )?filled)\b/i;

    async function runLiveHourlyVerification(isManual) {
      if (!raw || liveChecking) return;
      liveChecking = true;
      updateLiveLabel();
      if (isManual) showToast("Re-checking every open role against its job board…");
      const found = new Map();
      try {
        const boards = new Map(), threads = new Map();
        for (const c of raw.companies) for (const j of c.jobs) {
          if (j.status !== "open" || liveClosed.has(j.id)) continue;
          if (j.board) (boards.get(j.board) || boards.set(j.board, []).get(j.board)).push([c, j]);
          else if (j.src === "hn" && j.thread) (threads.get(j.thread) || threads.set(j.thread, []).get(j.thread)).push([c, j]);
        }
        const tasks = [...boards].map(([board, list]) => async () => {
          try {
            const ids = await boardIds(board);
            if (!ids) return;
            if (ids.gone) { list.forEach(([c, j]) => found.set(j.id, [c, j, "job board removed"])); return; }
            if (ids.size === 0 && list.length > 3) return;
            for (const [c, j] of list) if (!ids.has(j.id.split(":").slice(2).join(":"))) found.set(j.id, [c, j, "removed from the company job board"]);
          } catch (e) {}
        });
        for (const [thread, list] of threads) tasks.push(async () => {
          try {
            const d = await fetchJson(`https://hn.algolia.com/api/v1/items/${thread}`);
            if (d.gone) return;
            const kids = new Map((d.children || []).map(k => [String(k.id), k]));
            for (const [c, j] of list) {
              const k = kids.get(j.id.slice(3));
              if (!k || !k.text || !k.author) found.set(j.id, [c, j, "HN post deleted"]);
              else if (FILLED_RE.test(k.text.replace(/<[^>]+>/g, " ").slice(0, 400))) found.set(j.id, [c, j, "HN post says filled"]);
            }
          } catch (e) {}
        });
        const queue = [...tasks];
        await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) await queue.shift()(); }));
        const before = new Map(leads.map(i => [i.id, i.status]));
        for (const [id, [c, j, reason]] of found) {
          liveClosed.set(id, reason);
          localEvents.unshift({ local: true, t: new Date().toISOString(), type: "job_closed", text: `${c.name}: closed — ${j.title}`, reason });
        }
        lastLiveCheck = new Date().toISOString();
        localEvents.unshift({ local: true, t: lastLiveCheck, type: "check", text: `Live check: ${boards.size + threads.size} job boards re-read, ${found.size} role${found.size === 1 ? "" : "s"} closed since the last server update.` });
        leads = raw.companies.map(adapt);
        refreshAll();
        const turnedRed = leads.filter(i => before.get(i.id) === "open" && i.status === "closed");
        if (turnedRed.length) showToast(`${turnedRed[0].company} just stopped hiring`);
        else if (isManual) showToast(found.size ? `${found.size} role(s) closed — marked in red` : "All open roles are still live");
      } finally {
        liveChecking = false;
        countdownSeconds = 3600;
        updateLiveLabel();
      }
    }

    // LinkedIn Jobs search for the current filters: remote only (f_WT=2), posted in the last week.
    function linkedInJobsUrl() {
      const kw = [searchQuery || TRACK_KEYWORDS[activeDiscipline] || "software engineer", activeRoleTab === "INTERN" ? "intern" : ""].filter(Boolean).join(" ");
      const loc = activeCountry !== "ALL" ? activeCountry : REGION_LINKEDIN[activeRegion] || "Worldwide";
      return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_WT=2&f_TPR=r604800`;
    }
    function updateLinkedInButton() {
      const a = $("linkedinJobsBtn");
      if (!a) return;
      a.href = linkedInJobsUrl();
      const where = activeCountry !== "ALL" ? activeCountry : activeRegion !== "ALL" ? activeRegion : "all regions";
      a.title = `Remote ${activeRoleTab === "INTERN" ? "internships" : "jobs"} on LinkedIn · ${where} · last 7 days`;
    }

    // ------------------------------------------------------------------ outreach drawer + CSV
    function openOutreachModal(id) {
      const item = leads.find(l => l.id === id);
      if (!item) return;
      const target = item.contacts.find(p => p.tier === "C-Suite" && p.email) || item.contacts.find(p => p.email) || item.contacts[0];
      const openRoles = item.roles.filter(r => r.status === "open");
      $("modalCompanyBadge").textContent = `${item.country || "Global"} · ${item.region || "Global"} · ${item.remoteScope}`;
      $("modalTitle").textContent = `${item.company} — C-Suite outreach`;
      $("modalContactsList").innerHTML = item.contacts.length ? item.contacts.slice(0, 8).map(p => {
        const phone = p.phone || item.hqPhone;
        return `<div class="surface-subtle p-3 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs font-mono-tabular">
          <div><div class="font-sans font-semibold">${escapeHtml(p.name)} — ${escapeHtml(p.title || "")}</div>
          <div class="text-[11px] text-[var(--ink-secondary)]">${escapeHtml(p.email || "no email on record")}${phone ? " · " + escapeHtml(phone) + (p.phone ? "" : " (HQ)") : ""}</div></div>
          <div class="flex items-center gap-2">
            ${p.email ? `<button type="button" data-copy-val="${escapeHtml(p.email)}" class="pill-btn px-2 py-1 rounded">Copy email</button>` : ""}
            ${phone ? `<button type="button" data-copy-val="${escapeHtml(phone)}" class="pill-btn px-2 py-1 rounded">Copy phone</button>` : ""}
            ${p.linkedin ? `<a href="${escapeHtml(p.linkedin)}" target="_blank" rel="noopener noreferrer" class="pill-btn px-2 py-1 rounded">LinkedIn ↗</a>` : ""}
          </div></div>`;
      }).join("") : `<div class="text-xs font-mono-tabular text-[var(--ink-secondary)]">No named contact yet — use <a class="underline" target="_blank" rel="noopener noreferrer" href="${linkedInSearch(item.company, "CEO")}">LinkedIn search</a> to find the CEO / CTO.</div>`;
      const first = (target?.name || "there").split(/\s+/)[0];
      const roleTitles = openRoles.slice(0, 3).map(r => r.title).join(", ");
      const track = openRoles[0]?.track || "engineering";
      const subject = `Remote ${track} hiring at ${item.company}`;
      const body = `Hi ${first},\n\nI saw that ${item.company} is hiring remotely for ${roleTitles || "engineering roles"}.\n\nWe work with pre-vetted software and AI engineers who are used to working fully remote across time zones${item.techStack.length ? `, including people shipping production code in ${item.techStack.slice(0, 4).join(", ")}` : ""}. I'd be glad to share a short list of profiles that match these roles.\n\nWould a 15-minute call this week or next be useful?\n\nBest regards,\n`;
      $("modalPitchTextarea").value = `Subject: ${subject}\n\n${body}`;
      $("mailtoPitchLink").href = target?.email ? `mailto:${encodeURIComponent(target.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : "#";
      $("mailtoPitchLink").classList.toggle("opacity-40", !target?.email);
      $("outreachModal").classList.remove("hidden");
    }
    function syncMailtoFromTextarea() {
      const text = $("modalPitchTextarea").value;
      const m = /^Subject:\s*(.*)\n\n?([\s\S]*)$/.exec(text);
      const link = $("mailtoPitchLink");
      const to = decodeURIComponent((link.href.match(/^mailto:([^?]*)/) || [])[1] || "");
      if (to) link.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(m ? m[1] : "")}&body=${encodeURIComponent(m ? m[2] : text)}`;
    }

    function exportCsv(onlyCSuite) {
      const filtered = getFilteredLeads();
      const headers = ["Country", "Region", "Startup", "Status", "Remote scope", "Open remote tech roles", "Tracks", "Contact name", "Contact title", "Tier", "Email", "Phone", "Phone type", "LinkedIn", "Company emails", "Company LinkedIn", "Job board", "Sources", "Contact status"];
      const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [headers.map(cell).join(",")];
      for (const item of filtered) {
        const roles = item.visibleRoles.filter(r => r.status === "open");
        const base = [item.country || "Global", item.region || "Global", item.company, item.status === "open" ? "Hiring" : "No longer hiring", item.remoteScope,
          roles.map(r => `${r.title} [${r.category}] <${r.url}>`).join(" | "), [...new Set(roles.map(r => r.track))].join(" | ")];
        const tail = [item.companyEmails.map(e => e.email).join(" | "), item.linkedinPage, item.boardUrl, item.sources.map(s => SOURCE_LABEL[s] || s).join(" | ")];
        const people = onlyCSuite ? item.contacts.filter(p => p.tier === "C-Suite") : item.contacts;
        if (!people.length) { if (!onlyCSuite) rows.push([...base, "", "", "", "", item.hqPhone, item.hqPhone ? "HQ line" : "", "", ...tail, ""].map(cell).join(",")); continue; }
        for (const p of people) rows.push([...base, p.name, p.title, p.tier, p.email, p.phone || item.hqPhone, p.phone ? "Direct" : item.hqPhone ? "HQ line" : "", p.linkedin, ...tail,
          contactStatusMap[contactKey(item.id, p)] || "Not Contacted"].map(cell).join(","));
      }
      const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: onlyCSuite ? "startup_leads_csuite_contacts.csv" : "startup_leads_remote_tech.csv" });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      showToast(`Exported ${rows.length - 1} rows`);
    }

    // ------------------------------------------------------------------ wiring
    document.addEventListener("DOMContentLoaded", async () => {
      loadStatus();
      if (localStorage.getItem("startup_leads_theme") === "dark" || (!localStorage.getItem("startup_leads_theme") && matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");

      setInterval(() => {
        countdownSeconds = Math.max(0, countdownSeconds - 1);
        $("hourlyCountdownLabel").textContent = `${String(Math.floor(countdownSeconds / 60)).padStart(2, "0")}:${String(countdownSeconds % 60).padStart(2, "0")}`;
        if (countdownSeconds === 0) load(false).then(() => runLiveHourlyVerification(false));
      }, 1000);
      setInterval(() => load(false), 60 * 1000);           // cheap version check; new data appears within a minute of deploy
      setInterval(() => { updateLiveLabel(); renderSidebars(); }, 30 * 1000);

      const set = fn => (...a) => { fn(...a); shown = 30; refreshAll(); };
      document.querySelectorAll(".role-tab-btn").forEach(b => b.addEventListener("click", set(() => { activeRoleTab = b.dataset.roleTab; })));
      document.querySelectorAll(".region-pill-btn").forEach(b => b.addEventListener("click", set(() => { activeRegion = b.dataset.regionPill; activeCountry = "ALL"; })));
      $("countrySelectAlpha").addEventListener("change", set(e => { activeCountry = e.target.value; }));
      $("disciplineSelect").addEventListener("change", set(e => { activeDiscipline = e.target.value; }));
      $("cSuiteFilterSelect").addEventListener("change", set(e => { activeCSuiteFilter = e.target.value; }));
      $("sourceSelect").addEventListener("change", set(e => { activeSource = e.target.value; }));
      $("sortOrderSelect").addEventListener("change", set(e => { activeSort = e.target.value; }));

      const searchInput = $("searchFilterInput"), clearBtn = $("clearSearchBtn");
      let t;
      searchInput.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(set(() => { searchQuery = searchInput.value.trim(); clearBtn.classList.toggle("hidden", !searchQuery); }), 120);
      });
      clearBtn.addEventListener("click", set(() => { searchInput.value = ""; searchQuery = ""; clearBtn.classList.add("hidden"); }));
      document.addEventListener("keydown", e => {
        if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName || "")) { e.preventDefault(); searchInput.focus(); }
        if (e.key === "Escape") $("outreachModal").classList.add("hidden");
      });

      $("resetAllFiltersBtn").addEventListener("click", set(() => {
        activeRoleTab = activeRegion = activeCountry = activeDiscipline = activeCSuiteFilter = activeSource = "ALL";
        activeSort = "COUNTRY_AZ"; searchQuery = ""; searchInput.value = ""; clearBtn.classList.add("hidden");
        $("disciplineSelect").value = "ALL"; $("cSuiteFilterSelect").value = "ALL"; $("sourceSelect").value = "ALL"; $("sortOrderSelect").value = "COUNTRY_AZ";
      }));
      $("showMoreBtn").addEventListener("click", () => { shown += 30; renderStartupCards(getFilteredLeads()); });

      document.querySelectorAll(".view-mode-btn").forEach(btn => btn.addEventListener("click", () => {
        viewMode = btn.dataset.viewMode;
        document.querySelectorAll(".view-mode-btn").forEach(b => b.classList.toggle("pill-btn-active", b === btn));
        $("cardsFeedContainer").classList.toggle("hidden", viewMode !== "CARDS");
        $("showMoreBtn").classList.toggle("hidden", viewMode !== "CARDS" || getFilteredLeads().length <= shown);
        $("cSuiteTableContainer").classList.toggle("hidden", viewMode !== "TABLE");
      }));

      const syncNow = async () => { await load(true); await runLiveHourlyVerification(true); };
      $("checkNowBtn").addEventListener("click", syncNow);
      $("sidebarSyncBtn").addEventListener("click", syncNow);
      $("exportCsvBtn").addEventListener("click", () => exportCsv(false));
      $("exportCSuiteCsvBtn").addEventListener("click", () => exportCsv(true));
      $("themeToggleBtn").addEventListener("click", () => {
        const dark = document.documentElement.classList.toggle("dark");
        try { localStorage.setItem("startup_leads_theme", dark ? "dark" : "light"); } catch (e) {}
      });
      $("closeOutreachModalBtn").addEventListener("click", () => $("outreachModal").classList.add("hidden"));
      $("outreachModal").addEventListener("click", e => { if (e.target.id === "outreachModal") $("outreachModal").classList.add("hidden"); });
      $("copyPitchBtn").addEventListener("click", () => copyToClipboard($("modalPitchTextarea").value, "outreach email"));
      $("modalPitchTextarea").addEventListener("input", syncMailtoFromTextarea);

      document.body.addEventListener("click", e => {
        const copy = e.target.closest("[data-copy-val]");
        if (copy) { copyToClipboard(copy.dataset.copyVal); return; }
        const outreach = e.target.closest("[data-open-outreach]");
        if (outreach) { openOutreachModal(outreach.dataset.openOutreach); return; }
        const sc = e.target.closest("[data-sidebar-country]");
        if (sc) { const c = sc.dataset.sidebarCountry; activeCountry = activeCountry === c ? "ALL" : c; if (activeCountry !== "ALL") activeRegion = "ALL"; shown = 30; refreshAll(); return; }
        const sr = e.target.closest("[data-sidebar-region]");
        if (sr) { const r = sr.dataset.sidebarRegion; activeRegion = activeRegion === r ? "ALL" : r; activeCountry = "ALL"; shown = 30; refreshAll(); }
      });
      document.body.addEventListener("change", e => {
        const sel = e.target.closest(".contact-status-select");
        if (!sel) return;
        contactStatusMap[sel.dataset.statusKey] = sel.value;
        saveStatus();
        showToast("Marked " + sel.value.toLowerCase());
        if (activeCSuiteFilter === "UNCONTACTED") refreshAll();
      });

      // Deep link from the RTI tracker: ?q=<company> pre-fills the search.
      const deepQ = new URLSearchParams(location.search).get("q");
      if (deepQ) { searchInput.value = deepQ; searchQuery = deepQ; clearBtn.classList.remove("hidden"); }
      await load(true);
      if (raw) {
        $("updaterLink").href = `https://github.com/${raw.meta.repo}/actions/workflows/hourly_sync.yml`;
        runLiveHourlyVerification(false);
      }
    });
