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
import { placesOf, remotePlaces, regionsOf, isFocusPlaces, REGION_OF, INDIA_RE, WIDE, SCOPE_COUNTRIES, scopeCountries, countryLabel } from './markets.mjs';
import { teamOf, normLinkedIn } from './people.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEADS_FILE = path.join(ROOT, 'data/leads.json');
const STATE_FILE = path.join(ROOT, 'data/state.json');
const MANUAL_FILE = path.join(ROOT, 'data/manual.json');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
let MODE = args.mode === 'discover' ? 'discover' : 'verify';

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
// Several runs can land in the 01:00 UTC hour (backup schedules): discover at most once per 20 h.
if (MODE === 'discover' && !args.force && db.meta.lastDiscoverAt && Date.now() - Date.parse(db.meta.lastDiscoverAt) < 20 * 3600e3) MODE = 'verify';

const byId = new Map(db.companies.map(c => [c.id, c]));
const nameIndexSeed = db.companies.map(c => [c.name, c.id]);
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

// Company names compared without legal suffixes, so feeds that spell a company differently still match.
const normCo = s => String(s || '').toLowerCase().replace(/\b(gmbh|ag|ab|ltd|limited|inc|plc|oy|bv|sas|sa|llc|operations|technologies|group)\b|[^a-z0-9]/g, '');
const nameIndex = new Map();
for (const [n, id] of nameIndexSeed) if (!nameIndex.has(normCo(n))) nameIndex.set(normCo(n), id);
const companyIdFor = (name, fallbackId) => nameIndex.get(normCo(name)) || fallbackId;

