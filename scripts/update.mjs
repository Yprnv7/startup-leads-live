#!/usr/bin/env node
// Discovers new startup jobs/internships + founder contacts and re-verifies every
// tracked job. Runs on GitHub Actions; writes data/leads.json for the dashboard.
//
//   node scripts/update.mjs --mode=discover   # daily: add new companies, then verify
//   node scripts/update.mjs --mode=verify     # frequent: liveness checks (+ new HN posts)
//   flags: --force-yc (re-check YC pages now), --yc-limit=N
//
// A job is only ever marked closed on positive evidence (source fetched OK and the
// job is gone / says filled). Network errors never close anything.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketsOf, companyMarkets, isFocus, isUsOnly, FOCUS } from './markets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEADS_FILE = path.join(ROOT, 'data/leads.json');
const STATE_FILE = path.join(ROOT, 'data/state.json');
const MANUAL_FILE = path.join(ROOT, 'data/manual.json');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const MODE = args.mode === 'discover' ? 'discover' : 'verify';

const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const TECH_RE = new RegExp(config.techRoleRegex, 'i');
const INTERN_RE = new RegExp(config.internRegex, 'i');
const CLOSED_RE = /\b(no longer hiring|not hiring anymore|positions? (?:(?:have|has) been |are |is )?filled|hiring (?:is )?(?:now )?closed|roles? (?:(?:is|are|has been|have been) )?filled|update:? ?filled)\b/i;
const UA = `Mozilla/5.0 (compatible; StartupLeadsBot/1.0; +https://github.com/${config.repo})`;

const now = new Date();
const NOW = now.toISOString();
const TODAY = NOW.slice(0, 10);
const DAY = 86400e3;

const readJSON = async (f, fallback) => {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; }
};

const db = await readJSON(LEADS_FILE, { meta: {}, companies: [], events: [], history: [] });
const state = await readJSON(STATE_FILE, { ycSkipped: {}, boards: [], boardNames: {}, zeroMiss: {} });
const manual = await readJSON(MANUAL_FILE, []);
const firstRun = db.companies.length === 0;

const byId = new Map(db.companies.map(c => [c.id, c]));
const byDomain = new Map();
for (const c of db.companies) if (c.domain && !byDomain.has(c.domain)) byDomain.set(c.domain, c.id);
const prevStatus = new Map(db.companies.map(c => [c.id, c.status]));
const sourceReport = {};
const today = { companiesAdded: 0, companiesClosed: 0, jobsAdded: 0, jobsClosed: 0 };

