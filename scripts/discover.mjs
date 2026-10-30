#!/usr/bin/env node
// Deeper search: finds more companies hiring interns in the five countries, and their job boards.
//
//   1. Prospeo company search (needs PROSPEO_API_KEY): companies in the UK, Germany, Australia,
//      Singapore or the UAE whose job postings include an internship, in software / IT / internet /
//      security / fintech, up to 1000 people. 1 credit per page of 25; the whole list is re-read weekly.
//   2. Each company's job board: links on its own website or careers page, or a board whose company
//      name matches on Greenhouse, Lever, Ashby, Workable, Recruitee or SmartRecruiters.
//   3. Boards found are added to data/state.json (boards); update.mjs reads them every run and keeps
//      only 100% remote tech internships, like every other source.
//   4. Headquarters for companies whose remote internships are open worldwide / Europe-wide / APAC-wide
//      but whose location the job feeds don't give (state.hqCandidates, from update.mjs): a Prospeo
//      company lookup, accepted only when the name matches and Prospeo lists one of the same open roles.
//      If the company is based in one of the five countries, those internships count for it.
//
//   node scripts/discover.mjs            flags: --detect-limit=N

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_COUNTRIES } from './markets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'data/state.json');
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const cfg = config.discovery || {};
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const API_KEY = process.env.PROSPEO_API_KEY;
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const DAY = 86400e3;
const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
state.boards ??= [];
state.prospeo ??= { credits: {} };
const disc = (state.discovery ??= { page: 0, totalPages: null, cycleAt: null, companies: {} });
const report = {};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const domainOf = u => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const TWO_PART_TLD = /\.(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;
const registrable = d => d.split('.').slice(TWO_PART_TLD.test(d) ? -3 : -2).join('.');
const normName = s => String(s || '').toLowerCase().replace(/\|.*$/, '').replace(/\b(gmbh|ag|ab|ltd|limited|inc|plc|oy|bv|sas|sa|llc|pte|group|technologies|holdings|uk|au|sg|de)\b|\(.*?\)|[^a-z0-9]/g, '');
const sameCompany = (a, b) => { const x = normName(a), y = normName(b); return x.length >= 3 && y.length >= 3 && (x === y || (Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x)))); };

// ---------------------------------------------------------------- 1. Prospeo company search