function upsertCompany(id, fields) {
  let c = byId.get(id);
  if (!c) {
    c = { id, name: fields.name, firstSeen: NOW, status: 'open', closedAt: null, contacts: [], jobs: [], sources: [] };
    byId.set(id, c);
    if (fields.name && !nameIndex.has(normCo(fields.name))) nameIndex.set(normCo(fields.name), id);
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

// Places a company is based in (HQ text + YC regions), used when a role just says "Remote".
const companyContext = c => placesOf([c.location, ...(c.regions || [])].filter(Boolean).join(' ; ')).filter(p => !/-wide$/.test(p));

// Site scope: tech roles, remote, workable from at least one country outside the US.
const OFFICE_RE = /hybrid|in[- ]office|in[- ]person|on-?site (?:only|required)|\d+\s*(?:days?|x)\s*(?:a |per |\/)?\s*(?:week|wk)?\s*(?:in|at) (?:the )?office|office[- ]based|relocat(?:e|ion) (?:to|required)/i;
// Posting-text checks (from the lead-quality audit). A role is dropped if its text clearly requires
// office/hybrid work and offers no remote option, or if an agency is posting for an unnamed client.
const REMOTE_OK_RE = /\b(fully remote|100% remote|remote[- ]first|remote within|work from anywhere|work remotely|or (?:fully )?remote|remote or|remote[- ]friendly|remote (?:role|position|setup|opportunity))\b/i;
const OFFICE_STRONG_RE = [
  /\b(?:this|the) (?:is an? )?(?:in[- ]person|on-?site|office[- ]based|hybrid) (?:role|position)\b/i,
  /\bhybrid\s*\(\s*\d+\s*(?:days?|x)\b/i,
  /\b(?:will|to) (?:transition|move|switch) to (?:a )?hybrid\b/i,
  /\bwork in[- ]person in\b/i,
  /\blocation\s*:\s*[^.|\n]{0,60}\((?:hybrid|on-?site|in[- ]office)\)/i,
  /\b(?:role|position) is based in [A-Z][a-z]+ to\b/,
];
const OFFICE_WEAK_RE = /\b(hybrid work(?:ing)? (?:model|policy|setup|arrangement)s?|hybrid working\b|we operate a hybrid|(?:\d|two|three|four) days? (?:a|per) week (?:in|at) (?:the|our) office)\b/i;
const AGENCY_RE = /\b(on behalf of (?:our|a|an) client|our client(?:s)? (?:is|are)|for (?:one of )?our clients?\b|we are recruiting (?:for|on behalf))/i;
function postingIssue(job) {
  const t = String(job.text || '').replace(/\s+/g, ' ').slice(0, 30000);
  if (!t) return null;
  if (AGENCY_RE.test(t)) return 'agency';
  // "Headquartered in New York City, with offices in London": the company is US-based.
  const hq = /\bheadquarter(?:s|ed)?\s+(?:is\s+|are\s+)?(?:located\s+|based\s+)?in\s+([^.,;:()]{3,50}?)(?=[.,;:()]|\s+(?:with|and|but|where)\b|$)/i.exec(t);
  if (hq && placesOf(hq[1]).includes('United States')) return 'us-hq';
  if (OFFICE_STRONG_RE.some(re => re.test(t))) return 'office';
  // A startup job board that explicitly says "Remote" (Ashby / Lever) outranks generic company
  // boilerplate about hybrid work. Feed "remote" flags (Arbeitnow, Jobicy, ...) are not trusted for this.
  if (!job.trustedRemote && OFFICE_WEAK_RE.test(t) && !REMOTE_OK_RE.test(t)) return 'office';
  return null;
}

function scopeOf(job, context) {
  if (!isTechRole(job) || /^\s*test\b|do not apply|dummy/i.test(job.title)) return { ok: false };
  // Internships only.
  if ((job.type || jobType(job.title, job.commitment)) !== 'internship') return { ok: false };
  // Text checked when the posting was read; the stored verdict is reused on later runs.
  if (job.text !== undefined) job.postingIssue = postingIssue(job);
  if (job.postingIssue === 'office') return { ok: false };
  if (job.postingIssue === 'agency') return { ok: false, agency: true };
  if (job.postingIssue === 'us-hq') return { ok: false, usHq: true };
  // A title that names a country outside the five ("Software Intern (Mexico)").
  const titlePlaces = placesOf(job.title).filter(p => REGION_OF[p] || p === 'United States');
  if (titlePlaces.length && !titlePlaces.some(p => SCOPE_COUNTRIES.includes(p))) return { ok: false };
  // The job board itself says hybrid / on-site.
  if (job.notRemote) return { ok: false };
  // 100% remote only: any hybrid / in-office / relocation requirement disqualifies the role.
  if (OFFICE_RE.test(`${job.location || ''} ${job.title}`)) return { ok: false };
  const { remote, places } = remotePlaces(job.location, job.remoteFlag, context);
  // Open to the UK, Germany, Australia, Singapore or the UAE: named in the posting, or remote across a
  // wider area (worldwide / Europe / EMEA / APAC / MENA) from a company based in one of them.
  const countries = scopeCountries(places, context.filter(p => SCOPE_COUNTRIES.includes(p)));
  // For the RTI tracker: does the posting itself name India (e.g. "Remote (SG; ID; IN)")?
  const openToIndia = places.includes('India');
  return { ok: remote && countries.length > 0, places: countries, worldwide: places.includes('Worldwide'), openToIndia };
}

// Companies we never list: headquartered in the US, or with an office in India.
function exclusionOf(c, rawLocations = []) {
  if (placesOf(c.location || '').includes('United States')) return 'US headquarters';
  if (c.hq?.countryCode === 'US') return 'US headquarters (Prospeo)';
  if (c.hq?.countryCode === 'IN') return 'India headquarters (Prospeo)';
  // "Remote (Germany / India / ...)" lists where people may work from, not offices, so it doesn't count.
  if ((c.regions || []).some(r => /^(India|South Asia)$/.test(r)) || INDIA_RE.test(c.location || '') || rawLocations.some(l => !/^remote \(/i.test(l || '') && INDIA_RE.test(l || ''))) return 'India office';
  return null;
}
function exclude(id, reason) { state.excluded ??= {}; state.excluded[id] = { reason, at: NOW }; }
const isExcluded = id => !!state.excluded?.[id];

function applyScope(j, s) {
  j.places = s.places;
  j.worldwide = s.worldwide || undefined;
  j.regions = regionsOf(s.places);
  j.remoteScope = countryLabel(s.places, s.worldwide ? ['Worldwide'] : []);
  j.openToIndia = s.openToIndia;
}

function upsertJob(company, job) {
  const scope = scopeOf(job, companyContext(company));
  delete job.text;
  if (scope.agency) exclude(company.id, 'Recruitment agency (posts for unnamed clients)');
  if (scope.usHq) exclude(company.id, 'US headquarters (job posting)');
  if (!scope.ok) {
    // Out of scope (US-only, on-site, or not a tech role): never stored.
    company.jobs = company.jobs.filter(x => x.id !== job.id);
    return null;
  }
  applyScope(job, scope);
  job.track = trackOf(job.title);
  job.remote = true;
  job.tech = true;
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

function removeCompany(c) {
  const i = db.companies.indexOf(c);
  if (i >= 0) db.companies.splice(i, 1);
  byId.delete(c.id);
  db.events = db.events.filter(e => e.companyId !== c.id);
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

// An internship by its title, or by the board's own employment type ("Intern") unless the title says
// it's a working-student / Werkstudent job (part-time student employment, not an internship).
const WORKSTUDENT_RE = /working student|werkstudent|student assistant|studentische|apprentic|trainee|thesis|abschlussarbeit|masterarbeit|bachelorarbeit/i;
const jobType = (title, extra = '') => (INTERN_RE.test(title) || (INTERN_RE.test(extra || '') && !WORKSTUDENT_RE.test(title)) ? 'internship' : 'job');

// "Pure tech": software, data, AI/ML, infra, security, QA, embedded, IT. Not sales, ops, HR,
// marketing, PM/design, or non-software engineering (mechanical, electrical, manufacturing...).
const TECH_POS_RE = /\b(software\w*|softwareentwickl\w*|entwickl\w*|informatik\w*|programmier\w*|engineer(?:ing|s)?|developer|dev|sde|swe|programmer|full[- ]?stack|front[- ]?end|back[- ]?end|web|mobile|ios|android|flutter|react|node(?:\.?js)?|python|java|golang|rust|c\+\+|typescript|devops|sre|site reliability|platform|infrastructure|infra|cloud|kubernetes|data (?:engineer|scientist|science|analyst|analytics|platform)|machine learning|ml|ai|llm|deep learning|computer vision|nlp|research (?:engineer|scientist)|applied scientist|security|cyber ?security|appsec|qa|quality assurance|sdet|test automation|automation engineer|embedded|firmware|database|dba|architect|tech(?:nical)? lead|cto|it (?:support|admin|engineer)|blockchain|smart contract|game developer|mts|technical staff)\b/i;
const TECH_NEG_RE = /\b(sales|account (?:executive|manager)|business development|bdr|sdr|marketing|marketer|recruit\w*|talent|human resources|hr|people (?:ops|operations|partner)|finance|financial|accountant|accounting|legal|counsel|paralegal|customer (?:success|support|service|experience)|support (?:specialist|agent|associate)|office|executive assistant|copywriter|content|community|partnerships?|solutions? (?:engineer|consultant|architect)|sales engineer|pre-?sales|field (?:engineer|service)|mechanical|electrical|civil|chemical|manufacturing|production|process engineer|quality engineer|construction|technician|driver|warehouse|nurse|clinical|pharmac\w*|mri|medical|physician|teacher|tutor|product (?:manager|owner|designer|marketing)|program manager|project manager|scrum|designer|ux researcher|operations (?:manager|associate|lead)|bizops|chief of staff|growth (?:lead|manager))\b/i;
const TRACKS = [
  ['AI / ML & LLM Systems', /\b(ai|ml|machine learning|llm|deep learning|computer vision|nlp|research (?:engineer|scientist)|applied scientist|mlops|genai|generative|data scientist|inference|perception)\b/i],
  ['Mobile & Autonomous Systems', /mobile|\bios\b|android|flutter|react native|robotic|autonomy|autonomous|embedded|firmware|hardware software/i],
  ['DevOps, Cloud & SRE', /devops|\bsre\b|site reliability|cloud|platform|infrastructure|\binfra\b|kubernetes|security|devsecops|network|reliability/i],
  ['Data & Quant Engineering', /data (?:engineer|platform|infrastructure)|analytics engineer|quant|quantitative|database|\bdba\b|\betl\b|data/i],
  ['Full-Stack & Product Engineering', /full[- ]?stack|front[- ]?end|frontend|\bweb\b|product engineer|\bui\b|react|typescript|design engineer/i],
];
const trackOf = title => (TRACKS.find(([, re]) => re.test(title)) || ['Backend & Distributed Systems'])[0];

// Extra exclusions on top of TECH_NEG_RE: not engineering even if the title says "AI" or "engineer".
const TECH_NEG2_RE = /trainer|annotat|label(?:l)?ing|\brater\b|evaluator|tutor|support engineer|technical support|it support|helpdesk|help desk|it admin|sysadmin|system administrator|solutions|implementation|customer engineer|deployment strategist|\bconsultant\b|compliance|mlro|founder'?s associate|chief of staff|\bgtm\b|growth|operations|data analyst|business analyst|qa (?:analyst|tester)|manual (?:qa|test)|tester\b|werkstudent marketing|recruitment|sales/i;
function isTechRole(j) {
  if (TECH_NEG2_RE.test(j.title)) return false;
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

let ycJobPages = 0;
async function ycJobText(c, id, path) {
  const prev = c?.jobs.find(x => x.id === id);
  if (prev?.textCheckedAt && Date.now() - Date.parse(prev.textCheckedAt) < 7 * DAY) return undefined; // keep stored verdict
  if (ycJobPages >= 80) return undefined;
  ycJobPages++;
  const r = await get(`https://www.ycombinator.com${path}`, { retries: 1 });
  await sleep(config.yc.requestDelayMs);
  return r.ok ? stripHtml(r.body).slice(0, 30000) : undefined;
}

async function applyYC(slug, data, listing = {}) {
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
    ycLinkedin: yc.linkedin_url,
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
    const text = await ycJobText(c, id, p.url);
    present.add(id);
    upsertJob(c, {
      id, src: 'yc', title: p.title,
      type: jobType(p.title, /intern/i.test(p.type || '') ? 'intern' : ''),
      location: p.location, salary: p.salaryRange || undefined,
      experience: p.minExperience || undefined,
      url: `https://www.ycombinator.com${p.url}`,
      ...(text !== undefined ? { text, textCheckedAt: NOW } : {}),
    });
  }
  reconcile(c, j => j.src === 'yc', present, 'Removed from YC job board');
  return c;
}

async function discoverYC() {
  const limit = +(args['yc-limit'] || (firstRun ? config.yc.firstRunCompanies : config.yc.newCompaniesPerDay));
  const res = await get('https://yc-oss.github.io/api/companies/hiring.json', { json: true });
  if (!res.ok) { sourceReport.ycDiscover = { ok: false, error: res.error || res.status }; return; }
  const nonUS = c => placesOf((c.regions || []).join(' ; ')).filter(p => p !== 'United States' && p !== 'Canada');
  const remoteFriendly = c => (c.regions || []).some(r => /fully remote/i.test(r));
  const inFive = c => nonUS(c).some(p => SCOPE_COUNTRIES.includes(p)) || placesOf(c.all_locations || '').some(p => SCOPE_COUNTRIES.includes(p));
  const rank = c => (inFive(c) ? 0 : isFocusPlaces(nonUS(c)) ? 1 : nonUS(c).length ? 2 : remoteFriendly(c) ? 3 : 9);
  const candidates = res.body
    .filter(c => c.status === 'Active' && !byId.has(`yc:${c.slug}`) && !isExcluded(`yc:${c.slug}`))
    .filter(c => rank(c) < 9) // US-only companies are skipped entirely
    .filter(c => !(state.ycSkipped[c.slug] && Date.now() - Date.parse(state.ycSkipped[c.slug]) < 14 * DAY))
    .sort((a, b) => rank(a) - rank(b) || batchRank(b.batch) - batchRank(a.batch));
  let added = 0, fetched = 0;
  for (const listing of candidates) {
    if (added >= limit || fetched >= limit * 3) break;
    fetched++;
    const data = await fetchYC(listing.slug);
    await sleep(config.yc.requestDelayMs);
    if (!data || data.gone || !data.jobs.length) { state.ycSkipped[listing.slug] = NOW; continue; }
    const why = exclusionOf({ location: data.company.location, regions: listing.regions }, data.jobs.map(j => j.location));
    if (why) { exclude(`yc:${listing.slug}`, why); state.ycSkipped[listing.slug] = NOW; continue; }
    const c = await applyYC(listing.slug, data, listing);
    if (!c.jobs.length) { removeCompany(c); today.companiesAdded--; state.ycSkipped[listing.slug] = NOW; continue; }
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
    } else await applyYC(slug, data);
  }
  db.meta.lastYcVerifyAt = NOW;
  sourceReport.ycVerify = { ok: !tracked.length || failed < tracked.length / 2, checked, failed };
}

// ---------------------------------------------------------------- Hacker News "Who is hiring?"

const NON_COMPANY_DOMAINS = /(^|\.)(ycombinator\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|linkedin\.com|twitter\.com|x\.com|github\.com|google\.com|forms\.gle|notion\.site|wellfound\.com|angel\.co|calendly\.com|youtube\.com|medium\.com|bit\.ly|typeform\.com|breezy\.hr|recruitee\.com|bamboohr\.com|smartrecruiters\.com|workatastartup\.com|jobs\.gem\.com|rippling\.com|teamtailor\.com|personio\.\w+|youtu\.be|wikipedia\.org|archive\.(?:ph|org|is)|lnkd\.in|grnh\.se|dover\.com|trinethire\.com|applytojob\.com|factorialhr\.com|techcrunch\.com|mercurynews\.com|nytimes\.com|bloomberg\.com|reuters\.com|forbes\.com|substack\.com|\w+\.gov|nih\.gov|arxiv\.org|docs\.google\.com|loom\.com|vimeo\.com|web\.app|github\.io|ycombinator\.com|news\.ycombinator\.com|techjobfinder\.com|nordictechjobs\.com|weworkremotely\.com|remoteok\.com|indeed\.com|glassdoor\.com)$/i;
// A header part is a location if it names a market or a work arrangement.
const WORK_MODE_RE = /\b(remote|on-?site|hybrid|in[- ]person|in[- ]office|wfh)\b/i;
const isLocation = p => placesOf(p).length > 0 || WORK_MODE_RE.test(p);

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
    text,
    type: jobType(header),
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
      if (isExcluded(id)) continue;
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
        applyUrl: p.applyUrl, snippet: p.snippet, postedAt: p.created, text: p.text,
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

async function fetchBoard({ ats, token, eu }) {
  const enc = encodeURIComponent(token);
  if (ats === 'greenhouse') {
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${enc}/jobs?content=true`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: r.body.jobs.map(j => ({ id: String(j.id), title: j.title, url: j.absolute_url, location: j.location?.name, posted: j.updated_at, text: stripHtml(decode(j.content || '')) })) };
  }
  if (ats === 'lever') {
    const r = await get(`https://api.${eu ? 'eu.' : ''}lever.co/v0/postings/${enc}?mode=json`, { json: true });
    if (!r.ok || !Array.isArray(r.body)) return { ok: false, status: r.ok ? 404 : r.status };
    return { ok: true, jobs: r.body.map(j => ({ id: j.id, title: j.text, url: j.hostedUrl, location: (j.categories?.allLocations?.length ? j.categories.allLocations.join(' / ') : j.categories?.location), remoteFlag: j.workplaceType === 'remote', trustedRemote: j.workplaceType === 'remote', notRemote: /hybrid|on-?site/i.test(j.workplaceType || ''), text: `${j.descriptionPlain || ''} ${(j.lists || []).map(l => stripHtml(l.content)).join(' ')} ${j.additionalPlain || ''}`, commitment: j.categories?.commitment, posted: new Date(j.createdAt).toISOString() })) };
  }
  if (ats === 'ashby') {
    const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${enc}`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: (r.body.jobs || []).map(j => ({ id: j.id, title: j.title, url: j.jobUrl, location: [j.location, ...(j.secondaryLocations || []).map(x => x.location)].filter(Boolean).join(' / '), remoteFlag: j.workplaceType ? j.workplaceType === 'Remote' : !!j.isRemote, trustedRemote: j.workplaceType === 'Remote', notRemote: /hybrid|onsite/i.test(j.workplaceType || ''), text: j.descriptionPlain || '', commitment: j.employmentType, posted: j.publishedAt })) };
  }
  // Workable: "telecommuting" is the board's own remote flag; anything else is on-site or hybrid.
  if (ats === 'workable') {
    const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${enc}?details=true`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: (r.body.jobs || []).map(j => {
      const places = (j.locations?.length ? j.locations : [j]).map(l => [l.city, l.country].filter(Boolean).join(', ')).filter(Boolean);
      return { id: j.shortcode, title: j.title, url: j.url, location: j.telecommuting ? `Remote (${places.join(' / ') || 'Anywhere'})` : places.join(' / '), remoteFlag: !!j.telecommuting, trustedRemote: !!j.telecommuting, notRemote: !j.telecommuting, commitment: j.employment_type, text: stripHtml(j.description || ''), posted: j.published_on };
    }) };
  }
  if (ats === 'recruitee') {
    const r = await get(`https://${enc}.recruitee.com/api/offers/`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: (r.body.offers || []).map(o => ({ id: String(o.id), title: o.title, url: o.careers_url, location: o.remote ? `Remote (${[o.city, o.country].filter(Boolean).join(', ') || 'Anywhere'})` : [o.city, o.country].filter(Boolean).join(', '), remoteFlag: !!o.remote, trustedRemote: !!o.remote && !o.hybrid, notRemote: !o.remote || !!o.hybrid, commitment: o.employment_type_code, text: stripHtml(o.description || ''), posted: o.published_at })) };
  }
  if (ats === 'smartrecruiters') {
    const r = await get(`https://api.smartrecruiters.com/v1/companies/${enc}/postings?limit=100`, { json: true });
    if (!r.ok) return r;
    return { ok: true, jobs: (r.body.content || []).map(p => ({ id: p.id, title: p.name, url: `https://jobs.smartrecruiters.com/${token}/${p.id}`, location: p.location?.remote ? `Remote (${p.location.fullLocation || p.location.country || 'Anywhere'})` : p.location?.fullLocation || '', remoteFlag: !!p.location?.remote, trustedRemote: !!p.location?.remote && !p.location?.hybrid, notRemote: !p.location?.remote || !!p.location?.hybrid, commitment: p.typeOfEmployment?.label, posted: p.releasedDate })) };
  }
  // Personio XML feed: an office called "Remote" (or "Home office") marks a remote role.
  if (ats === 'personio') {
    const r = await get(`https://${enc}.jobs.personio.de/xml`);
    if (!r.ok) return r;
    const tag = (x, t) => decode((new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i').exec(x) || [])[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    return { ok: true, jobs: r.body.split(/<position>/i).slice(1).map(x => {
      const offices = [tag(x, 'office'), ...[...x.matchAll(/<additionalOffice>([\s\S]*?)<\/additionalOffice>/gi)].map(m => decode(m[1]).trim())].filter(Boolean);
      const remote = offices.some(o => /remote|home ?office|mobile/i.test(o));
      return { id: tag(x, 'id'), title: tag(x, 'name'), url: `https://${token}.jobs.personio.de/job/${tag(x, 'id')}`, location: remote ? `Remote (${offices.join(' / ')})` : offices.join(' / '), remoteFlag: remote, notRemote: !remote, commitment: tag(x, 'employmentType'), text: stripHtml(decode(tag(x, 'value'))), posted: tag(x, 'createdAt') };
    }) };
  }
  return { ok: false, status: 0 };
}

const careersUrl = ({ ats, token, eu }) => ({
  greenhouse: `https://job-boards.greenhouse.io/${token}`,
  lever: `https://jobs.${eu ? 'eu.' : ''}lever.co/${token}`,
  ashby: `https://jobs.ashbyhq.com/${token}`,
  workable: `https://apply.workable.com/${token}/`,
  recruitee: `https://${token}.recruitee.com/`,
  smartrecruiters: `https://jobs.smartrecruiters.com/${token}`,
  personio: `https://${token}.jobs.personio.de/`,
})[ats];

async function processBoards() {
  // Activate a limited number of newly discovered boards each day.
  if (MODE === 'discover') {
    let activated = 0;
    for (const b of state.boards) {
      if (!b.active && !b.dead && activated < config.ats.newBoardsPerDay) { b.active = true; activated++; }
    }
  }
  // Boards found by the deeper search (scripts/discover.mjs) that have never had a remote internship
  // are re-read every 6 hours instead of every run.
  const boards = [...config.ats.boards, ...state.boards.filter(b => b.active && !b.dead)
    .filter(b => b.via !== 'prospeo' || b.hits || !b.readAt || Date.now() - Date.parse(b.readAt) > 6 * 3600e3 - 10 * 60e3)];
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
    if (isExcluded(companyId)) return;
    const why = exclusionOf({ location: b.location || byId.get(companyId)?.location, regions: byId.get(companyId)?.regions }, r.jobs.map(j => j.location));
    if (why) { exclude(companyId, why); return; }
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
    const relevantAll = r.jobs
      .map(j => ({ ...j, scope: scopeOf(j, companyContext(c)) }));
    // Roles the board now marks hybrid / on-site (or that fell out of scope) are removed, not closed.
    const outOfScope = new Set(relevantAll.filter(j => !j.scope.ok).map(j => `${key}:${j.id}`));
    c.jobs = c.jobs.filter(j => !outOfScope.has(j.id));
    if (b.via === 'prospeo') { b.readAt = NOW; b.hits = relevantAll.filter(j => j.scope.ok).length; }
    const relevant = relevantAll
      .filter(j => j.scope.ok)
      .map(j => ({ ...j, type: jobType(j.title, j.commitment), focus: isFocusPlaces(j.scope.places) }))
      .sort((x, y) => (y.type === 'internship') - (x.type === 'internship') || (y.focus - x.focus) || String(y.posted).localeCompare(String(x.posted)));
    const tracked = new Set(c.jobs.map(j => j.id));
    let room = config.ats.maxJobsPerCompany - c.jobs.filter(j => j.board === key && j.status === 'open').length;
    for (const j of relevant) {
      const id = `${key}:${j.id}`;
      if (!tracked.has(id)) { if (room <= 0) continue; room--; }
      upsertJob(c, { id, src: b.ats, board: key, title: j.title, type: j.type, location: j.location, remoteFlag: j.remoteFlag, notRemote: j.notRemote, text: j.text, trustedRemote: j.trustedRemote, url: j.url, postedAt: j.posted });
    }
    reconcile(c, j => j.board === key, present, `Removed from ${b.ats} job board`);
  });
  sourceReport.ats = { ok: failed < boards.length / 2, boards: boards.length, fetched: ok, failed, gone, pendingDiscovered: state.boards.filter(b => !b.active && !b.dead).length };
}

// ---------------------------------------------------------------- Jobicy (remote tech jobs by region)
// Free API; asks for a credit link and that apply buttons go to the job URL it provides.

async function processJobicy() {
  const cfgJ = config.jobicy;
  if (!cfgJ?.enabled) return;
  if (state.jobicyAt && Date.now() - Date.parse(state.jobicyAt) < cfgJ.everyHours * 3600e3 - 10 * 60e3) return;
  const seen = new Map();
  let complete = true, requests = 0;
  for (const geo of cfgJ.geos) for (const industry of cfgJ.industries) {
    let cursor = '';
    for (let page = 0; page < cfgJ.maxPages; page++) {
      const r = await get(`https://jobicy.com/api/v2/remote-jobs?count=100&geo=${geo}&industry=${industry}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { json: true });
      requests++;
      if (!r.ok) { if (r.status !== 404) complete = false; break; }
      for (const j of r.body.jobs || []) seen.set(String(j.id), j);
      if (!r.body.hasMore) break;
      cursor = r.body.nextCursor;
      if (page === cfgJ.maxPages - 1) complete = false;
      await sleep(300);
    }
  }
  let added = 0;
  for (const j of seen.values()) {
    const name = decode(j.companyName || '').trim();
    if (!name) continue;
    const id = companyIdFor(name, `jobicy:${slugify(name)}`);
    if (isExcluded(id)) continue;
    // Jobicy gives no headquarters. A company that also hires in the US is treated as US-based and dropped.
    if (!byId.get(id)?.location && placesOf(decode(j.jobGeo || '')).includes('United States')) { exclude(id, 'Hires in the US'); continue; }
    const isNew = !byId.has(id);
    const c = upsertCompany(id, { name, source: 'jobicy', logo: byId.get(id)?.logo || j.companyLogo });
    const title = decode(j.jobTitle);
    const levelIntern = /intern/i.test(`${j.jobLevel} ${j.jobType}`);
    const job = upsertJob(c, {
      id: `jobicy:${j.id}`, src: 'jobicy', title, type: jobType(title, levelIntern ? 'intern' : ''),
      location: decode(j.jobGeo || 'Anywhere').replace(/,\s+/g, ' / '), remoteFlag: true,
      url: j.url, snippet: clip(decode(j.jobExcerpt || ''), 280), postedAt: j.pubDate, text: stripHtml(decode(j.jobDescription || '')),
    });
    if (job && isNew) added++;
  }
  // Only when every feed was read to the end can a missing listing be called closed.
  if (complete) for (const c of db.companies) reconcile(c, j => j.src === 'jobicy', new Set([...seen.keys()].map(k => `jobicy:${k}`)), 'Removed from Jobicy');
  state.jobicyAt = NOW;
  sourceReport.jobicy = { ok: complete, requests, listings: seen.size, newCompanies: added };
}

// ---------------------------------------------------------------- Arbeitnow (EU / DACH remote jobs)
// Free API ("please link back"); newest first, 300 per page.

async function processArbeitnow() {
  const cfgA = config.arbeitnow;
  if (!cfgA?.enabled) return;
  if (state.arbeitnowAt && Date.now() - Date.parse(state.arbeitnowAt) < cfgA.everyHours * 3600e3 - 10 * 60e3) return;
  const seen = new Map();
  let oldest = null, requests = 0, failed = false;
  for (let page = 1; page <= cfgA.maxPages; page++) {
    const r = await get(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, { json: true, timeout: 60000 });
    requests++;
    if (!r.ok) { failed = true; break; }
    for (const j of r.body.data || []) {
      const t = j.created_at * 1000;
      if (oldest === null || t < oldest) oldest = t;
      if (j.remote) seen.set(j.slug, j);
    }
    if (!r.body.links?.next) break;
    await sleep(500);
  }
  let added = 0;
  for (const j of seen.values()) {
    const name = decode(j.company_name || '').trim();
    if (!name) continue;
    const id = companyIdFor(name, `arbeitnow:${slugify(name)}`);
    if (isExcluded(id)) continue;
    const isNew = !byId.has(id);
    // Arbeitnow is a German board: a bare "Remote job" means remote within Germany.
    const loc = /^(remote( job)?|homeoffice)$/i.test((j.location || '').trim()) ? 'Remote (Germany)' : `${j.location} / Remote`;
    const c = upsertCompany(id, { name, source: 'arbeitnow', location: byId.get(id)?.location || (placesOf(j.location).length ? j.location : 'Germany') });
    const title = decode(j.title).replace(/\s*·\s*remote\s*$/i, '');
    const job = upsertJob(c, {
      id: `arbeitnow:${j.slug}`, src: 'arbeitnow', title, type: jobType(title, (j.job_types || []).some(t => /intern|praktikum/i.test(t)) ? 'intern' : ''),
      location: loc, remoteFlag: true, url: j.url, postedAt: new Date(j.created_at * 1000).toISOString(), text: stripHtml(j.description || ''),
    });
    if (job && isNew) added++;
  }
  // Listings newer than the oldest one we paged through must still be there if they are open.
  if (!failed && oldest) for (const c of db.companies) {
    for (const j of c.jobs) if (j.src === 'arbeitnow' && j.status === 'open' && !seen.has(j.id.slice(10)) && Date.parse(j.postedAt) > oldest) closeJob(c, j, 'Removed from Arbeitnow');
  }
  state.arbeitnowAt = NOW;
  sourceReport.arbeitnow = { ok: !failed, requests, remoteListings: seen.size, newCompanies: added };
}

// ---------------------------------------------------------------- "Others": remote job boards
// Remotive, RemoteOK, Working Nomads, We Work Remotely, NoDesk and jobfound.org, read through their
// official feeds (JSON API / RSS) or, for jobfound, its structured job pages. Each asks for a link
// back and a source credit; listings keep their original URL and show "via <board>".

const rssItems = xml => xml.split(/<item>/i).slice(1).map(x => {
  const tag = t => decode((new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i').exec(x) || [])[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  return { title: tag('title'), link: tag('link'), pubDate: tag('pubDate'), region: tag('region'), country: tag('country'), description: tag('description') };
});

const OTHERS = {
  remotive: {
    label: 'Remotive', everyHours: 6, // Remotive asks for at most 4 requests a day
    async fetch() {
      const r = await get('https://remotive.com/api/remote-jobs', { json: true });
      if (!r.ok) return null;
      return (r.body.jobs || []).map(j => ({ id: j.id, company: j.company_name, title: j.title, location: j.candidate_required_location, url: j.url, postedAt: j.publication_date, logo: j.company_logo, internship: /intern/i.test(j.job_type || ''), text: j.description }));
    },
  },
  remoteok: {
    label: 'Remote OK', everyHours: 3,
    async fetch() {
      const r = await get('https://remoteok.com/api', { json: true });
      if (!r.ok || !Array.isArray(r.body)) return null;
      return r.body.slice(1).map(j => ({ id: j.id, company: j.company, title: j.position, location: j.location, url: j.url, postedAt: j.date, logo: j.company_logo || j.logo, text: j.description }));
    },
  },
  workingnomads: {
    label: 'Working Nomads', everyHours: 3,
    async fetch() {
      const r = await get('https://www.workingnomads.com/api/exposed_jobs/', { json: true });
      if (!r.ok || !Array.isArray(r.body)) return null;
      return r.body.filter(j => /development|administration|data|engineering/i.test(j.category_name || '')).map(j => ({ id: j.url, company: j.company_name, title: j.title, location: j.location, url: j.url, postedAt: j.pub_date, text: j.description }));
    },
  },
  weworkremotely: {
    label: 'We Work Remotely', everyHours: 3,
    async fetch() {
      const out = [];
      for (const cat of ['remote-programming-jobs', 'remote-full-stack-programming-jobs', 'remote-back-end-programming-jobs', 'remote-front-end-programming-jobs', 'remote-devops-sysadmin-jobs']) {
        const r = await get(`https://weworkremotely.com/categories/${cat}.rss`);
        if (!r.ok) return null;
        for (const it of rssItems(r.body)) {
          const [company, ...rest] = it.title.split(': ');
          const hq = /Headquarters:\s*<\/strong>\s*([^<]+)/i.exec(it.description)?.[1] || /Headquarters:\s*([^\n<]+)/i.exec(stripHtml(it.description))?.[1];
          out.push({ id: it.link, company, title: rest.join(': ') || it.title, location: [it.region, it.country].filter(Boolean).join(' / '), url: it.link, postedAt: it.pubDate && new Date(it.pubDate).toISOString(), hq: hq && hq.trim(), text: it.description });
        }
        await sleep(300);
      }
      return out;
    },
  },
  nodesk: {
    label: 'NoDesk', everyHours: 3,
    async fetch() {
      const r = await get('https://nodesk.co/remote-jobs/index.xml');
      if (!r.ok) return null;
      return rssItems(r.body).map(it => {
        const m = /^(.*)\s+at\s+(.+)$/.exec(it.title) || [null, it.title, ''];
        // NoDesk's feed has no location field; use a "Remote (…)" / "Location: …" mention in the text if there is one.
        const text = stripHtml(it.description).slice(0, 1500);
        const loc = /(?:location|based in|remote)\s*[:(–-]\s*([^.\n)]{3,80})/i.exec(text)?.[1] || '';
        return { id: it.link, company: m[2], title: m[1], location: loc, url: it.link, postedAt: it.pubDate && new Date(it.pubDate).toISOString(), text: it.description };
      });
    },
  },
  himalayas: {
    // Remote-only job board with a public API (search: 20 per page). Every internship search for the
    // five countries plus worldwide-remote internships, read to the last page.
    label: 'Himalayas', everyHours: 2,
    async fetch() {
      const out = new Map();
      let complete = true;
      for (const country of [...SCOPE_COUNTRIES, null]) for (const q of ['intern', 'internship', 'praktikum']) {
        for (let page = 1; page <= 15; page++) {
          const params = new URLSearchParams({ q, page: String(page) });
          if (country) params.set('country', country); else params.set('worldwide', 'true');
          const r = await get(`https://himalayas.app/jobs/api/search?${params}`, { json: true });
          if (!r.ok) { complete = false; break; }
          for (const j of r.body.jobs || []) {
            if (j.expiryDate && j.expiryDate * 1000 < Date.now()) continue;
            out.set(j.guid, {
              id: j.guid, company: j.companyName, title: j.title,
              location: (j.locationRestrictions || []).length ? `Remote (${j.locationRestrictions.join(' / ')})` : 'Remote (Worldwide)',
              url: j.guid, applyUrl: j.applicationLink && j.applicationLink !== j.guid ? j.applicationLink : undefined,
              postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : undefined, logo: j.companyLogo || undefined,
              // Himalayas tags working-student, thesis and graduate-scheme posts "Intern" too, so the title decides.
              text: j.description,
            });
          }
          if ((r.body.jobs || []).length < 20) break;
          if (page === 15) complete = false;
          await sleep(400);
        }
      }
      const items = [...out.values()];
      items.complete = complete;
      return items;
    },
  },
  jobfound: {
    label: 'Jobfound', everyHours: 6,
    async fetch() {
      const r = await get('https://jobfound.org/remote');
      if (!r.ok) return null;
      // Slugs end in the country ("...-remote-usa-29-october-2026"); skip US / India before fetching.
      const links = [...new Set([...r.body.matchAll(/href="(\/job\/[^"]+)"/g)].map(m => m[1]))]
        .filter(l => !/-(usa|india)-\d+-[a-z]+-\d{4}$/.test(l)).slice(0, 25);
      const out = [];
      for (const l of links) {
        const page = await get(`https://jobfound.org${l}`, { retries: 1 });
        await sleep(400);
        if (!page.ok) continue;
        for (const m of page.body.matchAll(/application\/ld\+json">([\s\S]*?)<\/script>/g)) {
          let d; try { d = JSON.parse(m[1]); } catch { continue; }
          if (d['@type'] !== 'JobPosting') continue;
          const req = [].concat(d.applicantLocationRequirements || []).map(x => x.name).filter(Boolean);
          out.push({ id: d.url, company: d.hiringOrganization?.name, title: d.title, location: (req.length ? req.join(' / ') : 'Anywhere') + ' / Remote', url: d.url, postedAt: d.datePosted, internship: /intern/i.test(d.employmentType || ''), text: d.description });
        }
      }
      return out;
    },
  },
};

async function processOthers() {
  state.othersAt ??= {};
  const report = {};
  for (const [src, feed] of Object.entries(OTHERS)) {
    if (state.othersAt[src] && Date.now() - Date.parse(state.othersAt[src]) < feed.everyHours * 3600e3 - 10 * 60e3) continue;
    let items;
    try { items = await feed.fetch(); } catch { items = null; }
    if (!items) { report[src] = { ok: false }; continue; }
    let kept = 0, added = 0, oldest = null;
    const seen = new Set();
    for (const it of items) {
      const name = decode(it.company || '').trim();
      if (!name || !it.title) continue;
      const jobId = `${src}:${slugify(String(it.id))}`;
      seen.add(jobId);
      const t = Date.parse(it.postedAt);
      if (t && (oldest === null || t < oldest)) oldest = t;
      const id = companyIdFor(name, `${src}:${slugify(name)}`);
      if (isExcluded(id)) continue;
      // A board that names a US headquarters (We Work Remotely does) rules the company out.
      if (it.hq && placesOf(it.hq).includes('United States')) { exclude(id, `US headquarters (${feed.label})`); continue; }
      const isNew = !byId.has(id);
      const title = decode(it.title);
      const c = upsertCompany(id, { name, source: src, location: byId.get(id)?.location || it.hq || undefined, logo: byId.get(id)?.logo || it.logo });
      const job = upsertJob(c, {
        id: jobId, src, via: src, title, type: jobType(title, it.internship ? 'intern' : ''),
        location: decode(it.location || ''), remoteFlag: true, url: it.url, applyUrl: it.applyUrl, postedAt: t ? new Date(t).toISOString() : undefined, text: stripHtml(decode(it.text || '')),
      });
      if (job) { kept++; if (isNew) added++; }
    }
    // A feed read to the end: anything missing is gone. Otherwise feeds list the newest jobs, so a
    // listing newer than the oldest one we saw must still be there if it is open.
    if (items.complete) for (const c of db.companies) for (const j of c.jobs) {
      if (j.src === src && j.status === 'open' && !seen.has(j.id)) closeJob(c, j, `Removed from ${feed.label}`);
    } else if (oldest) for (const c of db.companies) for (const j of c.jobs) {
      if (j.src === src && j.status === 'open' && !seen.has(j.id) && Date.parse(j.postedAt || j.firstSeen) > oldest) closeJob(c, j, `Removed from ${feed.label}`);
    }
    state.othersAt[src] = NOW;
    report[src] = { ok: true, listings: items.length, inScope: kept, newCompanies: added };
  }
  sourceReport.others = report;
}

// ---------------------------------------------------------------- headquarters check (Wikidata)
// Job feeds (Jobicy, Arbeitnow, HN) often don't say where a company is based. Wikidata does for
// well-known companies; any company headquartered in the US is excluded. Results are cached.

const COMPANY_DESC_RE = /company|corporation|business|software|startup|platform|service|website|firm|enterprise|developer|exchange|brand|retailer|fintech|bank|provider|maker|manufacturer/i;
async function wikidataCountries(name) {
  const wd = async u => (await get(u, { json: true, retries: 1 })).body;
  const s = await wd(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=7&format=json`);
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hits = (s?.search || []).filter(x => COMPANY_DESC_RE.test(x.description || '') && (norm(x.label) === norm(name) || norm(x.label).startsWith(norm(name))))
    .sort((a, b) => (norm(b.label) === norm(name)) - (norm(a.label) === norm(name)));
  for (const hit of hits.slice(0, 3)) {
    const e = (await wd(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`))?.entities?.[hit.id];
    if (!e) continue;
    const ids = (ent, p) => (ent.claims?.[p] || []).map(c => c.mainsnak.datavalue?.value?.id).filter(Boolean);
    // Headquarters location (P159) first; "country" (P17) lists every market for multinationals, so it
    // is only used when it names a single country.
    let countries = [];
    if (ids(e, 'P159').length) {
      const loc = ids(e, 'P159')[0];
      const le = (await wd(`https://www.wikidata.org/wiki/Special:EntityData/${loc}.json`))?.entities?.[loc];
      countries = le ? ids(le, 'P17') : [];
    }
    if (!countries.length && ids(e, 'P17').length === 1) countries = ids(e, 'P17');
    if (countries.length) return { id: hit.id, countries };
  }
  return null;
}

async function checkHeadquarters() {
  state.wikidata ??= {};
  const due = db.companies.filter(c => !['yc', 'greenhouse', 'lever', 'ashby', 'manual'].includes(c.source))
    .filter(c => !state.wikidata[c.name] || Date.now() - Date.parse(state.wikidata[c.name].at) > 60 * DAY)
    .slice(0, config.wikidataLookupsPerRun ?? 60);
  let us = 0;
  for (const c of due) {
    try {
      const r = await wikidataCountries(c.name);
      state.wikidata[c.name] = { at: NOW, id: r?.id || null, us: !!r?.countries.includes('Q30') };
    } catch { continue; }
    await sleep(150);
  }
  // allowCompanies overrides a wrong automatic match (and lets a wrongly excluded company back in).
  const allow = new Set(Object.keys(config.allowCompanies || {}).filter(n => n !== '_note'));
  for (const name of allow) {
    if (state.wikidata[name]) state.wikidata[name].us = false;
    for (const id of Object.keys(state.excluded || {})) if (id.endsWith(':' + slugify(name)) && /US|India|Hires/.test(state.excluded[id].reason)) delete state.excluded[id];
  }
  for (const c of db.companies) if (state.wikidata[c.name]?.us && !allow.has(c.name)) { exclude(c.id, 'US headquarters (Wikidata)'); us++; }
  const manualList = config.excludeCompanies || {};
  for (const c of db.companies) if (manualList[c.name] && c.name !== '_note') exclude(c.id, manualList[c.name] + ' (config)');
  sourceReport.headquarters = { checked: due.length, usExcluded: us };
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
      const job = upsertJob(c, { id: jobId, src: 'manual', title: mj.title, type: mj.type || jobType(mj.title), location: mj.location || m.location, remoteFlag: !!mj.remote, url: mj.url });
      if (!job || !mj.url) continue;
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
await processJobicy();
await processArbeitnow();
await processOthers();
await checkHeadquarters();
await processManual();
await verifyYC();

// Re-apply the scope to every stored role, so rule changes also clean up old data.
for (const c of [...db.companies]) {
  const why = isExcluded(c.id) ? state.excluded[c.id].reason : exclusionOf(c, c.jobs.map(j => j.location));
  if (why) { exclude(c.id, why); removeCompany(c); prevStatus.delete(c.id); continue; }
  for (const p of c.contacts) if (p.location && placesOf(p.location).includes('United States')) delete p.location;
  c.regions = (c.regions || []).filter(r => !/america|united states/i.test(r));
  for (const j of c.jobs) {
    delete j.markets; // legacy field from before the six-region model
    // Stored before the internship rules were tightened: working-student / apprentice / trainee jobs.
    if (j.type === 'internship' && !INTERN_RE.test(j.title) && WORKSTUDENT_RE.test(j.title)) j.type = 'job';
  }
  const ctx = companyContext(c);
  c.jobs = c.jobs.filter(j => {
    const s = scopeOf(j, ctx);
    if (s.ok) { applyScope(j, s); j.track = trackOf(j.title); j.remote = true; j.tech = true; }
    return s.ok;
  });
  // Points of contact: HR / talent, founders & CTOs, VPs, directors and heads only (no partnerships).
  c.contacts = (c.contacts || []).filter(p => (p.team = teamOf(p)));
  c.linkedin = normLinkedIn(c.linkedin) || undefined;
  if (c.channels?.social?.linkedin) {
    const li = normLinkedIn(c.channels.social.linkedin);
    if (li) c.channels.social.linkedin = li; else delete c.channels.social.linkedin;
  }
  if (!c.jobs.length) { removeCompany(c); prevStatus.delete(c.id); }
}

// Merge companies that turned out to be the same business (same website domain).
// (Name-based merging happens below, after domain merging.)
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

// Merge companies with the same name from different feeds (e.g. "Proxify" and "Proxify AB").
{
  const keepByName = new Map();
  const rank = c => (SOURCE_RANK[c.source] ?? 5);
  for (const c of [...db.companies].sort((a, b) => rank(a) - rank(b) || a.firstSeen.localeCompare(b.firstSeen))) {
    const k = normCo(c.name);
    const keep = keepByName.get(k);
    if (!keep) { keepByName.set(k, c); continue; }
    for (const j of c.jobs) if (!keep.jobs.some(x => x.id === j.id)) keep.jobs.push(j);
    for (const p of c.contacts) addContact(keep, p);
    for (const src of c.sources || []) if (!keep.sources.includes(src)) keep.sources.push(src);
    removeCompany(c); prevStatus.delete(c.id);
  }
}
// The same role listed twice (two feeds, or one per city): keep one, with all its places.
for (const c of db.companies) {
  const first = new Map();
  const pref = j => (['greenhouse', 'lever', 'ashby', 'yc'].includes(j.src) ? 0 : 1);
  for (const j of [...c.jobs].filter(j => j.status === 'open').sort((a, b) => pref(a) - pref(b))) {
    const k = normCo(j.title) + '|' + j.type;
    const keep = first.get(k);
    j.dup = false;
    if (!keep) { first.set(k, j); continue; }
    j.dup = true;
    keep.places = SCOPE_COUNTRIES.filter(x => keep.places?.includes(x) || j.places?.includes(x));
    keep.worldwide = keep.worldwide || j.worldwide || undefined;
    keep.regions = regionsOf(keep.places);
    keep.remoteScope = countryLabel(keep.places, keep.worldwide ? ['Worldwide'] : []);
  }
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
  const open = c.jobs.filter(j => j.status === 'open' && !j.dup);
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
  for (const j of c.jobs) if (/linkedin\.com\/jobs/i.test(`${j.url} ${j.applyUrl || ''}`)) j.via = 'linkedin';
  const placesFrom = c.jobs.some(j => j.status === 'open') ? c.jobs.filter(j => j.status === 'open') : c.jobs;
  c.places = [...new Set(placesFrom.flatMap(j => j.places || []))];
  c.markets = regionsOf(c.places);
  // Primary country: the HQ country if it is one of the five and its roles are open there, else the
  // country most of its internships name.
  const tally = {};
  for (const j of placesFrom) for (const p of j.places || []) tally[p] = (tally[p] || 0) + 1;
  const hq = companyContext(c).find(p => tally[p]);
  c.country = hq || Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  c.region = c.country ? REGION_OF[c.country] : null;
  c.jobs.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.type === 'internship' ? -1 : 0) - (b.type === 'internship' ? -1 : 0));
}

// Prune jobs that have been closed for 30+ days (company row stays, red).
for (const c of db.companies) c.jobs = c.jobs.filter(j => j.status === 'open' || Date.now() - Date.parse(j.closedAt) < 30 * DAY);

db.companies.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.name.localeCompare(b.name));
// "What changed" only keeps events for companies and internships still on the site.
{
  const titles = new Map(db.companies.map(c => [c.id, new Set(c.jobs.map(j => j.title))]));
  db.events = db.events.filter(e => titles.has(e.companyId) && (!e.job || titles.get(e.companyId).has(e.job)));
}
db.events = db.events.slice(0, 400);