// ---------------------------------------------------------------- helpers

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { timeout = 25000, retries = 2, json = false } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let body = text;
      if (json && res.ok) body = JSON.parse(text);
      return { ok: res.ok, status: res.status, body, finalUrl: res.url };
    } catch (err) {
      if (attempt === retries) return { ok: false, status: 0, error: String(err.message || err) };
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => String(s ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const stripHtml = s => decode(String(s ?? '').replace(/<p>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');

function event(type, company, job, extra = {}) {
  db.events.unshift({ t: NOW, type, companyId: company.id, company: company.name, job: job?.title, ...extra });
}

function upsertCompany(id, fields) {
  let c = byId.get(id);
  if (!c) {
    c = { id, name: fields.name, firstSeen: NOW, status: 'open', closedAt: null, contacts: [], jobs: [], sources: [] };
    byId.set(id, c);
    db.companies.push(c);
    today.companiesAdded++;
    event('company_added', { id, name: fields.name });
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'source' && c.source) continue; // keep the primary source
    c[k] = v;
  }
  if (fields.source && !c.sources.includes(fields.source)) c.sources.push(fields.source);
  if (c.website) {
    c.domain = domainOf(c.website);
    if (c.domain && !byDomain.has(c.domain)) byDomain.set(c.domain, id);
  }
  return c;
}

function addContact(company, contact) {
  const key = (contact.linkedin || contact.email || contact.hn || contact.name || '').toLowerCase();
  if (!key) return;
  const existing = company.contacts.find(x => (x.linkedin || x.email || x.hn || x.name || '').toLowerCase() === key);
  if (existing) Object.assign(existing, Object.fromEntries(Object.entries(contact).filter(([, v]) => v)));
  else company.contacts.push(contact);
}

function upsertJob(company, job) {
  job.markets = marketsOf(job.location || company.location);
  let j = company.jobs.find(x => x.id === job.id);
  if (!j) {
    j = { ...job, firstSeen: NOW, status: 'open', closedAt: null };
    company.jobs.push(j);
    today.jobsAdded++;
    if (company.firstSeen !== NOW) event('job_added', company, j);
    return j;
  }
  Object.assign(j, job);
  if (j.status === 'closed') {
    j.status = 'open'; j.closedAt = null; delete j.closedReason;
    event('job_reopened', company, j);
  }
  return j;
}

function closeJob(company, job, reason) {
  if (job.status === 'closed') return;
  job.status = 'closed';
  job.closedAt = NOW;
  job.closedReason = reason;
  today.jobsClosed++;
  event('job_closed', company, job, { reason });
}

// Close jobs belonging to `matches` that were not seen in the fresh listing.
function reconcile(company, matches, presentIds, reason) {
  for (const j of company.jobs) if (matches(j) && !presentIds.has(j.id)) closeJob(company, j, reason);
}

const jobType = (title, extra = '') => (INTERN_RE.test(`${title} ${extra}`) ? 'internship' : 'job');

// "Pure tech": software, data, AI/ML, infra, security, QA, embedded, IT. Not sales, ops, HR,
// marketing, PM/design, or non-software engineering (mechanical, electrical, manufacturing...).
const TECH_POS_RE = /\b(software|engineer(?:ing|s)?|developer|dev|sde|swe|programmer|full[- ]?stack|front[- ]?end|back[- ]?end|web|mobile|ios|android|flutter|react|node(?:\.?js)?|python|java|golang|rust|c\+\+|typescript|devops|sre|site reliability|platform|infrastructure|infra|cloud|kubernetes|data (?:engineer|scientist|science|analyst|analytics|platform)|machine learning|ml|ai|llm|deep learning|computer vision|nlp|research (?:engineer|scientist)|applied scientist|security|cyber ?security|appsec|qa|quality assurance|sdet|test automation|automation engineer|embedded|firmware|database|dba|architect|tech(?:nical)? lead|cto|it (?:support|admin|engineer)|blockchain|smart contract|game developer|mts|technical staff)\b/i;
const TECH_NEG_RE = /\b(sales|account (?:executive|manager)|business development|bdr|sdr|marketing|marketer|recruit\w*|talent|human resources|hr|people (?:ops|operations|partner)|finance|financial|accountant|accounting|legal|counsel|paralegal|customer (?:success|support|service|experience)|support (?:specialist|agent|associate)|office|executive assistant|copywriter|content|community|partnerships?|solutions? (?:engineer|consultant|architect)|sales engineer|pre-?sales|field (?:engineer|service)|mechanical|electrical|civil|chemical|manufacturing|production|process engineer|quality engineer|construction|technician|driver|warehouse|nurse|clinical|pharmac\w*|mri|medical|physician|teacher|tutor|product (?:manager|owner|designer|marketing)|program manager|project manager|scrum|designer|ux researcher|operations (?:manager|associate|lead)|bizops|chief of staff|growth (?:lead|manager))\b/i;
function isTechRole(j) {
  const text = /^multiple roles/i.test(j.title) ? `${j.title} ${j.snippet || ''}` : j.title;
  return TECH_POS_RE.test(text) && !TECH_NEG_RE.test(j.title);
}

// ---------------------------------------------------------------- YC (founders + jobs)

const SEASON = { winter: 1, spring: 2, summer: 3, fall: 4, autumn: 4 };
const batchRank = b => {
  const m = /(winter|spring|summer|fall|autumn)\s+(\d{4})/i.exec(b || '');
  return m ? +m[2] * 10 + SEASON[m[1].toLowerCase()] : 0;
};

const ycFetchedThisRun = new Set();
async function fetchYC(slug) {
  ycFetchedThisRun.add(slug);
  const res = await get(`https://www.ycombinator.com/companies/${slug}`, { retries: 1 });
  if (res.status === 404) return { gone: true };
  if (!res.ok) return null;
  const m = /data-page="([^"]+)"/.exec(res.body);
  if (!m) return null;
  try {
    const props = JSON.parse(decode(m[1])).props;
    return { company: props.company, jobs: props.jobPostings || [] };
  } catch { return null; }
}

function applyYC(slug, data, listing = {}) {
  const yc = data.company;
  const c = upsertCompany(`yc:${slug}`, {
    name: yc.name,
    source: 'yc',
    website: yc.website,
    logo: yc.small_logo_url || listing.small_logo_thumb_url,
    oneLiner: yc.one_liner,
    location: yc.location || listing.all_locations,
    regions: listing.regions,
    tags: (yc.tags || listing.tags || []).slice(0, 5),
    batch: yc.batch_name || listing.batch,
    teamSize: yc.team_size,
    linkedin: yc.linkedin_url,
    profileUrl: `https://www.ycombinator.com/companies/${slug}`,
  });
  const social = Object.fromEntries(Object.entries({ linkedin: yc.linkedin_url, twitter: yc.twitter_url, facebook: yc.fb_url, github: yc.github_url, crunchbase: yc.cb_url }).filter(([, v]) => v));
  c.channels = { ...c.channels, social: { ...c.channels?.social, ...social } };
  for (const f of yc.founders || []) {
    addContact(c, { name: f.full_name, title: f.title || 'Founder', linkedin: f.linkedin_url, twitter: f.twitter_url, source: 'YC' });
  }
  const present = new Set();
  for (const p of data.jobs) {
    const id = `yc:${p.id}`;
    present.add(id);
    upsertJob(c, {
      id, src: 'yc', title: p.title,
      type: /intern/i.test(p.type || '') ? 'internship' : jobType(p.title),
      location: p.location, salary: p.salaryRange || undefined,
      experience: p.minExperience || undefined,
      url: `https://www.ycombinator.com${p.url}`,
    });
  }
  reconcile(c, j => j.src === 'yc', present, 'Removed from YC job board');
  return c;
}

async function discoverYC() {
  const limit = +(args['yc-limit'] || (firstRun ? config.yc.firstRunCompanies : config.yc.newCompaniesPerDay));
  const res = await get('https://yc-oss.github.io/api/companies/hiring.json', { json: true });
  if (!res.ok) { sourceReport.ycDiscover = { ok: false, error: res.error || res.status }; return; }
  const regionRank = c => {
    const ranks = (c.regions || []).map(r => config.yc.regionPriority.indexOf(r)).filter(i => i >= 0);
    return ranks.length ? Math.min(...ranks) : 99;
  };
  const candidates = res.body
    .filter(c => c.status === 'Active' && !byId.has(`yc:${c.slug}`))
    .filter(c => !config.yc.skipUsOnly || !isUsOnly((c.regions || []).map(r => ({ 'America / Canada': 'USA', 'United States of America': 'USA', Canada: 'Canada' })[r] || (/remote|unspecified/i.test(r) ? null : r)).filter(Boolean)))
    .filter(c => !(state.ycSkipped[c.slug] && Date.now() - Date.parse(state.ycSkipped[c.slug]) < 14 * DAY))
    .sort((a, b) => regionRank(a) - regionRank(b) || batchRank(b.batch) - batchRank(a.batch));
  let added = 0, fetched = 0;
  for (const listing of candidates) {
    if (added >= limit || fetched >= limit * 3) break;
    fetched++;
    const data = await fetchYC(listing.slug);
    await sleep(config.yc.requestDelayMs);
    if (!data || data.gone || !data.jobs.length) { state.ycSkipped[listing.slug] = NOW; continue; }
    applyYC(listing.slug, data, listing);
    added++;
  }
  sourceReport.ycDiscover = { ok: true, added, checked: fetched, pool: res.body.length };
}

async function verifyYC() {
  const due = args['force-yc'] || !db.meta.lastYcVerifyAt ||
    Date.now() - Date.parse(db.meta.lastYcVerifyAt) > config.yc.reverifyHours * 3600e3 - 10 * 60e3;
  if (!due) return;
  const tracked = db.companies.filter(c => c.id.startsWith('yc:') && !ycFetchedThisRun.has(c.id.slice(3)));
  let checked = 0, failed = 0;
  for (const c of tracked) {
    const slug = c.id.slice(3);
    const data = await fetchYC(slug);
    await sleep(config.yc.requestDelayMs);
    if (!data) { failed++; continue; }
    checked++;
    if (data.gone) {
      for (const j of c.jobs) if (j.src === 'yc') closeJob(c, j, 'Company removed from YC directory');
    } else applyYC(slug, data);
  }
  db.meta.lastYcVerifyAt = NOW;
  sourceReport.ycVerify = { ok: !tracked.length || failed < tracked.length / 2, checked, failed };
}

// ---------------------------------------------------------------- Hacker News "Who is hiring?"

const NON_COMPANY_DOMAINS = /(^|\.)(ycombinator\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|linkedin\.com|twitter\.com|x\.com|github\.com|google\.com|forms\.gle|notion\.site|wellfound\.com|angel\.co|calendly\.com|youtube\.com|medium\.com|bit\.ly|typeform\.com|breezy\.hr|recruitee\.com|bamboohr\.com|smartrecruiters\.com|workatastartup\.com|jobs\.gem\.com|rippling\.com|teamtailor\.com|personio\.\w+|youtu\.be|wikipedia\.org|archive\.(?:ph|org|is)|lnkd\.in|grnh\.se|dover\.com|trinethire\.com|applytojob\.com|factorialhr\.com|techcrunch\.com|mercurynews\.com|nytimes\.com|bloomberg\.com|reuters\.com|forbes\.com|substack\.com|\w+\.gov|nih\.gov|arxiv\.org|docs\.google\.com|loom\.com|vimeo\.com|web\.app|github\.io|ycombinator\.com|news\.ycombinator\.com|techjobfinder\.com|nordictechjobs\.com|weworkremotely\.com|remoteok\.com|indeed\.com|glassdoor\.com)$/i;
// A header part is a location if it names a market or a work arrangement.
const WORK_MODE_RE = /\b(remote|on-?site|hybrid|in[- ]person|in[- ]office|wfh)\b/i;
const isLocation = p => marketsOf(p).length > 0 || WORK_MODE_RE.test(p);

const EMPLOYMENT_RE = /^(full[- ]?time|part[- ]?time|contract(or)?|freelance|permanent|equity|visa|salary|\$|€|£|₹|\d+k|interns?(hips?)?$|ft|pt|onsite|remote)\b/i;
const HN_ROLE_RE = /technical staff|\bmts\b|lead|head of|\bcto\b|\bvp\b|manager|director|founding|staff|principal|scientist|specialist|recruiter|marketing|sales|operations|writer|support|designer|\bswe\b|positions|roles|bizops|technician|consultant/i;
// Words that make a header part clearly a job title even if it also mentions a place.
const STRONG_ROLE_RE = /engineer|developer|scientist|designer|manager|intern|\bswe\b|architect|researcher|analyst|recruiter|positions|roles/i;
// Comments in the thread that aren't hiring posts (meta chatter, complaints, etc.).
const NOT_A_POST_RE = /^(there used to|this role always|it'?s my duty|when you look|looking for a (commercial )?co-?founder|so people|i am |i'?m |i lead|anyone|is it just me|reminder|please|why|what|how|thanks|lol)|willing to relocate|^location:.*\bremote:/i;

function boardFromUrl(url) {
  const m = /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i.exec(url)
    || null;
  if (m && !/^(embed|v1)$/i.test(m[1])) return { ats: 'greenhouse', token: m[1].toLowerCase() };
  const l = /jobs\.(?:eu\.)?lever\.co\/([\w-]+)/i.exec(url);
  if (l) return { ats: 'lever', token: l[1].toLowerCase() };
  const a = /jobs\.ashbyhq\.com\/([\w.-]+)/i.exec(url);
  if (a) return { ats: 'ashby', token: a[1] };
  return null;
}

function parseHN(c) {
  if (!c.text || !c.author) return null;
  const html = c.text;
  const header = stripHtml(html.split(/<p>/i)[0]);
  const text = stripHtml(html);
  const parts = header.split(/\s*[|•·]\s*|\s+[–—-]{1,2}\s+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (NOT_A_POST_RE.test(header)) return null;
  // Free-form headers: "Company: X Location: …", "X is hiring …", "Hiring for multiple roles - X".
  const labelled = /company:\s*(.+?)(?:\s+location:|\s*$)/i.exec(header)?.[1]
    || /^(?:at\s+)?([A-Z][\w.&' -]{1,40}?)\s+(?:is|are)\s+hiring\b/.exec(header)?.[1]
    || /hiring for (?:several|multiple) roles (?:at|-|–)\s*([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3})/.exec(header)?.[1];
  if (!labelled && parts.length < 2 && header.split(/\s+/).length > 8) return null;
  const first = labelled || parts.find(p => !/^https?:\/\/|^location:|^backed by|^remote:?$/i.test(p)) || '';
  let name = first.replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/^(?:hiring:?|we'?re hiring:?|at)\s+/i, '')
    .replace(/\s+(?:is|are)\s+hiring.*$|\s+we'?re hiring.*$|\s+hiring\b.*$/i, '')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/[\s,;:!.]+$/, '').trim();
  if (!name || name.length < 2 || name.split(/\s+/).length > 6 || /^https?:/i.test(name)) return null;
  const links = [...html.matchAll(/href="([^"]+)"/gi)].map(m => decode(m[1]));
  const candidates = links.filter(u => domainOf(u) && !NON_COMPANY_DOMAINS.test(domainOf(u)));
  // Prefer a link whose domain contains the company's name; strip careers./jobs./app. subdomains.
  const token = slugify(name).split('-').find(w => w.length >= 3) || '';
  const picked = candidates.find(u => token && domainOf(u).replace(/[^a-z0-9]/g, '').includes(token)) || candidates[0];
  const website = picked && `https://${domainOf(picked).replace(/^(?:careers|jobs|job|app|ats|apply|boards|join|hire|work)\./, '')}`;
  const boards = links.map(boardFromUrl).filter(Boolean);
  const deobf = text.replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  const emails = [...new Set((deobf.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase()))].slice(0, 3);
  const rest = parts.slice(1).filter(p => !/https?:\/\/|www\.|\.\w{2,4}\/?$/i.test(p));
  const isMoney = p => /^[$€£₹]|\d+\s?k\b|base|equity|salary/i.test(p);
  const isRole = p => !EMPLOYMENT_RE.test(p) && !isMoney(p) && p !== first &&
    (STRONG_ROLE_RE.test(p) || ((TECH_RE.test(p) || HN_ROLE_RE.test(p)) && !isLocation(p)));
  const roles = rest.filter(isRole);
  const isMeta = p => !roles.includes(p) && (isLocation(p) || EMPLOYMENT_RE.test(p) || isMoney(p));
  const location = rest.filter(p => !roles.includes(p) && isLocation(p) && p.length < 120).join(' · ');
  return {
    commentId: String(c.id),
    author: c.author,
    created: c.created_at,
    name,
    website,
    boards,
    emails,
    title: clip(roles.join(' / ') || rest.filter(p => !isMeta(p)).join(' / ') || 'Multiple roles (see post)', 140),
    location: clip(location, 100),
    snippet: clip(text.slice(header.length).trim(), 320),
    type: jobType(header, text.slice(0, 600)),
    applyUrl: links.find(u => boardFromUrl(u) || /careers|jobs|apply/i.test(u)),
    closed: CLOSED_RE.test(text.slice(0, 400)),
  };
}

async function processHN() {
  const s = await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=12', { json: true });
  if (!s.ok) { sourceReport.hn = { ok: false, error: s.error || s.status }; return; }
  const threads = s.body.hits.filter(h => /who is hiring/i.test(h.title)).slice(0, 2);
  // Only the latest thread, plus last month's during the first week of a new month.
  const active = threads.filter((t, i) => i === 0 || Date.now() - Date.parse(threads[0].created_at) < 7 * DAY);
  let added = 0, seen = 0;
  for (const t of active) {
    const r = await get(`https://hn.algolia.com/api/v1/items/${t.objectID}`, { json: true, timeout: 60000 });
    if (!r.ok) { sourceReport.hn = { ok: false, error: r.error || r.status }; continue; }
    const present = new Set();
    const notPosts = new Set();
    for (const child of r.body.children || []) {
      const p = parseHN(child);
      if (!p) { if (child.text && child.author) notPosts.add(`hn:${child.id}`); continue; }
      seen++;
      const jobId = `hn:${p.commentId}`;
      const domain = domainOf(p.website);
      const id = (domain && byDomain.get(domain)) || `hn:${slugify(p.name)}`;
      const isNew = !byId.has(id);
      const existingJob = byId.get(id)?.jobs.find(j => j.id === jobId);
      if (p.closed) {
        // Post edited to say "filled": close it if tracked; never add it as a lead.
        if (existingJob) closeJob(byId.get(id), existingJob, 'HN post updated: position filled');
        continue;
      }
      const c = upsertCompany(id, {
        name: byId.get(id)?.name || p.name, source: 'hn',
        website: (byId.get(id)?.source !== 'hn' && byId.get(id)?.website) || p.website,
        location: byId.get(id)?.location || p.location,
      });
      if (isNew) added++;
      // HN-only companies take the latest post's name, so old misparses heal themselves.
      if (c.source === 'hn' && (c.sources || []).every(x => x === 'hn') && c.name !== p.name) c.name = p.name;
      if (c.source === 'hn' && c.website !== p.website) {
        // HN-only companies: always trust the latest post's link (clears bad old picks).
        if (p.website) { c.website = p.website; c.domain = domainOf(p.website); } else { delete c.website; delete c.domain; }
        delete c.scan; delete c.prospeoAt;
      }
      addContact(c, {
        name: p.author, title: 'Posted the HN hiring thread', email: p.emails[0],
        hn: `https://news.ycombinator.com/user?id=${p.author}`, source: 'HN',
      });
      for (const e of p.emails.slice(1)) addContact(c, { name: e, email: e, title: 'Contact email from HN post', source: 'HN' });
      // If an earlier (mis)parse filed this post under another company, move it here.
      for (const other of db.companies) {
        if (other === c) continue;
        const i = other.jobs.findIndex(j => j.id === jobId);
        if (i < 0) continue;
        other.jobs.splice(i, 1);
        if (!other.jobs.length && other.source === 'hn') { db.companies.splice(db.companies.indexOf(other), 1); byId.delete(other.id); }
      }
      upsertJob(c, {
        id: jobId, src: 'hn', thread: t.objectID, title: p.title, type: p.type,
        location: p.location, url: `https://news.ycombinator.com/item?id=${p.commentId}`,
        applyUrl: p.applyUrl, snippet: p.snippet, postedAt: p.created,
      });
      present.add(jobId);
      for (const b of p.boards) {
        const key = `${b.ats}:${b.token}`;
        const known = config.ats.boards.some(x => `${x.ats}:${x.token}` === key) || state.boards.some(x => `${x.ats}:${x.token}` === key);
        if (!known) state.boards.push({ ...b, companyId: c.id, name: c.name, discovered: NOW, active: false });
      }
    }
    // Comments that aren't hiring posts (chatter, job seekers) were never leads: drop, don't mark red.
    for (const c of [...db.companies]) {
      const before = c.jobs.length;
      c.jobs = c.jobs.filter(j => !notPosts.has(j.id));
      if (before && !c.jobs.length && c.source === 'hn') {
        db.companies.splice(db.companies.indexOf(c), 1);
        byId.delete(c.id);
        db.events = db.events.filter(e => e.companyId !== c.id);
      }
    }
    for (const c of db.companies) {
      reconcile(c, j => j.src === 'hn' && j.thread === t.objectID, present, 'HN post deleted or removed');
    }
  }
  // HN threads are monthly; posts not refreshed for ~7 weeks are treated as expired.
  for (const c of db.companies) for (const j of c.jobs) {
    if (j.src === 'hn' && j.status === 'open' && Date.now() - Date.parse(j.postedAt || j.firstSeen) > config.hn.maxPostAgeDays * DAY) {
      closeJob(c, j, `HN post older than ${config.hn.maxPostAgeDays} days`);
    }
  }
  sourceReport.hn = { ok: true, threads: active.map(t => t.title), posts: seen, newCompanies: added };
}

// ---------------------------------------------------------------- ATS boards (Greenhouse / Lever / Ashby)

async function fetchBoard({ ats, token }) {
  const enc = encodeURIComponent(token);
  if (ats === 'greenhouse') {
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${enc}/jobs`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: r.body.jobs.map(j => ({ id: String(j.id), title: j.title, url: j.absolute_url, location: j.location?.name, posted: j.updated_at })) };
  }
  if (ats === 'lever') {
    const r = await get(`https://api.lever.co/v0/postings/${enc}?mode=json`, { json: true });
    if (!r.ok || !Array.isArray(r.body)) return { ok: false, status: r.ok ? 404 : r.status };
    return { ok: true, jobs: r.body.map(j => ({ id: j.id, title: j.text, url: j.hostedUrl, location: j.categories?.location, commitment: j.categories?.commitment, posted: new Date(j.createdAt).toISOString() })) };
  }
  if (ats === 'ashby') {
    const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${enc}`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: (r.body.jobs || []).map(j => ({ id: j.id, title: j.title, url: j.jobUrl, location: j.location || (j.isRemote ? 'Remote' : ''), commitment: j.employmentType, posted: j.publishedAt })) };
  }
  return { ok: false, status: 0 };
}

const careersUrl = ({ ats, token }) => ({
  greenhouse: `https://job-boards.greenhouse.io/${token}`,
  lever: `https://jobs.lever.co/${token}`,
  ashby: `https://jobs.ashbyhq.com/${token}`,
})[ats];

async function processBoards() {
  // Activate a limited number of newly discovered boards each day.
  if (MODE === 'discover') {
    let activated = 0;
    for (const b of state.boards) {
      if (!b.active && !b.dead && activated < config.ats.newBoardsPerDay) { b.active = true; activated++; }
    }
  }
  const boards = [...config.ats.boards, ...state.boards.filter(b => b.active && !b.dead)];
  let ok = 0, failed = 0, gone = 0;
  await pool(boards, 6, async (b) => {
    const key = `${b.ats}:${b.token}`;
    const r = await fetchBoard(b);
    // Attach the board to a company we already track under the same website (e.g. a YC company).
    const companyId = b.companyId || (b.website && byDomain.get(domainOf(b.website))) || `ats:${key}`;
    if (!r.ok) {
      if (r.status === 404) {
        gone++;
        const c = byId.get(companyId);
        if (c) for (const j of c.jobs) if (j.board === key) closeJob(c, j, 'Job board removed');
        const disc = state.boards.find(x => `${x.ats}:${x.token}` === key);
        if (disc) disc.dead = NOW;
      } else failed++;
      return;
    }
    ok++;
    if (b.ats === 'greenhouse' && !b.name && !state.boardNames[key]) {
      const meta = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}`, { json: true });
      if (meta.ok && meta.body.name) state.boardNames[key] = meta.body.name;
    }
    const name = byId.get(companyId)?.name || b.name || state.boardNames[key] || b.token.replace(/[-_]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    const c = upsertCompany(companyId, { name, source: b.ats, website: byId.get(companyId)?.website || b.website, location: byId.get(companyId)?.location || b.location, careersUrl: careersUrl(b) });
    const present = new Set(r.jobs.map(j => `${b.ats}:${b.token}:${j.id}`));
    const prevOpen = c.jobs.filter(j => j.board === key && j.status === 'open').length;
    if (present.size === 0 && prevOpen > 3 && !state.zeroMiss[key]) { state.zeroMiss[key] = NOW; return; }
    delete state.zeroMiss[key];
    const relevant = r.jobs
      .filter(j => TECH_RE.test(j.title))
      .map(j => ({ ...j, type: jobType(j.title, j.commitment) }))
      .map(j => ({ ...j, focus: isFocus(marketsOf(j.location)) }))
      .sort((x, y) => (y.type === 'internship') - (x.type === 'internship') || (y.focus - x.focus) || String(y.posted).localeCompare(String(x.posted)));
    const tracked = new Set(c.jobs.map(j => j.id));
    let room = config.ats.maxJobsPerCompany - c.jobs.filter(j => j.board === key && j.status === 'open').length;
    for (const j of relevant) {
      const id = `${key}:${j.id}`;
      if (!tracked.has(id)) { if (room <= 0) continue; room--; }
      upsertJob(c, { id, src: b.ats, board: key, title: j.title, type: j.type, location: j.location, url: j.url, postedAt: j.posted });
    }
    reconcile(c, j => j.board === key, present, `Removed from ${b.ats} job board`);
  });
  sourceReport.ats = { ok: failed < boards.length / 2, boards: boards.length, fetched: ok, failed, gone, pendingDiscovered: state.boards.filter(b => !b.active && !b.dead).length };
}

// ---------------------------------------------------------------- manual leads (data/manual.json)

const GONE_TEXT_RE = /no longer (?:available|accepting|open)|(?:position|job|role) (?:has been |is )?(?:filled|closed)|this job (?:has )?expired|job not found|posting (?:has been )?(?:removed|closed)/i;

async function processManual() {
  if (!manual.length) return;
  let checked = 0;
  await pool(manual, 4, async (m) => {
    const id = m.id || `manual:${slugify(m.name)}`;
    const c = upsertCompany(id, {
      name: m.name, source: 'manual', website: m.website, location: m.location,
      oneLiner: m.oneLiner, tags: m.tags, logo: m.logo, linkedin: m.linkedin,
    });
    for (const contact of m.contacts || []) addContact(c, { ...contact, source: contact.source || 'Manual' });
    for (const mj of m.jobs || []) {
      const jobId = `manual:${slugify(m.name)}:${slugify(mj.url || mj.title)}`;
      const job = upsertJob(c, { id: jobId, src: 'manual', title: mj.title, type: mj.type || jobType(mj.title), location: mj.location || m.location, url: mj.url });
      if (!mj.url) continue;
      const r = await get(mj.url, { retries: 1 });
      checked++;
      if (r.status === 404 || r.status === 410) closeJob(c, job, `Job link returns ${r.status}`);
      else if (r.ok && GONE_TEXT_RE.test(stripHtml(r.body).slice(0, 20000))) closeJob(c, job, 'Job page says it is no longer available');
    }
  });
  sourceReport.manual = { ok: true, companies: manual.length, linksChecked: checked };
}

// ---------------------------------------------------------------- run

const t0 = Date.now();
if (MODE === 'discover') await discoverYC();
await processHN();
await processBoards();
await processManual();
await verifyYC();

// Merge companies that turned out to be the same business (same website domain).
const SOURCE_RANK = { yc: 0, manual: 1, greenhouse: 2, lever: 2, ashby: 2, hn: 3 };
const byDom = new Map();
for (const c of [...db.companies].sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || a.firstSeen.localeCompare(b.firstSeen))) {
  if (!c.domain) continue;
  const keep = byDom.get(c.domain);
  if (!keep) { byDom.set(c.domain, c); continue; }
  for (const j of c.jobs) if (!keep.jobs.some(x => x.id === j.id)) keep.jobs.push(j);
  for (const p of c.contacts) addContact(keep, p);
  for (const src of c.sources || []) if (!keep.sources.includes(src)) keep.sources.push(src);
  for (const [k, v] of Object.entries(c)) if (keep[k] == null && v != null) keep[k] = v;
  if (c.channels) keep.channels = { ...c.channels, ...keep.channels, social: { ...c.channels.social, ...keep.channels?.social } };
  if (c.firstSeen < keep.firstSeen) keep.firstSeen = c.firstSeen;
  for (const b of state.boards) if (b.companyId === c.id) b.companyId = keep.id;
  db.companies.splice(db.companies.indexOf(c), 1);
  byId.delete(c.id);
  prevStatus.delete(c.id);
}

// Drop companies added this run that ended up with no relevant roles at all.
const empty = new Set(db.companies.filter(c => c.firstSeen === NOW && !c.jobs.length).map(c => c.id));
if (empty.size) {
  db.companies = db.companies.filter(c => !empty.has(c.id));
  db.events = db.events.filter(e => !empty.has(e.companyId));
  today.companiesAdded -= empty.size;
}

// Company status: open while any job is open; red (closed) once every job is gone.
for (const c of db.companies) {
  const open = c.jobs.filter(j => j.status === 'open');
  c.openJobs = open.length;
  c.openInternships = open.filter(j => j.type === 'internship').length;
  const next = open.length ? 'open' : 'closed';
  const before = prevStatus.get(c.id) ?? 'open';
  if (next === 'closed' && before !== 'closed') {
    c.closedAt = NOW;
    today.companiesClosed++;
    const last = [...c.jobs].sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))[0];
    event('company_closed', c, null, { reason: last?.closedReason || 'No open roles left' });
  } else if (next === 'open' && before === 'closed') {
    c.closedAt = null;
    event('company_reopened', c);
  }
  c.status = next;
  for (const j of c.jobs) {
    j.markets ??= marketsOf(j.location || c.location);
    j.tech = isTechRole(j);
    if (/linkedin\.com\/jobs/i.test(`${j.url} ${j.applyUrl || ''}`)) j.via = 'linkedin';
  }
  c.markets = companyMarkets(c);
  c.jobs.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.type === 'internship' ? -1 : 0) - (b.type === 'internship' ? -1 : 0));
}

// Prune jobs that have been closed for 30+ days (company row stays, red).
for (const c of db.companies) c.jobs = c.jobs.filter(j => j.status === 'open' || Date.now() - Date.parse(j.closedAt) < 30 * DAY);

db.companies.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.name.localeCompare(b.name));
db.events = db.events.slice(0, 400);

let h = db.history.find(x => x.date === TODAY);
if (!h) { h = { date: TODAY, companiesAdded: 0, companiesClosed: 0, jobsAdded: 0, jobsClosed: 0 }; db.history.push(h); }
for (const k of Object.keys(today)) h[k] += today[k];
db.history = db.history.slice(-90);

const all = db.companies;
db.meta = {
  ...db.meta,
  generatedAt: NOW,
  lastRunMode: MODE,
  [MODE === 'discover' ? 'lastDiscoverAt' : 'lastVerifyAt']: NOW,
  lastVerifyAt: NOW,
  repo: config.repo,
  runSeconds: Math.round((Date.now() - t0) / 1000),
  sources: sourceReport,
  totals: {
    companies: all.length,
    openCompanies: all.filter(c => c.status === 'open').length,
    closedCompanies: all.filter(c => c.status === 'closed').length,
    openJobs: all.reduce((n, c) => n + c.openJobs, 0),
    openInternships: all.reduce((n, c) => n + c.openInternships, 0),
    contacts: all.reduce((n, c) => n + c.contacts.length, 0),
  },
};

await fs.mkdir(path.dirname(LEADS_FILE), { recursive: true });
await fs.writeFile(LEADS_FILE, JSON.stringify(db));
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1));
// Tiny file the open dashboards poll, so they only re-download leads.json when it changed.
await fs.writeFile(path.join(ROOT, 'data/version.json'), JSON.stringify({ v: new Date().toISOString() }));
console.log(JSON.stringify({ mode: MODE, today, totals: db.meta.totals, sources: sourceReport, seconds: db.meta.runSeconds }, null, 2));