async function prospeo(endpoint, body) {
  for (let attempt = 0; ; attempt++) {
    await sleep(1200);
    const res = await fetch(`https://api.prospeo.io/${endpoint}`, {
      method: 'POST', headers: { 'X-KEY': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 4) { await sleep(15000 * (attempt + 1)); continue; }
    if (!res.ok || json.error) throw new Error(`${endpoint}: HTTP ${res.status} ${json.error_code || json.message || ''}`);
    return json;
  }
}

const FILTERS = {
  company_location_search: { include: SCOPE_COUNTRIES },
  company_job_posting_hiring_for: { include: ['intern', 'internship', 'praktikum', 'praktikant'], match_type: 'contains' },
  company_headcount_range: ['1-10', '11-20', '21-50', '51-100', '101-200', '201-500', '501-1000'],
  company_industry: { include: ['Software Development', 'IT Services and IT Consulting', 'Technology, Information and Internet', 'Computer and Network Security', 'Financial Services', 'Internet Marketplace Platforms', 'Data Infrastructure and Analytics'] },
};

async function searchCompanies() {
  if (!API_KEY) { report.search = { skipped: 'PROSPEO_API_KEY not set' }; return; }
  state.prospeo.discoveryCredits ??= {};
  const used = () => state.prospeo.discoveryCredits[TODAY] || 0;
  // A new pass over the whole list every 7 days picks up companies that started hiring interns.
  if (!disc.cycleAt || Date.now() - Date.parse(disc.cycleAt) > 7 * DAY) { disc.cycleAt = NOW; disc.page = 0; disc.totalPages = null; }
  let pages = 0, added = 0;
  while ((disc.totalPages === null || disc.page < disc.totalPages) && pages < (cfg.prospeoPagesPerRun ?? 25) && used() < (cfg.prospeoDailyCredits ?? 60)) {
    let r;
    try { r = await prospeo('search-company', { page: disc.page + 1, filters: FILTERS }); } catch (e) {
      if (/NO_RESULTS/i.test(e.message)) { disc.totalPages = disc.page; break; }
      report.search = { error: e.message, pages, added }; return;
    }
    state.prospeo.discoveryCredits[TODAY] = used() + 1;
    pages++; disc.page++;
    disc.totalPages = r.pagination?.total_page ?? disc.page;
    for (const x of r.results || []) {
      const co = x.company || {};
      const domain = domainOf(co.website || co.domain || '');
      if (!domain || !SCOPE_COUNTRIES.includes(co.location?.country)) continue;
      if (!disc.companies[domain]) { disc.companies[domain] = { name: co.name, website: co.website || `https://${domain}`, country: co.location.country, city: co.location.city || undefined, linkedin: co.linkedin_url || undefined, prospeoId: co.company_id, foundAt: NOW }; added++; }
    }
  }
  report.search = { pages, newCompanies: added, page: disc.page, totalPages: disc.totalPages, known: Object.keys(disc.companies).length, creditsToday: used() };
}

// ---------------------------------------------------------------- 2. job-board detection

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
async function getText(url, accept = 'text/html') {
  try {
    const r = await fetch(url, { headers: { ...UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { status: r.status, ok: r.ok, url: r.url, body: r.ok ? (await r.text()).slice(0, 2_000_000) : '' };
  } catch { return { status: 0, ok: false, body: '' }; }
}
const getJson = async url => { const r = await getText(url, 'application/json'); try { return r.ok ? JSON.parse(r.body) : null; } catch { return null; } };

const ATS_LINKS = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/gi],
  ['greenhouse', /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/gi],
  ['lever', /jobs\.(eu\.)?lever\.co\/([a-z0-9_.-]+)/gi],
  ['ashby', /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/gi],
  ['workable', /apply\.workable\.com\/([a-z0-9_-]+)/gi],
  ['personio', /\/\/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/gi],
  ['recruitee', /\/\/([a-z0-9-]+)\.recruitee\.com/gi],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/gi],
];
const NOT_A_TOKEN = /^(embed|v1|v0|api|j|apply|jobs|js|careers|www|app|static|assets|widget|boards|job|accounts|undefined)$/i;

function boardsInHtml(html) {
  const out = new Map();
  for (const [ats, re] of ATS_LINKS) for (const m of html.matchAll(re)) {
    const eu = ats === 'lever' && !!m[1];
    const token = (ats === 'lever' ? m[2] : m[1]).toLowerCase();
    if (!NOT_A_TOKEN.test(token)) out.set(`${ats}:${token}`, { ats, token, ...(eu ? { eu: true } : {}) });
  }
  return [...out.values()];
}

// Links found on the company's own pages (same domain, or careers. / jobs. subdomains only).
async function boardsFromWebsite(co) {
  const own = registrable(domainOf(co.website) || '');
  const home = await getText(co.website);
  if (!home.ok) return [];
  let found = boardsInHtml(home.body);
  if (found.length) return found;
  const links = [...home.body.matchAll(/href=["']([^"'#]+)["']/gi)]
    .map(m => { try { return new URL(m[1], home.url); } catch { return null; } })
    .filter(u => u && /^https?:$/.test(u.protocol) && registrable(u.hostname.replace(/^www\./, '')) === own && /career|jobs|join|karriere|work-with-us|vacanc|hiring|stellen|open-roles|positions/i.test(u.href))
    .map(u => u.origin + u.pathname);
  const origin = new URL(home.url).origin;
  for (const u of [...new Set([...links, `${origin}/careers`, `${origin}/jobs`, `${origin}/karriere`])].slice(0, 4)) {
    const p = await getText(u);
    if (!p.ok) continue;
    found = boardsInHtml(`${p.url} ${p.body}`);
    if (found.length) return found;
  }
  return [];
}

// Does this board belong to the company? Its own company name must match, or (where the API has no
// company name) its postings must mention the company or its website. A board name that is the
// company's name or website also counts when the board was linked from the company's own site.
async function boardIsCompany({ ats, token, eu }, co, linkedFromSite = false) {
  const domain = domainOf(co.website);
  const label = normName(domain.split('.')[0]);
  const tok = normName(token);
  if (linkedFromSite && tok.length >= 3 && (tok.includes(label) || label.includes(tok) || sameCompany(token, co.name))) return true;
  const mentions = text => { const t = String(text || '').toLowerCase(); return t.includes(domain) || (normName(co.name).length >= 4 && t.replace(/[^a-z0-9]/g, '').includes(normName(co.name))); };
  const t = encodeURIComponent(token);
  if (ats === 'greenhouse') { const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}`); return !!r?.name && sameCompany(r.name, co.name); }
  if (ats === 'workable') { const r = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${t}`); return !!r?.name && sameCompany(r.name, co.name); }
  if (ats === 'ashby') { const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${t}`); return !!r?.jobs?.length && r.jobs.slice(0, 5).some(j => mentions(j.descriptionPlain)); }
  if (ats === 'lever') { const r = await getJson(`https://api.${eu ? 'eu.' : ''}lever.co/v0/postings/${t}?mode=json&limit=5`); return Array.isArray(r) && r.some(j => mentions(`${j.descriptionPlain} ${j.additionalPlain}`)); }
  if (ats === 'recruitee') { const r = await getJson(`https://${t}.recruitee.com/api/offers/`); return !!r?.offers?.some(o => sameCompany(o.company_name, co.name)); }
  if (ats === 'smartrecruiters') { const r = await getJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=5`); return !!r?.content?.some(p => sameCompany(p.company?.name, co.name)); }
  return false; // personio: only accepted by name (above)
}

// No link on the site: try the company's website label and name as a board name on each system.
async function guessBoards(co) {
  const label = domainOf(co.website).split('.')[0];
  const words = String(co.name).replace(/\|.*$/, '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').trim();
  const tokens = [...new Set([label, words.replace(/\s+/g, ''), words.replace(/\s+/g, '-')].filter(t => t.length >= 3))].slice(0, 3);
  for (const token of tokens) for (const ats of ['greenhouse', 'workable', 'ashby', 'lever', 'recruitee', 'smartrecruiters']) {
    if (await boardIsCompany({ ats, token }, co)) return [{ ats, token }];
  }
  return [];
}

async function detectBoards() {
  const known = new Set([...config.ats.boards, ...state.boards].map(b => `${b.ats}:${b.token}`.toLowerCase()));
  const due = Object.entries(disc.companies).filter(([, c]) => !c.checkedAt).slice(0, +(args['detect-limit'] || cfg.detectPerRun || 150));
  let withBoard = 0, newBoards = 0;
  const queue = [...due];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const [domain, co] = queue.shift();
      let boards = [];
      try {
        boards = [];
        for (const b of await boardsFromWebsite(co)) if (await boardIsCompany(b, co, true)) boards.push(b);
        co.via = boards.length ? 'website' : undefined;
        if (!boards.length) { boards = await guessBoards(co); co.via = boards.length ? 'matched board name' : undefined; }
      } catch { boards = []; }
      co.checkedAt = NOW;
      co.boards = boards.map(b => `${b.ats}:${b.token}`);
      if (boards.length) withBoard++;
      for (const b of boards) {
        const key = `${b.ats}:${b.token}`.toLowerCase();
        if (known.has(key)) continue;
        known.add(key);
        state.boards.push({ ...b, name: co.name, website: co.website, location: [co.city, co.country].filter(Boolean).join(', '), discovered: NOW, active: true, via: 'prospeo', domain });
        newBoards++;
      }
    }
  }));
  report.boards = { checked: due.length, withBoard, newBoards, waiting: Object.values(disc.companies).filter(c => !c.checkedAt).length, totalDiscoveredBoards: state.boards.filter(b => b.via === 'prospeo').length };
}

const sameTitle = (a, b) => { a = a.toLowerCase(); b = b.toLowerCase(); return a === b || (Math.min(a.length, b.length) > 12 && (a.includes(b) || b.includes(a))); };
async function resolveHeadquarters() {
  if (!API_KEY) return;
  state.hqKnown ??= {};
  state.prospeo.discoveryCredits ??= {};
  const used = () => state.prospeo.discoveryCredits[TODAY] || 0;
  const due = Object.entries(state.hqCandidates || {}).filter(([, c]) => !c.lookedAt).slice(0, cfg.hqLookupsPerRun ?? 20);
  let looked = 0, confirmed = 0;
  for (const [key, cand] of due) {
    if (used() >= (cfg.prospeoDailyCredits ?? 60)) break;
    let r;
    try { r = await prospeo('enrich-company', { data: { company_name: cand.name } }); } catch (e) {
      if (/NO_MATCH|NOT_FOUND|404/i.test(e.message)) { cand.lookedAt = NOW; cand.result = 'not found'; looked++; continue; }
      report.headquarters = { error: e.message, looked, confirmed }; return;
    }
    looked++;
    cand.lookedAt = NOW;
    if (!r.free_enrichment) state.prospeo.discoveryCredits[TODAY] = used() + 1;
    const co = r.company || r.data?.company;
    const roleMatch = (co?.job_postings?.active_titles || []).some(t => cand.titles.some(x => sameTitle(x, t)));
    if (!co || !sameCompany(co.name, cand.name) || !roleMatch || !co.location?.country) { cand.result = 'not confirmed'; continue; }
    state.hqKnown[key] = { name: co.name, country: co.location.country, countryCode: co.location.country_code, website: co.website || undefined, at: NOW };
    cand.result = co.location.country;
    confirmed++;
  }
  report.headquarters = { looked, confirmed, waiting: Object.values(state.hqCandidates || {}).filter(c => !c.lookedAt).length };
}

await searchCompanies();
await detectBoards();
await resolveHeadquarters();
for (const d of Object.keys(state.prospeo.discoveryCredits || {})) if (Date.now() - Date.parse(d) > 30 * DAY) delete state.prospeo.discoveryCredits[d];
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1));
console.log(JSON.stringify(report, null, 2));
