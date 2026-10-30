// Startup Leads: 100% remote, pure-tech roles in Australia, Europe, MEA, New Zealand, SEA and the UK.
// Data comes from data/leads.json (rebuilt hourly by .github/workflows/hourly_sync.yml); this page only
// reads it. Open roles are also re-checked against the live job boards from the browser every 60 minutes.
//
// Flow: Find (Jobs tab) → Open (detail panel) → Reach out (panel Outreach tab) → Track (Outreach tab).
// All filter, search and tab state lives in the URL query; the open panel lives in the URL hash.
(() => {
  "use strict";

  const DATA_URL = "data/leads.json";
  const VERSION_URL = "data/version.json";
  const HOURLY_CRON = "0 * * * *";
  const STATUS_KEY = "startup_leads_contact_status_v6"; // same storage as before: contactKey -> status
  const THEME_KEY = "startup_leads_theme";
  const VISIT_KEY = "startup_leads_last_visit";
  const REGIONS = ["Australia", "Europe", "MEA", "New Zealand", "SEA", "UK"];
  const REGION_SHORT = { Australia: "AU", Europe: "EU", MEA: "MEA", "New Zealand": "NZ", SEA: "SEA", UK: "UK" };
  const WIDE = { Worldwide: REGIONS, "Europe-wide": ["Europe", "UK"], EMEA: ["Europe", "MEA", "UK"], "APAC-wide": ["Australia", "New Zealand", "SEA"], "MENA-wide": ["MEA"], "Africa-wide": ["MEA"] };
  const STATUSES = ["Not Contacted", "Contacted", "Replied"];
  const CSUITE_RE = /\b(ceo|cto|cpo|coo|cfo|chief|co-?founder|founder|president|vp,? (?:of )?engineering|vice president,? engineering|head of (?:engineering|ai|technology|machine learning|data|platform))\b/i;
  const TALENT_RE = /recruit|talent|human resources|\bhr\b|people/i;
  const PARTNER_RE = /partner(?:ship)?s?\b|alliance|business development/i;
  const STACK = ["Python", "TypeScript", "JavaScript", "Go", "Golang", "Rust", "Java", "Kotlin", "Swift", "Scala", "C++", "C#", "Ruby", "Elixir", "PHP", "Node.js", "React", "React Native", "Flutter", "Next.js", "Vue", "Django", "Rails", "PyTorch", "TensorFlow", "LLM", "Kubernetes", "AWS", "GCP", "Azure", "Terraform", "Postgres", "Kafka", "Spark", "dbt", "Snowflake", "Linux", "iOS", "Android", "Solidity", "Web3", "ROS", "CUDA"];
  const TIER_ORDER = { "C-Suite": 0, "Talent & HR": 1, Partnerships: 2, Leadership: 3 };
  const SOURCE_LABEL = { yc: "Y Combinator", hn: "HN Who's Hiring", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", jobicy: "Jobicy", arbeitnow: "Arbeitnow", manual: "Manual",
    remotive: "Remotive", remoteok: "Remote OK", workingnomads: "Working Nomads", weworkremotely: "We Work Remotely", nodesk: "NoDesk", jobfound: "Jobfound", linkedin: "LinkedIn", others: "Other job boards" };
  const OTHERS = ["remotive", "remoteok", "workingnomads", "weworkremotely", "nodesk", "jobfound"];
  const TRACK_KEYWORDS = { "AI / ML & LLM Systems": "machine learning engineer", "Backend & Distributed Systems": "backend engineer", "Data & Quant Engineering": "data engineer",
    "DevOps, Cloud & SRE": "devops engineer", "Full-Stack & Product Engineering": "full stack engineer", "Mobile & Autonomous Systems": "mobile engineer" };
  const TRACK_SHORT = { "AI / ML & LLM Systems": "AI / ML", "Backend & Distributed Systems": "Backend", "Data & Quant Engineering": "Data", "DevOps, Cloud & SRE": "DevOps / Cloud",
    "Full-Stack & Product Engineering": "Full-stack", "Mobile & Autonomous Systems": "Mobile / Robotics" };
  const REGION_LINKEDIN = { Australia: "Australia", Europe: "European Union", MEA: "Middle East", "New Zealand": "New Zealand", SEA: "Southeast Asia", UK: "United Kingdom" };
  const HAS_LABEL = { email: "Has email", phone: "Has phone", linkedin: "Has LinkedIn", csuite: "C-Suite email + phone + LinkedIn", uncontacted: "Not contacted" };
  // Country → ISO code for flags (countries the data can contain).
  const ISO = { "United Kingdom": "GB", Germany: "DE", "United Arab Emirates": "AE", "Saudi Arabia": "SA", Qatar: "QA", Bahrain: "BH", Kuwait: "KW", Oman: "OM", Egypt: "EG", Jordan: "JO", Lebanon: "LB",
    Morocco: "MA", Tunisia: "TN", Algeria: "DZ", Israel: "IL", Turkey: "TR", Nigeria: "NG", Kenya: "KE", Ghana: "GH", "South Africa": "ZA", Rwanda: "RW", Uganda: "UG", Ethiopia: "ET", Tanzania: "TZ",
    Senegal: "SN", Zambia: "ZM", Zimbabwe: "ZW", Namibia: "NA", Botswana: "BW", Mauritius: "MU", "Côte d'Ivoire": "CI", Cameroon: "CM", Singapore: "SG", Indonesia: "ID", Malaysia: "MY", Thailand: "TH",
    Vietnam: "VN", Philippines: "PH", Myanmar: "MM", Cambodia: "KH", Australia: "AU", "New Zealand": "NZ", Ireland: "IE", France: "FR", Spain: "ES", Portugal: "PT", Netherlands: "NL", Belgium: "BE",
    Switzerland: "CH", Austria: "AT", Italy: "IT", Poland: "PL", Czechia: "CZ", Romania: "RO", Bulgaria: "BG", Greece: "GR", Hungary: "HU", Croatia: "HR", Serbia: "RS", "Bosnia and Herzegovina": "BA",
    "North Macedonia": "MK", Slovenia: "SI", Slovakia: "SK", Lithuania: "LT", Latvia: "LV", Estonia: "EE", Finland: "FI", Sweden: "SE", Norway: "NO", Denmark: "DK", Iceland: "IS", Luxembourg: "LU",
    Ukraine: "UA", Cyprus: "CY", Malta: "MT" };

  // ---------------------------------------------------------------- state
  let raw = null, leads = [], lastVersion = null, lastLiveCheck = null, liveChecking = false;
  let countdownSeconds = 3600; // next in-browser verification of open roles (hourly)
  const liveClosed = new Map(); // role id -> reason, found by in-browser checks since the last dataset
  const localEvents = [];
  let shown = 40, boardShown = { "Not Contacted": 60, Contacted: 60, Replied: 60 };
  let lastFocus = null;
  const DEFAULTS = { tab: "jobs", q: "", region: "", country: "", track: "", type: "", source: "", has: [], sort: "newest", team: "", empty: false, layout: "board", kind: "" };
  const S = { ...DEFAULTS, has: [] };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  let statusMap = store.get(STATUS_KEY, {});

  // "New" = added since the previous visit (kept for this browser session so a refresh doesn't clear it).
  const prevVisit = (() => {
    let prev = null;
    try {
      prev = sessionStorage.getItem("sl.prevVisit");
      if (prev === null) {
        prev = localStorage.getItem(VISIT_KEY) || "";
        sessionStorage.setItem("sl.prevVisit", prev);
        localStorage.setItem(VISIT_KEY, new Date().toISOString());
      }
    } catch (e) {}
    return prev ? Date.parse(prev) : null;
  })();
  const isNew = iso => prevVisit !== null && iso && Date.parse(iso) > prevVisit;

  // ---------------------------------------------------------------- formatting helpers
  function ago(iso) {
    if (!iso) return "—";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }
  const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
  const flag = country => (ISO[country] ? String.fromCodePoint(...[...ISO[country]].map(c => 127397 + c.charCodeAt(0))) : "");
  const initials = n => (n || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const telHref = p => "tel:" + String(p).replace(/[^\d+]/g, "");
  const linkedInPeople = (company, role) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${role} ${company}`)}`;

  // Salaries are shown as listed, with consistent separators. When units are unclear (e.g. "$100 - $165"
  // with no K, or "£80 - £150 GBP") nothing is invented: the value is marked "as listed".
  function fmtSalary(s) {
    if (!s) return null;
    let t = String(s).trim().replace(/\s*[-–]\s*/g, " – ").replace(/(\d)k\b/g, "$1K");
    const nums = [...t.matchAll(/[$£€]\s?(\d+(?:\.\d+)?)(K)?/g)];
    const unclear = nums.length > 0 && nums.every(m => !m[2] && +m[1] >= 10 && +m[1] < 1000) && !/hour|\/hr|day|month|week/i.test(t);
    return { text: t, unclear };
  }

  // ---------------------------------------------------------------- data → view model
  function contactTier(p) {
    const t = p.title || "";
    if (CSUITE_RE.test(t)) return "C-Suite";
    if (p.source === "HN" || TALENT_RE.test(t)) return "Talent & HR";
    if (PARTNER_RE.test(t)) return "Partnerships";
    return "Leadership";
  }
  const contactKey = (companyId, p) => companyId + "::" + (p.linkedin || p.email || p.name || "").toLowerCase();
  const statusOf = (item, p) => statusMap[contactKey(item.id, p)] || "Not Contacted";

  function adapt(c) {
    const roles = c.jobs.filter(j => !j.dup).map(j => {
      const closedLive = liveClosed.has(j.id) && j.status === "open";
      return {
        id: j.id, title: j.title, src: j.src, via: j.via,
        category: j.type === "internship" ? "Internship" : "Job",
        remoteScope: j.remoteScope || "100% Remote", track: j.track || "Backend & Distributed Systems",
        places: j.places || [], regions: j.regions || [],
        url: j.url, applyUrl: j.applyUrl && j.applyUrl !== j.url ? j.applyUrl : null,
        salary: fmtSalary(j.salary), experience: j.experience, postedAt: j.postedAt, firstSeen: j.firstSeen,
        status: closedLive ? "closed" : j.status,
        closedAt: closedLive ? new Date().toISOString() : j.closedAt,
        closedReason: closedLive ? liveClosed.get(j.id) + " (detected live)" : j.closedReason,
      };
    }).sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || String(b.postedAt || b.firstSeen).localeCompare(String(a.postedAt || a.firstSeen)));
    const open = roles.filter(r => r.status === "open");
    const contacts = (c.contacts || []).map(p => ({ ...p, tier: contactTier(p) }))
      .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (b.email ? 1 : 0) - (a.email ? 1 : 0));
    const text = roles.map(r => r.title).join(" ") + " " + (c.oneLiner || "") + " " + (c.tags || []).join(" ");
    const techStack = STACK.filter(t => new RegExp(`(^|[^\\w])${t.replace(/[.+#]/g, m => "\\" + m)}([^\\w]|$)`, "i").test(text)).slice(0, 8);
    const remoteScope = open.some(r => r.places.includes("Worldwide")) ? "100% Remote (Global)"
      : `100% Remote (${REGIONS.filter(r => open.some(x => x.regions.includes(r))).map(r => REGION_SHORT[r]).join("/") || "—"})`;
    return {
      id: c.id, company: c.name, country: c.country || null, region: c.region || null,
      website: c.website, logo: c.logo, oneLiner: c.oneLiner || "", batch: c.batch ? `YC ${shortBatch(c.batch)}` : "", techStack,
      source: c.source, sources: c.sources || [c.source], firstSeen: c.firstSeen,
      status: open.length ? "open" : "closed", closedAt: c.closedAt,
      roles, openCount: open.length, remoteScope, contacts,
      hqPhone: c.channels?.phones?.[0]?.phone || null, companyEmails: c.channels?.emails || [], social: c.channels?.social || {}, pages: c.channels?.pages || {},
      linkedinPage: c.linkedin || c.channels?.social?.linkedin || null,
      boardUrl: c.careersUrl || c.profileUrl || c.website || roles[0]?.url, careersUrl: c.careersUrl, profileUrl: c.profileUrl,
    };
  }
  const shortBatch = b => { const m = /(Winter|Spring|Summer|Fall)\s+20(\d\d)/.exec(b || ""); return m ? m[1][0] + m[2] : b; };
  const regionOfCountry = c => raw?.meta?.regionOf?.[c];

  // ---------------------------------------------------------------- filtering
  function roleCovers(role, region, country) {
    if (country) return role.places.includes(country); // a country shows only roles that name it
    if (region) return role.regions.includes(region);
    return true;
  }
  function roleMatches(role, f = S) {
    if (f.type && (f.type === "internship") !== (role.category === "Internship")) return false;
    if (!roleCovers(role, f.region, f.country)) return false;
    if (f.track && role.track !== f.track) return false;
    return true;
  }
  function hasMatch(item, has) {
    for (const h of has) {
      if (h === "email" && !(item.contacts.some(p => p.email) || item.companyEmails.length)) return false;
      if (h === "phone" && !(item.contacts.some(p => p.phone) || item.hqPhone)) return false;
      if (h === "linkedin" && !(item.contacts.some(p => p.linkedin) || item.linkedinPage)) return false;
      if (h === "csuite" && !item.contacts.some(p => p.tier === "C-Suite" && p.email && (p.phone || item.hqPhone) && p.linkedin)) return false;
      if (h === "uncontacted" && item.contacts.some(p => statusOf(item, p) !== "Not Contacted")) return false;
    }
    return true;
  }
  function sourceMatch(item, src) {
    if (!src) return true;
    if (src === "others") return item.sources.some(s => OTHERS.includes(s));
    if (src === "linkedin") return item.roles.some(r => r.via === "linkedin") || Boolean(item.linkedinPage) || item.contacts.some(p => p.linkedin);
    return item.sources.includes(src);
  }
  function searchMatch(item, q) {
    if (!q) return true;
    const hay = [item.company, item.country, item.region, item.oneLiner, ...item.techStack, ...item.roles.map(r => `${r.title} ${r.track}`), ...item.contacts.map(p => `${p.name} ${p.title} ${p.email || ""}`)].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
  }
  const newestOf = roles => roles.reduce((m, r) => { const t = r.postedAt || r.firstSeen; return t && (!m || t > m) ? t : m; }, null);

  // Companies (with only their matching roles) for the Jobs tab.
  function jobRows(f = S) {
    const rows = [];
    for (const item of leads) {
      const roles = item.roles.filter(r => roleMatches(r, f));
      if (!roles.length) continue;
      if (!hasMatch(item, f.has) || !sourceMatch(item, f.source) || !searchMatch(item, f.q)) continue;
      const open = roles.filter(r => r.status === "open");
      rows.push({ ...item, visibleRoles: roles, visibleOpen: open.length, newest: newestOf(open.length ? open : roles), status: open.length ? "open" : "closed" });
    }
    const name = (a, b) => a.company.localeCompare(b.company, "en");
    const sorters = {
      newest: (a, b) => String(b.newest || "").localeCompare(String(a.newest || "")) || name(a, b),
      country: (a, b) => (!a.country) - (!b.country) || String(a.country || "").localeCompare(String(b.country || ""), "en") || name(a, b),
      company: name,
      roles: (a, b) => b.visibleOpen - a.visibleOpen || name(a, b),
    };
    // Hiring companies first; companies whose roles all closed follow, in red.
    return rows.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || (sorters[f.sort] || sorters.newest)(a, b));
  }

  // Region tree with counts (companies), using every filter except region/country.
  function regionTree() {
    const f = { ...S, region: "", country: "" };
    const base = leads.filter(i => hasMatch(i, f.has) && sourceMatch(i, f.source) && searchMatch(i, f.q));
    const countFor = (region, country) => base.filter(i => i.roles.some(r => r.status === "open" && roleMatches(r, { ...f, region, country }))).length;
    const countries = {};
    for (const i of base) for (const r of i.roles) if (r.status === "open") for (const p of r.places) if (regionOfCountry(p)) (countries[regionOfCountry(p)] ||= new Set()).add(p);
    return REGIONS.map(region => ({
      region, count: countFor(region, ""),
      countries: [...(countries[region] || [])].sort((a, b) => a.localeCompare(b, "en")).map(c => ({ country: c, count: countFor("", c) })).filter(x => x.count),
    }));
  }

  // ---------------------------------------------------------------- URL state
  function readURL() {
    const p = new URLSearchParams(location.search);
    Object.assign(S, DEFAULTS, { has: [] });
    for (const k of ["tab", "q", "region", "country", "track", "type", "source", "sort", "team", "layout", "kind"]) if (p.get(k)) S[k] = p.get(k);
    if (p.get("has")) S.has = p.get("has").split(",").filter(h => HAS_LABEL[h]);
    S.empty = p.get("empty") === "1";
    if (!["jobs", "outreach", "changes"].includes(S.tab)) S.tab = "jobs";
  }
  function writeURL() {
    const p = new URLSearchParams();
    for (const k of ["tab", "q", "region", "country", "track", "type", "source", "sort", "team", "layout", "kind"]) if (S[k] && S[k] !== DEFAULTS[k]) p.set(k, S[k]);
    if (S.has.length) p.set("has", S.has.join(","));
    if (S.empty) p.set("empty", "1");
    const qs = p.toString();
    history.replaceState(null, "", (qs ? "?" + qs : location.pathname) + location.hash);
  }
  const set = patch => { Object.assign(S, patch); shown = 40; writeURL(); render(); };

  // ---------------------------------------------------------------- rendering: shared
  function render() {
    if (!raw) return;
    syncControls();
    const rows = jobRows();
    $("nJobs").textContent = rows.filter(r => r.status === "open").length;
    $("nOutreach").textContent = leads.reduce((n, i) => n + i.contacts.length, 0);
    $("nChanges").textContent = allEvents().filter(e => Date.now() - Date.parse(e.t) < 7 * 864e5).length || "";
    for (const t of ["jobs", "outreach", "changes"]) {
      const on = S.tab === t;
      $("tab-" + t).setAttribute("aria-selected", on);
      $("tab-" + t).tabIndex = on ? 0 : -1;
      $("view-" + t).hidden = !on;
    }
    if (S.tab === "jobs") renderJobs(rows);
    if (S.tab === "outreach") renderOutreach();
    if (S.tab === "changes") renderChanges();
    if (openId) renderPanel();
  }

  function syncControls() {
    $("q").value !== S.q && document.activeElement !== $("q") && ($("q").value = S.q);
    $("track").value = S.track;
    $("sort").value = S.sort;
    $("source").value = S.source;
    document.querySelectorAll("#typeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.type === S.type));
    document.querySelectorAll("#teamSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.team === S.team));
    document.querySelectorAll("#layoutSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.layout === S.layout));
    document.querySelectorAll("#changeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.kind === S.kind));
    document.querySelectorAll('input[name="has"]').forEach(i => { i.checked = S.has.includes(i.value); });
    $("showEmpty").checked = S.empty;
    $("regionLabel").textContent = S.country ? `${flag(S.country)} ${S.country}`.trim() : S.region || "All regions";
    const more = (S.source ? 1 : 0) + S.has.length;
    $("moreCount").textContent = more ? ` · ${more}` : "";
    const active = activeFilters().length;
    $("filterCount").textContent = active ? ` · ${active}` : "";
  }

  function activeFilters() {
    const out = [];
    if (S.country) out.push({ label: `${flag(S.country)} ${S.country}`.trim(), clear: { country: "" } });
    else if (S.region) out.push({ label: S.region, clear: { region: "" } });
    if (S.track) out.push({ label: TRACK_SHORT[S.track] || S.track, clear: { track: "" } });
    if (S.type) out.push({ label: S.type === "internship" ? "Internships" : "Jobs", clear: { type: "" } });
    if (S.source) out.push({ label: `Source: ${SOURCE_LABEL[S.source] || S.source}`, clear: { source: "" } });
    for (const h of S.has) out.push({ label: HAS_LABEL[h], clear: { has: S.has.filter(x => x !== h) } });
    if (S.q) out.push({ label: `“${S.q}”`, clear: { q: "" } });
    return out;
  }

  // ---------------------------------------------------------------- Jobs tab
  function renderJobs(rows) {
    const open = rows.filter(r => r.status === "open");
    const roles = open.reduce((n, r) => n + r.visibleOpen, 0);
    const contacts = open.reduce((n, r) => n + r.contacts.length, 0);
    const closed = rows.length - open.length;
    $("summaryText").innerHTML = `<b>${plural(open.length, "startup", "startups")}</b> · <b>${plural(roles, "role", "roles")}</b> · <b>${plural(contacts, "contact", "contacts")}</b>${closed ? ` · <span style="color:var(--crimson)">${closed} no longer hiring</span>` : ""}`;
    const chips = activeFilters();
    $("chips").innerHTML = chips.length ? chips.map((c, i) => `<span class="chip">${esc(c.label)}<button type="button" data-chip="${i}" aria-label="Remove filter ${esc(c.label)}">×</button></span>`).join("") + `<button type="button" class="linkbtn" id="clearAll">Clear all</button>` : "";
    updateLinkedInButton();

    if (!rows.length) {
      $("results").innerHTML = `<div class="empty"><strong>No remote tech roles match.</strong>Try removing a filter${chips.length ? ', or <button type="button" class="linkbtn" data-clear-all>clear all filters</button>' : ""}.</div>`;
      return;
    }
    $("results").innerHTML = rows.slice(0, shown).map(rowHtml).join("") +
      (rows.length > shown ? `<button type="button" class="btn more" id="showMore">Show ${Math.min(40, rows.length - shown)} more of ${rows.length - shown}</button>` : "");
  }

  function rowHtml(r) {
    const closed = r.status === "closed";
    const tracks = [...new Set(r.visibleRoles.filter(x => x.status === "open").map(x => TRACK_SHORT[x.track] || x.track))].slice(0, 3);
    const interns = r.visibleRoles.some(x => x.status === "open" && x.category === "Internship");
    const nw = isNew(r.firstSeen);
    const where = r.country ? `${flag(r.country)} ${esc(r.country)}` : "Global remote";
    return `<button type="button" class="row${closed ? " closed" : ""}" data-open="${esc(r.id)}" aria-label="${esc(r.company)}, ${r.visibleOpen} open roles">
      <span class="logo" aria-hidden="true">${r.logo ? `<img src="${esc(r.logo)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${esc(initials(r.company))}'))">` : esc(initials(r.company))}</span>
      <span class="main">
        <span class="top"><span class="name">${esc(r.company)}</span>${nw ? '<span class="badge new">New</span>' : ""}${closed ? '<span class="badge closed">No longer hiring</span>' : ""}<span class="where">${where} · ${esc(r.remoteScope)}</span></span>
        <span class="tags">${tracks.map(t => `<span class="tag">${esc(t)}</span>`).join("")}${interns ? '<span class="badge intern">Internship</span>' : ""}</span>
      </span>
      <span class="facts">
        <span class="fact"><b>${r.visibleOpen}</b><span>${r.visibleOpen === 1 ? "open role" : "open roles"}</span></span>
        <span class="fact"><b>${r.contacts.length}</b><span>${r.contacts.length === 1 ? "contact" : "contacts"}</span></span>
        <span class="fact"><b>${esc(fmtDate(r.newest) || "—")}</b><span>newest posting</span></span>
      </span>
    </button>`;
  }

  function renderRegionPop() {
    const tree = regionTree();
    const opt = (label, count, patch, checked, cls) =>
      `<button type="button" role="menuitemradio" class="opt ${cls}" aria-checked="${checked}" data-region-set='${esc(JSON.stringify(patch))}'><span>${label}</span><span class="c">${count}</span></button>`;
    const all = leads.filter(i => i.roles.some(r => r.status === "open")).length;
    $("regionPop").innerHTML = opt("All regions", all, { region: "", country: "" }, !S.region && !S.country, "") +
      tree.map(t => opt(esc(t.region), t.count, { region: t.region, country: "" }, S.region === t.region && !S.country, "region") +
        t.countries.map(c => opt(`${flag(c.country)} ${esc(c.country)}`.trim(), c.count, { region: "", country: c.country }, S.country === c.country, "country")).join("")).join("");
  }

  // LinkedIn Jobs search for the current filters: remote only (f_WT=2), posted in the last week.
  function updateLinkedInButton() {
    const kw = [S.q || TRACK_KEYWORDS[S.track] || "software engineer", S.type === "internship" ? "intern" : ""].filter(Boolean).join(" ");
    const loc = S.country || REGION_LINKEDIN[S.region] || "Worldwide";
    $("linkedinJobsBtn").href = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_WT=2&f_TPR=r604800`;
    $("linkedinJobsBtn").title = `Remote ${S.type === "internship" ? "internships" : "jobs"} on LinkedIn · ${loc} · last 7 days`;
  }

  // ---------------------------------------------------------------- Detail panel
  let openId = null, panelTab = "roles", outreachTo = null;

  function openPanel(id, tab = "roles", fromEl) {
    if (!leads.some(i => i.id === id)) return;
    openId = id; panelTab = tab; outreachTo = null;
    lastFocus = fromEl || document.activeElement;
    $("panel").hidden = false; $("scrim").hidden = false;
    document.body.style.overflow = "hidden";
    const h = `#c=${encodeURIComponent(id)}&t=${tab}`;
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
    renderPanel();
    $("panelClose")?.focus();
  }
  function closePanel() {
    openId = null;
    $("panel").hidden = true; $("scrim").hidden = true;
    document.body.style.overflow = "";
    history.replaceState(null, "", location.pathname + location.search);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function renderPanel() {
    const item = leads.find(i => i.id === openId);
    if (!item) { closePanel(); return; }
    const open = item.roles.filter(r => r.status === "open");
    const links = [
      item.website && `<a href="${esc(item.website)}" target="_blank" rel="noopener noreferrer">Website ↗</a>`,
      item.linkedinPage && `<a href="${esc(item.linkedinPage)}" target="_blank" rel="noopener noreferrer">Company LinkedIn ↗</a>`,
      item.boardUrl && `<a href="${esc(item.boardUrl)}" target="_blank" rel="noopener noreferrer">Job board ↗</a>`,
      item.profileUrl && item.profileUrl !== item.boardUrl && `<a href="${esc(item.profileUrl)}" target="_blank" rel="noopener noreferrer">YC profile ↗</a>`,
    ].filter(Boolean).join("");
    const tabBtn = (t, label) => `<button class="tab" role="tab" id="ptab-${t}" aria-controls="pbody" aria-selected="${panelTab === t}" tabindex="${panelTab === t ? 0 : -1}" data-ptab="${t}">${label}</button>`;
    const prevScroll = $("pbody")?.scrollTop || 0;
    $("panel").innerHTML = `
      <header>
        <div class="ptop">
          <span class="logo" aria-hidden="true">${item.logo ? `<img src="${esc(item.logo)}" alt="" onerror="this.replaceWith(document.createTextNode('${esc(initials(item.company))}'))">` : esc(initials(item.company))}</span>
          <div>
            <h2 id="panelTitle">${esc(item.company)}</h2>
            <div class="sub">${item.country ? `${flag(item.country)} ${esc(item.country)}` : "Global remote"} · ${esc(item.remoteScope)}${item.batch ? ` · ${esc(item.batch)}` : ""}
              ${item.status === "closed" ? '<span class="badge closed">No longer hiring</span>' : ""}${isNew(item.firstSeen) ? '<span class="badge new">New</span>' : ""}</div>
          </div>
          <button type="button" class="iconbtn close" id="panelClose" aria-label="Close details">×</button>
        </div>
        ${item.oneLiner ? `<p class="muted" style="margin:16px 0 0">${esc(item.oneLiner)}</p>` : ""}
        ${item.techStack.length ? `<div class="tags">${item.techStack.map(t => `<span class="tag mono">${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="links">${links}</div>
        <div class="ptabs" role="tablist" aria-label="Company details">${tabBtn("roles", `Roles <span class="n">${open.length}</span>`)}${tabBtn("people", `People <span class="n">${item.contacts.length}</span>`)}${tabBtn("outreach", "Outreach")}</div>
      </header>
      <div class="body" id="pbody" role="tabpanel" aria-labelledby="ptab-${panelTab}">${panelTab === "roles" ? rolesHtml(item) : panelTab === "people" ? peopleHtml(item) : outreachHtml(item)}</div>`;
    $("pbody").scrollTop = prevScroll;
    if (panelTab === "outreach") $("pitch").addEventListener("input", syncMailto);
  }

  function rolesHtml(item) {
    if (!item.roles.length) return '<p class="muted">No roles on record.</p>';
    return item.roles.map(r => {
      const closed = r.status === "closed";
      const meta = [r.remoteScope, TRACK_SHORT[r.track] || r.track, r.experience, r.postedAt ? `posted ${fmtDate(r.postedAt)}` : `seen ${fmtDate(r.firstSeen)}`,
        OTHERS.includes(r.src) || ["jobicy", "arbeitnow"].includes(r.src) ? `via ${SOURCE_LABEL[r.src]}` : ""].filter(Boolean).map(esc).join(" · ");
      const sal = r.salary ? `<span class="mono" ${r.salary.unclear ? 'title="Units unclear in the source listing; shown exactly as listed"' : ""}>${esc(r.salary.text)}${r.salary.unclear ? ' <span class="muted">(as listed)</span>' : ""}</span>` : "";
      return `<div class="role${closed ? " closed" : ""}">
        <div class="rt"><span class="title">${esc(r.title)}</span>${r.category === "Internship" ? '<span class="badge intern">Internship</span>' : '<span class="badge soft">Job</span>'}${!closed && isNew(r.firstSeen) ? '<span class="badge new">New</span>' : ""}</div>
        <div class="meta">${meta}${sal ? " · " + sal : ""}</div>
        ${closed ? `<div class="why">Closed: ${esc(r.closedReason || "no longer listed")}${r.closedAt ? ` · ${esc(fmtDate(r.closedAt))}` : ""}</div>` : ""}
        <div class="acts">
          ${r.url ? `<a class="btn sm${closed ? "" : " primary"}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${closed ? "Listing" : "Apply"} ↗</a>` : ""}
          ${r.applyUrl ? `<a class="btn sm" href="${esc(r.applyUrl)}" target="_blank" rel="noopener noreferrer">Direct ↗</a>` : ""}
          <a class="btn sm" href="https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(item.company + " " + r.title)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>
        </div>
      </div>`;
    }).join("");
  }

  function statusSelect(item, p) {
    const st = statusOf(item, p);
    return `<label class="sr-only" for="st-${esc(contactKey(item.id, p))}">Status for ${esc(p.name)}</label>
      <select class="statussel st-${st.split(" ")[0].toLowerCase()}" id="st-${esc(contactKey(item.id, p))}" data-status-key="${esc(contactKey(item.id, p))}">${STATUSES.map(s => `<option ${s === st ? "selected" : ""}>${s}</option>`).join("")}</select>`;
  }
  function contactWays(item, p) {
    const phone = p.phone || item.hqPhone;
    return [
      p.email ? `<span><button type="button" class="copy" data-copy="${esc(p.email)}" title="Copy email">${esc(p.email)}</button> · <a href="mailto:${esc(p.email)}">mail ↗</a></span>` : '<span class="muted">No email on record</span>',
      phone ? `<span><button type="button" class="copy" data-copy="${esc(phone)}" title="Copy phone">${esc(phone)}</button> <span class="muted">${p.phone ? "direct" : "HQ line"}</span> · <a href="${esc(telHref(phone))}">call</a></span>` : "",
      p.linkedin ? `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>` : `<a href="${esc(linkedInPeople(item.company, p.name))}" target="_blank" rel="noopener noreferrer">Find on LinkedIn ↗</a>`,
      p.twitter ? `<a href="${esc(p.twitter)}" target="_blank" rel="noopener noreferrer">X ↗</a>` : "",
      p.hn ? `<a href="${esc(p.hn)}" target="_blank" rel="noopener noreferrer">HN ↗</a>` : "",
    ].filter(Boolean).join("");
  }

  function peopleHtml(item) {
    const groups = {};
    for (const p of item.contacts) (groups[p.tier] ||= []).push(p);
    const label = { "C-Suite": "C-Suite", "Talent & HR": "Talent & HR", Partnerships: "Partnerships", Leadership: "Leadership & other" };
    let html = Object.keys(TIER_ORDER).filter(t => groups[t]).map(t => `<h3 class="sect">${label[t]} · ${groups[t].length}</h3>` +
      groups[t].map(p => `<div class="person"><div><div class="pn">${esc(p.name)}</div><div class="pt">${esc(p.title || "")}${p.location ? ` · ${esc(p.location)}` : ""}</div></div>
        <div>${statusSelect(item, p)}</div><div class="pc">${contactWays(item, p)}</div></div>`).join("")).join("");
    if (!item.contacts.length) {
      html = `<h3 class="sect">No named contact yet</h3><p class="muted">Find the decision-makers on LinkedIn:</p>
        <div class="btnrow">${["CEO", "CTO", "founder"].map(r => `<a class="btn sm" href="${esc(linkedInPeople(item.company, r))}" target="_blank" rel="noopener noreferrer">Find ${r === "founder" ? "founders" : r} ↗</a>`).join("")}</div>`;
    }
    const channels = [
      ...item.companyEmails.map(e => `<span><button type="button" class="copy" data-copy="${esc(e.email)}">${esc(e.email)}</button> <span class="muted">${esc(e.team)}</span></span>`),
      item.hqPhone ? `<span><button type="button" class="copy" data-copy="${esc(item.hqPhone)}">${esc(item.hqPhone)}</button> <span class="muted">HQ</span></span>` : "",
      ...Object.entries(item.social).filter(([k]) => k !== "linkedin").map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(k[0].toUpperCase() + k.slice(1))} ↗</a>`),
      ...Object.entries(item.pages).filter(([k]) => ["contact", "careers", "partners", "team"].includes(k)).map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc({ contact: "Contact page", careers: "Careers page", partners: "Partner page", team: "Team page" }[k])} ↗</a>`),
    ].filter(Boolean);
    if (channels.length) html += `<h3 class="sect">Company channels</h3><div class="person"><div class="pc" style="grid-column:1/-1">${channels.join("")}</div></div>`;
    if (item.contacts.length) html += `<div class="btnrow">${["CEO", "CTO", "founder"].map(r => `<a class="linkbtn" href="${esc(linkedInPeople(item.company, r))}" target="_blank" rel="noopener noreferrer">Find more: ${r === "founder" ? "founders" : r} ↗</a>`).join(" · ")}</div>`;
    return html;
  }

  function pitchFor(item, target) {
    const open = item.roles.filter(r => r.status === "open");
    const first = (target?.name || "there").split(/\s+/)[0];
    const roleTitles = open.slice(0, 3).map(r => r.title).join(", ");
    const track = open[0]?.track || "engineering";
    const subject = `Remote ${track} hiring at ${item.company}`;
    const body = `Hi ${first},\n\nI saw that ${item.company} is hiring remotely for ${roleTitles || "engineering roles"}.\n\nWe work with pre-vetted software and AI engineers who are used to working fully remote across time zones${item.techStack.length ? `, including people shipping production code in ${item.techStack.slice(0, 4).join(", ")}` : ""}. I'd be glad to share a short list of profiles that match these roles.\n\nWould a 15-minute call this week or next be useful?\n\nBest regards,\n`;
    return { subject, body };
  }
  function outreachHtml(item) {
    const withEmail = item.contacts.filter(p => p.email);
    const target = withEmail.find(p => contactKey(item.id, p) === outreachTo) || withEmail.find(p => p.tier === "C-Suite") || withEmail[0] || item.contacts[0];
    if (target) outreachTo = contactKey(item.id, target);
    const { subject, body } = pitchFor(item, target);
    const mailto = target?.email ? `mailto:${encodeURIComponent(target.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : "";
    return `${withEmail.length ? `<div class="field"><label for="pitchTo">To</label><select class="sel" id="pitchTo">${withEmail.map(p => `<option value="${esc(contactKey(item.id, p))}" ${contactKey(item.id, p) === outreachTo ? "selected" : ""}>${esc(p.name)} · ${esc(p.title || p.tier)} · ${esc(p.email)}</option>`).join("")}</select></div>`
      : `<p class="muted">No email on record for this company. Use the People tab or LinkedIn to find the right person; you can still copy the pitch.</p>`}
      <div class="field"><label for="pitch">Pitch (editable)</label><textarea class="pitch" id="pitch">Subject: ${esc(subject)}\n\n${esc(body)}</textarea></div>
      <div class="btnrow">
        <button type="button" class="btn" id="copyPitch">Copy text</button>
        ${mailto ? `<a class="btn primary" id="mailPitch" href="${esc(mailto)}" data-to="${esc(target.email)}">Open in mail app ↗</a>` : ""}
        ${target ? statusSelect(item, target) : ""}
      </div>`;
  }
  function syncMailto() {
    const a = $("mailPitch");
    if (!a) return;
    const m = /^Subject:\s*(.*)\n\n?([\s\S]*)$/.exec($("pitch").value);
    a.href = `mailto:${encodeURIComponent(a.dataset.to)}?subject=${encodeURIComponent(m ? m[1] : "")}&body=${encodeURIComponent(m ? m[2] : $("pitch").value)}`;
  }

  // ---------------------------------------------------------------- Outreach tab (board / table)
  function outreachCompanies() {
    return leads.filter(i => (S.empty || i.roles.some(r => r.status === "open")) && searchMatch(i, S.q));
  }
  function outreachPeople() {
    const out = [];
    for (const item of outreachCompanies()) for (const p of item.contacts) if (!S.team || p.tier === S.team) out.push({ item, p, status: statusOf(item, p) });
    return out;
  }
  function renderOutreach() {
    const people = outreachPeople();
    const companies = new Set(people.map(x => x.item.id)).size;
    const by = s => people.filter(x => x.status === s);
    $("outreachSummary").innerHTML = `<b>${plural(people.length, "contact", "contacts")}</b> at <b>${plural(companies, "company", "companies")}</b> · ${by("Contacted").length} contacted · ${by("Replied").length} replied<span class="grow"></span><span class="muted" style="font-size:13px">Statuses are saved in this browser.</span>`;
    if (!people.length) { $("outreachView").innerHTML = `<div class="empty"><strong>No contacts match.</strong>Clear the search${S.team ? " or choose Everyone" : ""}.</div>`; return; }
    if (S.layout === "board") {
      $("outreachView").innerHTML = `<div class="board">${STATUSES.map(st => {
        const list = by(st);
        return `<section class="col" aria-label="${st}"><h3>${st}<span class="n">${list.length}</span></h3>
          ${list.slice(0, boardShown[st]).map(({ item, p }) => `<div class="card">
            <div class="who">${esc(p.name)}</div><div class="ttl">${esc(p.title || p.tier)}</div>
            <button type="button" class="co" data-open="${esc(item.id)}" data-open-tab="people">${esc(item.company)}${item.status === "closed" ? " (no open roles)" : ` · ${item.openCount} open`}</button>
            <div class="ways">${p.email ? `<button type="button" class="copy" data-copy="${esc(p.email)}">${esc(p.email)}</button>` : ""}${(p.phone || item.hqPhone) ? `<button type="button" class="copy" data-copy="${esc(p.phone || item.hqPhone)}">${esc(p.phone || item.hqPhone)}</button>` : ""}${p.linkedin ? `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>` : ""}</div>
            <div>${statusSelect(item, p)}</div>
          </div>`).join("")}
          ${list.length > boardShown[st] ? `<button type="button" class="btn sm" data-board-more="${st}">Show more (${list.length - boardShown[st]})</button>` : ""}
        </section>`;
      }).join("")}</div>`;
    } else {
      // Table: each company appears once, its contacts listed beside it.
      const byCo = new Map();
      for (const x of people) (byCo.get(x.item.id) || byCo.set(x.item.id, { item: x.item, list: [] }).get(x.item.id)).list.push(x);
      const rows = [];
      for (const { item, list } of [...byCo.values()].sort((a, b) => a.item.company.localeCompare(b.item.company, "en"))) {
        list.forEach(({ p }, i) => {
          const phone = p.phone || item.hqPhone;
          rows.push(`<tr>${i === 0 ? `<td class="co" rowspan="${list.length}"><button type="button" class="linkbtn" data-open="${esc(item.id)}" data-open-tab="people"><span class="name">${esc(item.company)}</span></button><div class="muted" style="font-size:13px">${item.country ? `${flag(item.country)} ${esc(item.country)}` : "Global remote"} · ${item.openCount} open roles</div></td>` : ""}
            <td><strong>${esc(p.name)}</strong><div class="muted" style="font-size:13px">${esc(p.title || "")} · ${esc(p.tier)}</div></td>
            <td>${p.email ? `<button type="button" class="copy" data-copy="${esc(p.email)}">${esc(p.email)}</button>` : "—"}</td>
            <td>${phone ? `<button type="button" class="copy" data-copy="${esc(phone)}">${esc(phone)}</button><div class="muted" style="font-size:12px">${p.phone ? "direct" : "HQ line"}</div>` : "—"}</td>
            <td>${p.linkedin ? `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>` : `<a href="${esc(linkedInPeople(item.company, p.name))}" target="_blank" rel="noopener noreferrer">Find ↗</a>`}</td>
            <td>${statusSelect(item, p)}</td></tr>`);
        });
      }
      $("outreachView").innerHTML = `<div class="tablewrap"><table class="dir"><thead><tr><th scope="col">Company</th><th scope="col">Person</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">LinkedIn</th><th scope="col">Status</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
    }
  }

  // ---------------------------------------------------------------- What changed tab
  function allEvents() {
    const known = new Set(leads.map(i => i.id));
    return [...localEvents, ...((raw && raw.events) || [])].filter(e => e.local || known.has(e.companyId));
  }
  function renderChanges() {
    const kindOf = e => (/closed/.test(e.type) ? "closed" : "added");
    const events = allEvents().filter(e => !S.kind || kindOf(e) === S.kind).sort((a, b) => String(b.t).localeCompare(String(a.t)));
    const label = e => ({
      company_added: ["Added", e.company], company_closed: ["No longer hiring", e.company], company_reopened: ["Hiring again", e.company],
      job_added: ["New role", `${e.company} · ${e.job}`], job_closed: ["Role closed", `${e.company} · ${e.job}`], job_reopened: ["Role reopened", `${e.company} · ${e.job}`],
    }[e.type] || [e.type, e.company || e.text]);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const bucket = t => { const d = Date.parse(t); return d >= +today ? "Today" : d >= +today - 864e5 ? "Yesterday" : d >= +today - 6 * 864e5 ? "This week" : "Earlier"; };
    const groups = {};
    for (const e of events.slice(0, 300)) (groups[bucket(e.t)] ||= []).push(e);
    $("changesView").innerHTML = Object.keys(groups).length ? ["Today", "Yesterday", "This week", "Earlier"].filter(g => groups[g]).map(g => `<h3>${g}</h3>` + groups[g].map(e => {
      const [what, who] = e.local ? [/closed/.test(e.type) ? "Role closed" : "Live check", e.text] : label(e);
      const canOpen = e.companyId && leads.some(i => i.id === e.companyId);
      return `<div class="ev${kindOf(e) === "closed" ? " closed" : ""}"><time datetime="${esc(e.t)}">${esc(new Date(e.t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}</time>
        <div class="what"><strong>${esc(what)}:</strong> ${canOpen ? `<button type="button" data-open="${esc(e.companyId)}">${esc(who)}</button>` : esc(who)}${e.reason ? `<div class="why">${esc(e.reason)}</div>` : ""}</div></div>`;
    }).join("")).join("") : `<div class="empty"><strong>Nothing has changed yet.</strong>New and closed roles appear here after each hourly update.</div>`;
  }

  // ---------------------------------------------------------------- status bar, toasts
  function updateLiveLabel() {
    if (!raw) return;
    const at = raw.meta.lastVerifyAt || raw.meta.generatedAt;
    const hours = (Date.now() - Date.parse(at)) / 3600e3;
    $("liveDot").className = "dot" + (liveChecking ? " busy" : hours > 3 ? " stale" : "");
    $("updatedText").textContent = liveChecking ? "Checking roles…" : `Updated ${ago(at)}`;
    const mm = String(Math.floor(countdownSeconds / 60)).padStart(2, "0"), ss = String(countdownSeconds % 60).padStart(2, "0");
    $("updated").title = `Server update: hourly (${HOURLY_CRON}). This page re-checks open roles every hour; next check in ${mm}:${ss}.${lastLiveCheck ? ` Last browser check ${ago(lastLiveCheck)}.` : ""}`;
    $("nextCheck").textContent = `next auto ${mm}:${ss}`;
  }
  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 3200);
    while ($("toasts").children.length > 3) $("toasts").firstChild.remove();
  }
  function copy(text) {
    const done = () => toast(`Copied ${text.length > 60 ? "text" : text}`);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    ta.remove();
  }

  // ---------------------------------------------------------------- data loading + hourly live engine
  async function load(force) {
    try {
      const vr = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" }).catch(() => null);
      const version = vr && vr.ok ? (await vr.json()).v : null;
      if (raw && !force && version && version === lastVersion) { updateLiveLabel(); return false; }
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const next = await res.json();
      const before = raw ? new Map(leads.map(i => [i.id, i.status])) : null;
      raw = next; lastVersion = version;
      for (const id of [...liveClosed.keys()]) {
        const job = raw.companies.flatMap(c => c.jobs).find(j => j.id === id);
        if (!job || job.status === "closed") liveClosed.delete(id);
      }
      leads = raw.companies.map(adapt);
      if (before) {
        const added = leads.filter(i => !before.has(i.id)).length;
        const closed = leads.filter(i => before.get(i.id) === "open" && i.status === "closed");
        if (added) toast(`${plural(added, "new startup", "new startups")} added`);
        if (closed.length) toast(`${closed[0].company}${closed.length > 1 ? ` and ${closed.length - 1} more` : ""} stopped hiring`);
      }
      render(); updateLiveLabel();
      return true;
    } catch (e) {
      $("updatedText").textContent = "Offline · retrying";
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

  async function runLiveCheck(manual) {
    if (!raw || liveChecking) return;
    liveChecking = true; updateLiveLabel();
    if (manual) toast("Re-checking every open role against its job board…");
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
        localEvents.unshift({ local: true, t: new Date().toISOString(), type: "job_closed", companyId: c.id, text: `${c.name} · ${j.title}`, reason });
      }
      lastLiveCheck = new Date().toISOString();
      leads = raw.companies.map(adapt);
      render();
      const turnedRed = leads.filter(i => before.get(i.id) === "open" && i.status === "closed");
      if (turnedRed.length) toast(`${turnedRed[0].company} just stopped hiring`);
      else if (manual) toast(found.size ? `${plural(found.size, "role", "roles")} closed since the last update` : "All open roles are still live");
    } finally {
      liveChecking = false; countdownSeconds = 3600; updateLiveLabel();
    }
  }

  // ---------------------------------------------------------------- CSV exports (current Jobs filters)
  function exportCsv(onlyCSuite) {
    const rows = jobRows();
    const head = ["Country", "Region", "Startup", "Status", "Remote scope", "Open remote tech roles", "Tracks", "Contact name", "Contact title", "Tier", "Email", "Phone", "Phone type", "LinkedIn", "Company emails", "Company LinkedIn", "Job board", "Sources", "Contact status"];
    const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out = [head.map(cell).join(",")];
    for (const item of rows) {
      const roles = item.visibleRoles.filter(r => r.status === "open");
      const base = [item.country || "Global", item.region || "Global", item.company, item.status === "open" ? "Hiring" : "No longer hiring", item.remoteScope,
        roles.map(r => `${r.title} [${r.category}] <${r.url}>`).join(" | "), [...new Set(roles.map(r => r.track))].join(" | ")];
      const tail = [item.companyEmails.map(e => e.email).join(" | "), item.linkedinPage, item.boardUrl, item.sources.map(s => SOURCE_LABEL[s] || s).join(" | ")];
      const people = onlyCSuite ? item.contacts.filter(p => p.tier === "C-Suite") : item.contacts;
      if (!people.length) { if (!onlyCSuite) out.push([...base, "", "", "", "", item.hqPhone, item.hqPhone ? "HQ line" : "", "", ...tail, ""].map(cell).join(",")); continue; }
      for (const p of people) out.push([...base, p.name, p.title, p.tier, p.email, p.phone || item.hqPhone, p.phone ? "Direct" : item.hqPhone ? "HQ line" : "", p.linkedin, ...tail, statusOf(item, p)].map(cell).join(","));
    }
    const blob = new Blob(["﻿" + out.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: onlyCSuite ? "startup_leads_csuite_contacts.csv" : "startup_leads_remote_tech.csv" });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${plural(out.length - 1, "row", "rows")}`);
  }

  // ---------------------------------------------------------------- popovers, menu, sheet
  const pops = [["regionBtn", "regionPop"], ["moreBtn", "morePop"], ["menuBtn", "menu"]];
  function closePops(except) {
    for (const [b, p] of pops) if (p !== except) { $(p).hidden = true; $(b).setAttribute("aria-expanded", "false"); }
  }
  function togglePop(btnId, popId) {
    const open = $(popId).hidden;
    closePops(popId);
    $(popId).hidden = !open;
    $(btnId).setAttribute("aria-expanded", String(open));
    if (open && popId === "regionPop") renderRegionPop();
    if (open) ($(popId).querySelector('[aria-checked="true"], button, a, select, input') || $(popId)).focus();
  }
  function setSheet(open) {
    $("filters").classList.toggle("open", open);
    $("filtersToggle").setAttribute("aria-expanded", String(open));
    if (!openId) $("scrim").hidden = !open;
    if (open) $("sheetDone").focus(); else $("filtersToggle").focus();
  }
  const isMobile = () => matchMedia("(max-width: 760px)").matches;

  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    $("themeHint").textContent = dark ? "dark" : "light";
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    applyTheme(store.get(THEME_KEY, null));
    let qTimer;
    $("q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => set({ q: e.target.value.trim() }), 150); });
    $("track").addEventListener("change", e => set({ track: e.target.value }));
    $("sort").addEventListener("change", e => set({ sort: e.target.value }));
    $("source").addEventListener("change", e => set({ source: e.target.value }));
    document.querySelectorAll('input[name="has"]').forEach(i => i.addEventListener("change", () => set({ has: [...document.querySelectorAll('input[name="has"]:checked')].map(x => x.value) })));
    $("showEmpty").addEventListener("change", e => set({ empty: e.target.checked }));
    const segs = [["typeSeg", "type"], ["teamSeg", "team"], ["layoutSeg", "layout"], ["changeSeg", "kind"]];
    for (const [id, key] of segs) $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (b) set({ [key]: b.dataset[key === "kind" ? "kind" : key] ?? "" }); });
    document.querySelector('[role="tablist"]').addEventListener("click", e => { const t = e.target.closest("[data-tab]"); if (t) { set({ tab: t.dataset.tab }); t.focus(); } });
    document.querySelector('[role="tablist"]').addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const tabs = ["jobs", "outreach", "changes"]; let i = tabs.indexOf(S.tab);
      i = e.key === "Home" ? 0 : e.key === "End" ? 2 : (i + (e.key === "ArrowRight" ? 1 : 2)) % 3;
      set({ tab: tabs[i] }); $("tab-" + tabs[i]).focus(); e.preventDefault();
    });
    $("regionBtn").addEventListener("click", () => togglePop("regionBtn", "regionPop"));
    $("moreBtn").addEventListener("click", () => togglePop("moreBtn", "morePop"));
    $("menuBtn").addEventListener("click", () => togglePop("menuBtn", "menu"));
    $("regionPop").addEventListener("click", e => {
      const o = e.target.closest("[data-region-set]");
      if (!o) return;
      set(JSON.parse(o.dataset.regionSet));
      if (!isMobile()) closePops(); else renderRegionPop();
      if (!isMobile()) $("regionBtn").focus();
    });
    $("filtersToggle").addEventListener("click", () => setSheet(true));
    $("sheetDone").addEventListener("click", () => { setSheet(false); closePops(); });
    $("syncBtn").addEventListener("click", async () => { closePops(); await load(true); await runLiveCheck(true); });
    $("exportRolesBtn").addEventListener("click", () => { closePops(); exportCsv(false); });
    $("exportContactsBtn").addEventListener("click", () => { closePops(); exportCsv(true); });
    $("themeBtn").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const t = dark ? "light" : "dark"; store.set(THEME_KEY, t); applyTheme(t);
    });
    $("scrim").addEventListener("click", () => (openId ? closePanel() : setSheet(false)));

    document.addEventListener("click", e => {
      if (!e.target.closest(".anchor, #menu, #menuBtn")) closePops();
      const cp = e.target.closest("[data-copy]"); if (cp) { copy(cp.dataset.copy); return; }
      const chip = e.target.closest("[data-chip]"); if (chip) { set(activeFilters()[+chip.dataset.chip].clear); return; }
      if (e.target.closest("#clearAll, [data-clear-all]")) { set({ q: "", region: "", country: "", track: "", type: "", source: "", has: [] }); return; }
      if (e.target.closest("#showMore")) { shown += 40; renderJobs(jobRows()); return; }
      const bm = e.target.closest("[data-board-more]"); if (bm) { boardShown[bm.dataset.boardMore] += 60; renderOutreach(); return; }
      const op = e.target.closest("[data-open]"); if (op) { openPanel(op.dataset.open, op.dataset.openTab || "roles", op); return; }
      const pt = e.target.closest("[data-ptab]"); if (pt) { panelTab = pt.dataset.ptab; history.replaceState(null, "", `#c=${encodeURIComponent(openId)}&t=${panelTab}`); renderPanel(); $("ptab-" + panelTab).focus(); return; }
      if (e.target.closest("#panelClose")) { closePanel(); return; }
      if (e.target.closest("#copyPitch")) { copy($("pitch").value); return; }
    });
    document.addEventListener("change", e => {
      const sel = e.target.closest("[data-status-key]");
      if (sel) {
        statusMap[sel.dataset.statusKey] = sel.value; store.set(STATUS_KEY, statusMap);
        toast(`Marked ${sel.value.toLowerCase()}`);
        if (S.tab === "outreach") renderOutreach();
        if (openId) renderPanel();
        if (S.tab === "jobs" && S.has.includes("uncontacted")) renderJobs(jobRows());
        return;
      }
      if (e.target.id === "pitchTo") { outreachTo = e.target.value; renderPanel(); }
    });
    document.addEventListener("keydown", e => {
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName || "");
      if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); return; }
      if (e.key === "Escape") {
        if (!$("panel").hidden) { closePanel(); return; }
        const openPop = pops.find(([, p]) => !$(p).hidden);
        if (openPop) { closePops(); $(openPop[0]).focus(); return; }
        if ($("filters").classList.contains("open")) { setSheet(false); return; }
      }
      // Keep focus inside the open panel.
      if (e.key === "Tab" && !$("panel").hidden) {
        const f = [...$("panel").querySelectorAll("button, a[href], select, textarea, input")].filter(x => !x.disabled && x.offsetParent !== null);
        if (f.length && e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
        else if (f.length && !e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
      // Arrow keys move between result rows.
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement?.classList.contains("row")) {
        const rows = [...document.querySelectorAll("#results .row")]; const i = rows.indexOf(document.activeElement);
        const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)]; if (next) { e.preventDefault(); next.focus(); }
      }
    });
    window.addEventListener("hashchange", openFromHash);
    window.addEventListener("popstate", () => { readURL(); render(); });

    setInterval(() => {
      countdownSeconds = Math.max(0, countdownSeconds - 1);
      if (countdownSeconds === 0) load(false).then(() => runLiveCheck(false));
      if (!$("menu").hidden || countdownSeconds % 30 === 0) updateLiveLabel();
    }, 1000);
    setInterval(() => load(false), 60 * 1000); // cheap version check; new data shows within a minute of deploy
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });
  }

  function openFromHash() {
    const m = /#c=([^&]+)(?:&t=(roles|people|outreach))?/.exec(location.hash);
    if (m && leads.length) openPanel(decodeURIComponent(m[1]), m[2] || "roles");
  }

  // ---------------------------------------------------------------- boot
  readURL();
  wire();
  load(true).then(ok => {
    if (!ok) return;
    if (raw.meta.repo) $("updaterLink").href = `https://github.com/${raw.meta.repo}/actions/workflows/hourly_sync.yml`;
    openFromHash();
    runLiveCheck(false);
  });
})();
