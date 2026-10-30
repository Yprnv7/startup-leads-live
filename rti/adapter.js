// Runs the RTI Tracker page on Startup Leads' live data.
// The tracker was built for a claude.ai shared store (window.claude.use("db")). On GitHub Pages that
// store doesn't exist, so this adapter provides the same small API over ../data/leads.json:
//   - companies + "Job posting" signals come from the hourly-updated dataset (read-only)
//   - status, notes, India-office changes and imported rows are saved in this browser (localStorage)
//   - "Download Excel" saves the file directly
(() => {
  const DATA_URL = "../data/leads.json";
  const VERSION_URL = "../data/version.json";
  const LOCAL_KEY = "rti.local.v1"; // { overrides: {companyId: patch}, companies: {id: doc}, signals: [doc] }
  const REGION_CODE = { Australia: "AU", Europe: "EU", MEA: "ME", "New Zealand": "NZ", SEA: "SG", UK: "UK", Global: "GL" };
  const SOURCE_LABEL = { yc: "Y Combinator", hn: "HN Who's Hiring", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", jobicy: "Jobicy", arbeitnow: "Arbeitnow", manual: "Manual",
    remotive: "Remotive", remoteok: "Remote OK", workingnomads: "Working Nomads", weworkremotely: "We Work Remotely", nodesk: "NoDesk", jobfound: "Jobfound", himalayas: "Himalayas", workable: "Workable", personio: "Personio", recruitee: "Recruitee", smartrecruiters: "SmartRecruiters" };

  const loadLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch (e) { return {}; } };
  const local = Object.assign({ overrides: {}, companies: {}, signals: [] }, loadLocal());
  const saveLocal = () => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch (e) {} };

  let base = { companies: [], signals: [], meta: null };
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) {} });

  // Who can apply: postings that name India first, then worldwide, then the regions they name.
  function access(job) {
    const p = job.places || [];
    if (job.openToIndia) return "india";
    if (p.includes("Worldwide")) return "world";
    const label = (job.remoteScope || "").replace(/^100% Remote \(|\)$/g, "");
    return label ? `region:${label.replace(/\//g, " / ")} only` : "region:Remote, country not stated";
  }

  function build(data) {
    const companies = [], signals = [];
    for (const c of data.companies) {
      const open = c.jobs.filter(j => j.status === "open" && !j.dup); // same role from two feeds counts once
      const region = REGION_CODE[c.region] || REGION_CODE[(c.markets || [])[0]] || "GL";
      const contacts = (c.contacts || []).map(p => ({ name: p.name, title: p.title || "", email: p.email || "", phone: p.phone || "", linkedin: p.linkedin || "", team: p.team || "" }));
      companies.push({
        id: c.id, name: c.name, website: c.website || "", linkedin: c.linkedin || c.channels?.social?.linkedin || "",
        region, country: c.country || "", location: c.location || c.country || "", headcount: c.teamSize ? String(c.teamSize) : "",
        companyType: "tech", check: "clear",
        checkNote: "No India office found: company location, YC regions and every job location were checked by the hourly updater.",
        status: open.length ? "New" : "Not a fit", notes: "",
        contacts, hqPhone: c.channels?.phones?.[0]?.phone || "", companyEmails: (c.channels?.emails || []).map(e => e.email),
        openRoles: open.map(j => j.title),
        firstSeen: (c.firstSeen || "").slice(0, 10), source: SOURCE_LABEL[c.source] || c.source, websiteCheck: c.website ? "verified" : undefined,
      });
      for (const j of open) {
        signals.push({
          id: j.id, companyId: c.id, companyName: c.name, region, type: "Job posting",
          summary: `Hiring: ${j.title}${j.type === "internship" ? " (internship)" : ""} — ${j.remoteScope || "100% Remote"}${j.track ? ` · ${j.track}` : ""}`,
          date: (j.postedAt || j.firstSeen || "").slice(0, 10), url: j.url, source: SOURCE_LABEL[j.src] || j.src, access: access(j),
        });
      }
    }
    base = { companies, signals, meta: data.meta };
  }

  const merged = name => {
    if (name === "companies") {
      const all = [...base.companies, ...Object.values(local.companies).filter(x => !base.companies.some(b => b.id === x.id))];
      return all.map(c => ({ ...c, ...(local.overrides[c.id] || {}) }));
    }
    if (name === "signals") return [...local.signals, ...base.signals];
    if (name === "jobruns") return base.meta ? [jobRun(base.meta)] : [];
    return []; // news, freelance: not collected by Startup Leads
  };

  // Sources tab: the last result of every source (they run hourly or every 3-6 hours) and how many
  // of its open roles are on the site right now.
  function jobRun(meta) {
    const stats = meta.sourceStats || {};
    const keptBy = {};
    for (const sig of base.signals) keptBy[sig.source] = (keptBy[sig.source] || 0) + 1;
    const label = k => (k === "ats" ? "Company job boards" : SOURCE_LABEL[k] || k);
    const sources = {};
    for (const [k, v] of Object.entries(stats)) {
      const when = v.at ? new Date(v.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      // "Failed" only when nothing could be read; a partly read feed still counts.
      const status = kept => (v.read ? (kept ? "ok" : "empty") : v.ok ? "empty" : "failed");
      const note = [v.note, !v.ok && v.read ? "partly read" : "", when && `last read ${when}`].filter(Boolean).join(" · ");
      if (k === "ats") {
        // One row per job-board platform, so "Saved postings" matches each role's source.
        for (const l of ["Greenhouse", "Lever", "Ashby"]) sources[l] = { status: status(keptBy[l] || 0), read: keptBy[l] || 0, kept: keptBy[l] || 0, note: `part of ${v.read || 0} startup job boards · last read ${when}` };
        continue;
      }
      const kept = keptBy[label(k)] || 0;
      sources[label(k)] = { status: status(kept), read: v.read || 0, kept, note };
    }
    return { id: "latest", at: meta.generatedAt, sources };
  }

  const snap = docs => ({ docs: docs.map(d => ({ id: d.id, data: () => { const { id, ...rest } = d; return rest; } })) });

  function query(name, filters = [], order = null, max = 1e9) {
    const run = () => {
      let rows = merged(name).filter(r => filters.every(([f, v]) => r[f] === v));
      if (order) rows = [...rows].sort((a, b) => String(b[order] || "").localeCompare(String(a[order] || "")));
      return rows.slice(0, max);
    };
    const q = {
      where: (f, op, v) => query(name, [...filters, [f, v]], order, max),
      orderBy: f => query(name, filters, f, max),
      limit: n => query(name, filters, order, n),
      get: async () => snap(run()),
      onSnapshot(cb) { const fn = () => cb(snap(run())); listeners.add(fn); if (base.meta) fn(); return () => listeners.delete(fn); },
      add: async doc => { const id = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7); if (name === "signals") local.signals.unshift({ id, ...doc }); saveLocal(); notify(); return { id }; },
    };
    return q;
  }

  const db = {
    collection: name => query(name),
    doc(path) {
      const [col, id] = path.split("/");
      return {
        async set(doc) { if (col === "companies") { local.companies[id] = { id, ...doc }; saveLocal(); notify(); } },
        async update(patch) { if (col === "companies") { local.overrides[id] = { ...(local.overrides[id] || {}), ...patch }; saveLocal(); notify(); } },
        onSnapshot(cb) {
          const fn = () => {
            const m = base.meta;
            const data = m ? { lastRun: m.generatedAt, summary: `${base.companies.length} companies · ${base.signals.length} open remote roles · Startup Leads data, refreshed hourly` } : null;
            cb({ exists: !!data, data: () => data });
          };
          if (path === "meta/run") { listeners.add(fn); if (base.meta) fn(); }
          return () => listeners.delete(fn);
        },
      };
    },
  };

  const downloads = {
    async save({ filename, data }) {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(data), download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
  };

  window.claude = { use: async name => (name === "db" ? db : name === "downloads" ? downloads : null) };

  let version = null;
  async function refresh() {
    try {
      const v = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (v && v.v === version) return;
      const data = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
      version = v && v.v;
      build(data);
      notify();
    } catch (e) {
      const el = document.getElementById("loading");
      if (el && !base.meta) el.innerHTML = "<strong>The tracker could not load.</strong>Reload the page to try again.";
    }
  }
  refresh();
  setInterval(refresh, 60 * 1000);
})();