// Count only companies that survived this run's scope checks.
today.companiesAdded = db.companies.filter(c => c.firstSeen === NOW).length;
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
  regionOf: Object.fromEntries(SCOPE_COUNTRIES.map(c => [c, REGION_OF[c]])),
  regions: [...new Set(SCOPE_COUNTRIES.map(c => REGION_OF[c]))].sort(),
  scopeCountries: SCOPE_COUNTRIES,
  countries: [...new Set(all.flatMap(c => c.jobs.flatMap(j => j.places || [])))].filter(p => SCOPE_COUNTRIES.includes(p)).sort((a, b) => a.localeCompare(b, 'en')),
  runSeconds: Math.round((Date.now() - t0) / 1000),
  sources: sourceReport,
  // Last result per source, kept across runs (sources run on different schedules).
  sourceStats: (() => {
    const stats = { ...(db.meta.sourceStats || {}) };
    const put = (key, ok, read, note) => { stats[key] = { at: NOW, ok, read, note }; };
    const r = sourceReport;
    if (r.ycDiscover) put('yc', r.ycDiscover.ok, r.ycDiscover.checked || 0, `${r.ycDiscover.added || 0} new startups`);
    else if (r.ycVerify) put('yc', r.ycVerify.ok, r.ycVerify.checked || 0, 'Re-checked YC pages');
    if (r.hn) put('hn', r.hn.ok, r.hn.posts || 0, (r.hn.threads || []).join(', '));
    if (r.ats) put('ats', r.ats.ok, r.ats.fetched || 0, `${r.ats.boards} company job boards`);
    if (r.jobicy) put('jobicy', r.jobicy.ok, r.jobicy.listings || 0, '');
    if (r.arbeitnow) put('arbeitnow', r.arbeitnow.ok, r.arbeitnow.remoteListings || 0, 'remote listings');
    for (const [k, v] of Object.entries(r.others || {})) put(k, v.ok, v.listings || 0, '');
    return stats;
  })(),
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
