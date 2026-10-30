#!/usr/bin/env node
// Builds the points of contact for each company in data/leads.json:
//   1. Website scan (free): careers / HR mailboxes, phone numbers, social profiles and
//      contact / careers pages from the company's own site.
//   2. Prospeo company lookup (needs PROSPEO_API_KEY): headquarters country (US / India HQs are
//      dropped) and the company's LinkedIn page, accepted only when Prospeo's record has the same
//      website as ours (or, with no website, the same name plus our open roles or country).
//   3. Prospeo people: HR / talent, founders & CTOs, VPs, directors and heads (no partnerships),
//      with LinkedIn and verified emails (credit-capped).
//   4. Email validation: every published email must have a working mail server (MX record) and be
//      verified by Prospeo, published on the company's own site, or confirmed by ZeroBounce
//      (ZEROBOUNCE_API_KEY). Emails that fail are removed and never added again.
//
//   node scripts/contacts.mjs                       # scan + Prospeo (if key set)
//   flags: --crawl-limit=N  --skip-scan  --import=a.json,b.json  (import saved Prospeo responses)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import { isFocusPlaces, SCOPE_COUNTRIES } from './markets.mjs';
import { teamOf, isTalentMailbox, normLinkedIn } from './people.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEADS_FILE = path.join(ROOT, 'data/leads.json');
const STATE_FILE = path.join(ROOT, 'data/state.json');
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const cfg = config.contacts;

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const DAY = 86400e3;
const UA = `Mozilla/5.0 (compatible; StartupLeadsBot/1.0; +https://github.com/${config.repo})`;
const API_KEY = process.env.PROSPEO_API_KEY;
const ZB_KEY = process.env.ZEROBOUNCE_API_KEY;

const db = JSON.parse(await fs.readFile(LEADS_FILE, 'utf8'));
const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
state.prospeo ??= { credits: {} };
state.badEmails ??= {};
// The contact rules changed (v2: HR / founders & CTO / VPs, directors, heads; v3: people matched by
// Prospeo company id and second domains): search every company again.
if ((state.contactRules || 0) < 3) {
  for (const c of db.companies) { delete c.prospeoAt; for (const p of c.contacts || []) delete p.enrichedAt; }
  state.contactRules = 3;
}
const report = {};

const domainOf = u => { if (!u || u === 'undefined') return null; try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const byDomain = new Map();
for (const c of db.companies) {
  if (!c.domain || c.domain === 'undefined') c.domain = domainOf(c.website);
  if (c.domain && !byDomain.has(c.domain)) byDomain.set(c.domain, c);
}

// ---------------------------------------------------------------- classification

function addPerson(c, p) {
  c.contacts ??= [];
  const key = x => (x.linkedin || x.email || x.name || '').toLowerCase().replace(/\/$/, '');
  const k = key(p);
  if (!k) return;
  const existing = c.contacts.find(x => key(x) === k || (p.name && x.name && x.name.toLowerCase() === p.name.toLowerCase()));
  if (existing) {
    for (const [f, v] of Object.entries(p)) if (v != null && v !== '' && (existing[f] == null || existing[f] === '')) existing[f] = v;
    existing.team ??= p.team;
    return existing;
  }
  c.contacts.push(p);
  return p;
}

// ---------------------------------------------------------------- 1. website scan

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', commat: '@', period: '.' };
const decode = s => String(s ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const text = html => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
    const html = (await res.text()).slice(0, 1_500_000);
    return { html, url: res.url };
  } catch { return null; }
}

const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp|avif|css|js)$|@(?:sentry|.*\.sentry\.io|wixpress\.com|example\.(?:com|org)|domain\.com|email\.com|yourdomain|company\.com|2x\.|3x\.)|^(?:u00|x22)|noreply|no-reply|donotreply/i;
const SOCIAL = [
  ['linkedin', /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|school|showcase)\/[^/?#]+/i],
  ['twitter', /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|search|hashtag)[A-Za-z0-9_]{2,}/i],
  ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/)[A-Za-z0-9_.]{2,}/i],
  ['facebook', /^https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|dialog|tr\b)[A-Za-z0-9_.-]{2,}/i],
  ['github', /^https?:\/\/(?:www\.)?github\.com\/(?!features|about|login|sponsors)[A-Za-z0-9_-]{2,}\/?$/i],
  ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)[^/?#]+/i],
  ['crunchbase', /^https?:\/\/(?:www\.)?crunchbase\.com\/organization\/[^/?#]+/i],
];
const PAGE_KINDS = [
  ['contact', /contact|get-in-touch|reach-us|talk-to/i],
  ['careers', /careers?|jobs|join-?us|work-with-us|hiring|open-roles|openings/i],
  ['partners', /partner|alliances|affiliate|reseller/i],
  ['team', /\/(?:team|about|about-us|company|leadership|people)\/?$/i],
  ['press', /press|media-kit|newsroom/i],
];

function normPhone(raw) {
  const p = decode(raw).replace(/[^\d+]/g, '');
  const digits = p.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15 || /^(\d)\1+$/.test(digits) || /555-?01\d\d$|5550\d\d\d$|1234567/.test(digits)) return null;
  return decode(raw).replace(/^tel:/i, '').replace(/%20/g, ' ').trim();
}

// Keyed by digits so "+1 (561) 250 8998" and "+15612508998" collapse; keep the readable form.
function addPhone(ch, phone, page) {
  const key = phone.replace(/\D/g, '').slice(-10);
  const prev = ch.phones.get(key);
  if (!prev || (/\s/.test(phone) && !/\s/.test(prev.phone))) ch.phones.set(key, { phone: phone.replace(/\s+/g, ' '), page });
}

function harvest(c, page, ch) {
  const { html, url } = page;
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => decode(m[1]).trim());
  for (const h of hrefs) {
    if (/^mailto:/i.test(h)) {
      const e = decodeURIComponent(h.slice(7).split('?')[0]).toLowerCase().trim();
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && !BAD_EMAIL.test(e)) ch.emails.set(e, url);
    } else if (/^tel:/i.test(h)) {
      const p = normPhone(h);
      if (p) addPhone(ch, p, url);
    } else if (/^https?:/i.test(h)) {
      for (const [k, re] of SOCIAL) if (!ch.social[k] && re.test(h)) ch.social[k] = h.match(re)[0];
    }
  }
  const t = text(html);
  for (const m of t.matchAll(/[a-z0-9._%+-]+\s?(?:@|\[at\]|\(at\))\s?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) {
    const e = m[0].replace(/\s?(?:\[at\]|\(at\))\s?/i, '@').replace(/\s/g, '').toLowerCase();
    if (BAD_EMAIL.test(e)) continue;
    const d = e.split('@')[1];
    if (c.domain && (d === c.domain || d.endsWith(`.${c.domain}`) || c.domain.endsWith(d))) ch.emails.set(e, url);
  }
  for (const m of t.matchAll(/(?:\+\d{1,3}[\s.-]?)\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,5}/g)) {
    const p = normPhone(m[0]);
    if (p && ch.phones.size < 6) addPhone(ch, p, url);
  }
  return hrefs;
}

async function scanSite(c) {
  const base = /^https?:/.test(c.website) ? c.website : `https://${c.website}`;
  const ch = { emails: new Map(), phones: new Map(), social: {}, pages: {} };
  const home = await fetchPage(base);
  if (!home) { c.scan = { at: NOW, ok: false }; return false; }
  const origin = new URL(home.url).origin;
  const hrefs = harvest(c, home, ch);
  const internal = [...new Set(hrefs
    .map(h => { try { return new URL(h, home.url); } catch { return null; } })
    .filter(u => u && /^https?:$/.test(u.protocol) && (u.origin === origin || domainOf(u.href)?.endsWith(c.domain || '#')) && !/\.(pdf|png|jpe?g|svg|zip)$/i.test(u.pathname))
    .map(u => u.origin + u.pathname.replace(/\/$/, '')))];
  for (const [kind, re] of PAGE_KINDS) {
    const hit = internal.find(u => re.test(new URL(u).pathname));
    if (hit) ch.pages[kind] = hit;
  }
  if (!ch.pages.contact) ch.pages.contactGuess = `${origin}/contact`;
  const toVisit = [ch.pages.contact || ch.pages.contactGuess, ch.pages.careers, ch.pages.partners, ch.pages.team].filter(Boolean).slice(0, 4);
  for (const u of toVisit) {
    const p = await fetchPage(u);
    if (p) { harvest(c, p, ch); if (u === ch.pages.contactGuess) ch.pages.contact = u; }
  }
  delete ch.pages.contactGuess;
  // careers pages hosted on ATS domains count too
  if (!ch.pages.careers && c.careersUrl) ch.pages.careers = c.careersUrl;

  c.channels = {
    emails: [...ch.emails].filter(([email]) => isTalentMailbox(email) && !state.badEmails[email]).slice(0, 6).map(([email, page]) => ({ email, team: 'Talent & HR', page })),
    phones: [...new Map([...ch.phones.values()].map(x => [x.phone.replace(/\D/g, '').slice(-10), x])).values()].slice(0, 6),
    social: { ...(c.channels?.social || {}), ...ch.social },
    pages: ch.pages,
  };
  c.siteLinkedin = normLinkedIn(ch.social.linkedin) || undefined;
  c.scan = { at: NOW, ok: true };
  return true;
}

async function scanSites() {
  const limit = +(args['crawl-limit'] || cfg.websiteScansPerRun);
  const due = db.companies
    .filter(c => c.website && (!c.scan || Date.now() - Date.parse(c.scan.at) > cfg.rescanDays * DAY))
    .sort((a, b) => (a.scan ? 1 : 0) - (b.scan ? 1 : 0) || isFocusPlaces(b.places) - isFocusPlaces(a.places) || (a.status === 'open' ? -1 : 1))
    .slice(0, limit);
  let ok = 0;
  const queue = [...due];
  await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) {
    const c = queue.shift();
    try { if (await scanSite(c)) ok++; } catch (e) { c.scan = { at: NOW, ok: false, error: String(e.message || e).slice(0, 120) }; }
  } }));
  report.websites = { scanned: due.length, ok };
}

// ---------------------------------------------------------------- 2. Prospeo people + verified emails

// Substring match on job titles; results are then checked against the contact rules (people.mjs).
const TITLES = ['talent', 'recruit', 'human resources', 'people operations', 'people partner', 'head of people', 'chief people', 'hr manager', 'hr business partner', 'hr director', 'hr lead', 'hr generalist', 'head of hr', 'hrbp', 'campus', 'university relations', 'early careers',
  'founder', 'chief technology', 'cto', 'vp', 'vice president', 'director', 'head of', 'geschäftsführer'];
const LEADER_TITLES = ['founder', 'chief technology', 'cto', 'talent', 'recruit', 'human resources', 'head of people', 'hr manager', 'head of hr'];
const TWO_PART_TLD = /\.(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;
const registrable = d => d.split('.').slice(TWO_PART_TLD.test(d) ? -3 : -2).join('.');

// People results are matched back to our companies by website, or by Prospeo's company id (the
// company lookup can find a company under a second domain, e.g. tether.io / tether.to).
const byRegistrable = new Map();
const byProspeoId = new Map();
function indexCompanies() {
  for (const c of db.companies) {
    for (const d of [c.domain, c.hq?.domain]) {
      if (!d) continue;
      if (!byDomain.has(d)) byDomain.set(d, c);
      if (!byRegistrable.has(registrable(d))) byRegistrable.set(registrable(d), c);
    }
    if (c.hq?.companyId) byProspeoId.set(c.hq.companyId, c);
  }
}
const companyForResult = co => {
  const d = (co?.domain || domainOf(co?.website) || '').toLowerCase();
  return byProspeoId.get(co?.company_id) || byDomain.get(d) || byRegistrable.get(registrable(d));
};

const normName = s => String(s || '').toLowerCase().replace(/\b(gmbh|plc|ag|ltd|limited|inc|oy|sas|bv|llc)\b|\(.*?\)|[^a-z0-9]/g, '');
const excludedNow = new Set();

// Companies whose Prospeo record puts the headquarters in the US are dropped (site rule: no USA).
function excludeCompany(c, reason) {
  state.excluded ??= {};
  state.excluded[c.id] = { reason, at: NOW };
  excludedNow.add(c.id);
  const i = db.companies.indexOf(c);
  if (i >= 0) db.companies.splice(i, 1);
  db.events = (db.events || []).filter(e => e.companyId !== c.id);
}

function handleSearchResults(results, { resolve = companyForResult, strict = false } = {}) {
  let added = 0;
  for (const r of results || []) {
    const p = r.person || {};
    const c = resolve(r.company);
    if (!c || excludedNow.has(c.id)) continue;
    if (r.company?.location?.country_code === 'US') { excludeCompany(c, 'US headquarters (Prospeo)'); continue; }
    if (!c.website && r.company?.website) { c.website = r.company.website; c.domain = domainOf(r.company.website); }
    if (r.company?.linkedin_url) c.prospeoLinkedin ??= normLinkedIn(r.company.linkedin_url) || undefined;
    const title = strict ? p.current_job_title : (p.current_job_title || p.headline);
    const team = teamOf({ title });
    if (!p.full_name || !team) continue;
    const revealed = p.email?.revealed && p.email?.email && !p.email.email.includes('*') && !state.badEmails[p.email.email.toLowerCase()] ? p.email.email.toLowerCase() : undefined;
    // Site rule: no US data anywhere, so a US-based person's location isn't stored.
    const loc = p.location && p.location.country_code !== 'US' && !/united states/i.test(p.location.country || '') ? [p.location.city, p.location.country].filter(Boolean).join(', ') : undefined;
    addPerson(c, {
      name: p.full_name, title, team,
      linkedin: p.linkedin_url, location: loc, source: 'Prospeo', personId: p.person_id,
      emailStatus: p.email?.status || undefined, email: revealed, mobileStatus: p.mobile?.status || undefined,
    });
    added++;
  }
  return added;
}

function handleEnriched(matched) {
  let found = 0;
  const byPid = new Map(db.companies.flatMap(c => (c.contacts || []).filter(x => x.personId).map(x => [x.personId, x])));
  for (const m of matched || []) {
    const p = m.person || {};
    const target = byPid.get(m.identifier) || byPid.get(p.person_id);
    if (!target) continue;
    target.enrichedAt = NOW;
    const email = typeof p.email === 'string' ? p.email : p.email?.email;
    if (email && !email.includes('*') && !state.badEmails[email.toLowerCase()]) { target.email = email.toLowerCase(); target.emailStatus = p.email?.status || 'VERIFIED'; found++; }
    const mobile = p.mobile?.revealed !== false ? (p.mobile?.mobile_international || p.mobile?.mobile) : null;
    if (mobile && !mobile.includes('*')) target.phone = mobile;
  }
  return found;
}

// Prospeo rate-limits per minute: space calls out and back off on HTTP 429.
async function prospeo(endpoint, body) {
  for (let attempt = 0; ; attempt++) {
    await new Promise(r => setTimeout(r, 1200));
    const res = await fetch(`https://api.prospeo.io/${endpoint}`, {
      method: 'POST',
      headers: { 'X-KEY': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, 15000 * (attempt + 1))); continue; }
    if (!res.ok || json.error) throw new Error(`${endpoint}: HTTP ${res.status} ${json.error_code || json.message || ''}`);
    return json;
  }
}

const spent = () => state.prospeo.credits[TODAY] || 0;
const spend = n => { state.prospeo.credits[TODAY] = spent() + n; };
const TEAM_PRIORITY = { 'Talent & HR': 0, 'Founders & CTO': 1, 'Leadership': 2 };

async function prospeoPeople() {
  const budget = cfg.prospeoDailyCredits;
  indexCompanies();
  // Find people at companies we haven't searched yet (search pages cost 1 credit each).
  const due = db.companies
    .filter(c => c.domain && !c.prospeoAt && !/(^|\.)(github\.io|notion\.site|vercel\.app|linkedin\.com)$/.test(c.domain))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || isFocusPlaces(b.places) - isFocusPlaces(a.places) || b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, cfg.prospeoCompaniesPerRun);
  let people = 0, pages = 0;
  for (let i = 0; i < due.length && spent() < budget; i += 25) {
    const batch = due.slice(i, i + 25);
    for (let page = 1; page <= 6 && spent() < budget; page++) {
      let r;
      try {
        r = await prospeo('search-person', {
          page,
          filters: {
            company: { websites: { include: [...new Set(batch.flatMap(c => [c.domain, c.hq?.domain]).filter(Boolean).map(registrable))] } },
            person_job_title: { include: TITLES, match_mode: 'CONTAINS' },
            max_person_per_company: cfg.peoplePerCompany,
          },
        });
      } catch (e) {
        if (/NO_RESULTS/i.test(e.message)) break;
        report.prospeo = { error: e.message }; return;
      }
      spend(1); pages++;
      people += handleSearchResults(r.results);
      if (page >= (r.pagination?.total_page || 1)) break;
    }
    for (const c of batch) c.prospeoAt = NOW;
  }
  // Companies from job feeds often have no website: look up their C-Suite by company name instead.
  const dueNames = db.companies
    .filter(c => !c.domain && !c.prospeoAt && c.status === 'open')
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, cfg.prospeoCompaniesPerRun);
  for (let i = 0; i < dueNames.length && spent() < budget; i += 25) {
    const batch = dueNames.slice(i, i + 25);
    const byNorm = new Map(batch.map(c => [normName(c.name), c]));
    for (let page = 1; page <= 4 && spent() < budget; page++) {
      let r;
      try {
        r = await prospeo('search-person', {
          page,
          filters: {
            company: { names: { include: batch.map(c => c.name) } },
            person_job_title: { include: LEADER_TITLES, match_mode: 'CONTAINS' },
            max_person_per_company: 4,
          },
        });
      } catch (e) {
        if (/NO_RESULTS/i.test(e.message)) break;
        report.prospeo = { error: e.message }; return;
      }
      spend(1); pages++;
      people += handleSearchResults(r.results, { resolve: co => byNorm.get(normName(co?.name)), strict: true });
      if (page >= (r.pagination?.total_page || 1)) break;
    }
    for (const c of batch) c.prospeoAt = NOW;
  }
  // Reveal verified emails, recruiters & HR first, then founders & CTOs, within the daily credit cap.
  const queue = db.companies.flatMap(c => (c.contacts || []).filter(x => x.personId && !x.email && !x.enrichedAt && x.emailStatus === 'VERIFIED'))
    .sort((a, b) => TEAM_PRIORITY[a.team] - TEAM_PRIORITY[b.team]);
  let emails = 0;
  while (queue.length && spent() < budget) {
    const batch = queue.splice(0, Math.min(50, budget - spent()));
    let r;
    try {
      r = await prospeo('bulk-enrich-person', { only_verified_email: true, data: batch.map(x => ({ identifier: x.personId, person_id: x.personId })) });
    } catch (e) { report.prospeo = { error: e.message, people, pages, emails }; return; }
    spend(r.total_cost ?? batch.length);
    for (const x of batch) x.enrichedAt = NOW;
    emails += handleEnriched(r.matched);
  }
  report.prospeo = { companiesSearched: due.length + dueNames.length, people, searchPages: pages, emailsRevealed: emails, creditsToday: spent(), pendingEmails: queue.length, excludedUS: excludedNow.size };
}

// Verified mobiles for each hiring company's founders and CTO (founder-CEO first, then CTO, then other
// founders), newest companies first, under a separate daily credit cap. Prospeo charges 10 credits per number found.
const mobileRank = t => (/\bceo\b|chief executive|geschäftsführer|managing director/i.test(t) ? 0 : /\bcto\b|chief technology/i.test(t) ? 1 : /founder/i.test(t) ? 2 : 3);
const liKey = url => 'li' + String(url || '').toLowerCase().replace(/^.*\/in\//, '').replace(/[^a-z0-9]/g, '').slice(0, 60);

async function prospeoMobiles() {
  const budget = cfg.prospeoMobileDailyCredits ?? 0;
  if (!budget) return;
  state.prospeo.mobileCredits ??= {};
  const used = () => state.prospeo.mobileCredits[TODAY] || 0;
  const retryAfter = 90 * DAY;
  const queue = db.companies
    .filter(c => c.status === 'open')
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .flatMap(c => (c.contacts || [])
      .filter(p => teamOf(p) === 'Founders & CTO' && !p.phone && p.mobileStatus !== 'UNAVAILABLE' && (p.personId || p.linkedin)
        && (!p.mobileTriedAt || Date.now() - Date.parse(p.mobileTriedAt) > retryAfter))
      .sort((a, b) => mobileRank(a.title) - mobileRank(b.title))
      .slice(0, cfg.mobilesPerCompany ?? 2)
      .map(p => ({ c, p })));
  let tried = 0, found = 0, moved = 0;
  // Each batch is sized so that even if every lookup hits, the daily cap can't be exceeded.
  while (queue.length && used() + 10 <= budget) {
    const batch = queue.splice(0, Math.min(25, Math.floor((budget - used()) / 10)));
    const byKey = new Map(batch.map(x => [x.p.personId || liKey(x.p.linkedin), x]));
    const data = batch.map(({ c, p }) => p.personId
      ? { identifier: p.personId, person_id: p.personId }
      : { identifier: liKey(p.linkedin), linkedin_url: p.linkedin, full_name: p.name, company_name: c.name, ...(c.domain ? { company_website: c.domain } : {}) });
    let r;
    try {
      r = await prospeo('bulk-enrich-person', { enrich_mobile: true, only_verified_mobile: true, data });
    } catch (e) { report.mobiles = { error: e.message, tried, found }; return; }
    state.prospeo.mobileCredits[TODAY] = used() + (r.total_cost ?? 0);
    for (const { p } of batch) p.mobileTriedAt = NOW;
    tried += batch.length;
    for (const m of r.matched || []) {
      const hit = byKey.get(m.identifier);
      if (!hit) continue;
      const { c, p } = hit;
      const co = m.company;
      // Only attach a number if Prospeo still places the person at this company.
      if (co && c.domain && registrable(domainOf(co.website || co.domain) || '') !== registrable(c.domain) && normName(co.name) !== normName(c.name)) { moved++; continue; }
      const mobile = m.person?.mobile?.mobile_international || m.person?.mobile?.mobile;
      if (!mobile || mobile.includes('*')) continue;
      p.phone = mobile;
      p.mobileStatus = 'VERIFIED';
      p.personId ??= m.person.person_id;
      const email = m.person?.email?.email;
      if (email && !email.includes('*') && !p.email && !state.badEmails[email.toLowerCase()]) { p.email = email.toLowerCase(); p.emailStatus = 'VERIFIED'; }
      found++;
    }
  }
  report.mobiles = { tried, found, skippedMoved: moved, creditsToday: used(), dailyCap: budget, waiting: queue.length };
}

// ---------------------------------------------------------------- 3. Prospeo company lookup (HQ + LinkedIn)

const SCOPE_ISO = ['AU', 'DE', 'SG', 'AE', 'GB'];
const sameTitle = (a, b) => { a = a.toLowerCase(); b = b.toLowerCase(); return a === b || (Math.min(a.length, b.length) > 12 && (a.includes(b) || b.includes(a))); };

async function prospeoCompanies() {
  const budget = cfg.prospeoCompanyDailyCredits ?? 0;
  state.prospeo.companyCredits ??= {};
  const used = () => state.prospeo.companyCredits[TODAY] || 0;
  const due = db.companies
    .filter(c => !c.hqAt || Date.now() - Date.parse(c.hqAt) > 90 * DAY || (c.hq?.matchedBy && !c.hq.companyId))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.firstSeen.localeCompare(a.firstSeen));
  let looked = 0, matched = 0, linkedin = 0, dropped = 0;
  for (const c of due) {
    if (used() >= budget) break;
    const data = { company_name: c.name };
    if (c.domain) data.company_website = c.domain;
    let r;
    try { r = await prospeo('enrich-company', { data }); } catch (e) {
      if (/NO_MATCH|NOT_FOUND|404/i.test(e.message)) { c.hqAt = NOW; c.hq = { found: false }; looked++; continue; }
      report.companies = { error: e.message, looked, matched }; return;
    }
    looked++;
    c.hqAt = NOW;
    const co = r.company || r.data?.company;
    if (!r.free_enrichment) state.prospeo.companyCredits[TODAY] = used() + 1;
    if (!co) { c.hq = { found: false }; continue; }
    // Same company? Same website; or, for companies we only know by name, the same name plus one of
    // our open roles in Prospeo's job list, or a headquarters in one of the five countries.
    const sameSite = c.domain && registrable(domainOf(co.website || co.domain) || '') === registrable(c.domain);
    const sameName = normName(co.name) === normName(c.name);
    const roleMatch = (co.job_postings?.active_titles || []).some(t => c.jobs.some(j => sameTitle(j.title, t)));
    const how = sameSite ? 'website' : !c.domain && sameName && roleMatch ? 'name + open roles' : !c.domain && sameName && SCOPE_ISO.includes(co.location?.country_code) ? 'name + country' : null;
    if (!how) { c.hq = { found: true, matchedBy: null }; continue; }
    matched++;
    c.hq = {
      matchedBy: how, country: co.location?.country || undefined, countryCode: co.location?.country_code || undefined, city: co.location?.city || undefined,
      linkedin: normLinkedIn(co.linkedin_url) || undefined, employees: co.employee_count || undefined, founded: co.founded || undefined,
      companyId: co.company_id || undefined, domain: co.domain || undefined,
    };
    if (c.hq.linkedin) linkedin++;
    if (!c.website && co.website) { c.website = co.website; c.domain = domainOf(co.website); }
    const hqPhone = co.phone_hq?.phone_hq_international;
    if (hqPhone && co.phone_hq.phone_hq_country_code !== 'US') {
      c.channels ??= { emails: [], phones: [], social: {}, pages: {} };
      c.channels.phones ??= [];
      if (!c.channels.phones.some(x => x.phone.replace(/\D/g, '').slice(-9) === hqPhone.replace(/\D/g, '').slice(-9))) c.channels.phones.unshift({ phone: hqPhone, page: 'Prospeo' });
    }
    if (c.hq.countryCode === 'US') { excludeCompany(c, 'US headquarters (Prospeo)'); dropped++; }
    else if (c.hq.countryCode === 'IN') { excludeCompany(c, 'India headquarters (Prospeo)'); dropped++; }
  }
  report.companies = { looked, matched, linkedinFound: linkedin, droppedUSorIndia: dropped, creditsToday: used(), dailyCap: budget, waiting: Math.max(0, due.length - looked) };
}

// Company LinkedIn page, most reliable source first: Prospeo matched by website, YC's profile, the
// company's own website, Prospeo matched by name, then a person search result.
function pickLinkedIn(c) {
  // Companies scanned before the source was recorded: their LinkedIn link came from the website scan.
  if (!('siteLinkedin' in c) && c.scan?.ok && c.source !== 'yc') c.siteLinkedin = normLinkedIn(c.channels?.social?.linkedin) || null;
  // YC companies stored before ycLinkedin existed: their LinkedIn link came from the YC profile.
  if (!('ycLinkedin' in c) && c.source === 'yc') c.ycLinkedin = normLinkedIn(c.linkedin) || null;
  const options = [
    [c.hq?.matchedBy === 'website' && c.hq.linkedin, 'Prospeo (same website)'],
    [c.source === 'yc' && c.ycLinkedin, 'Y Combinator profile'],
    [c.siteLinkedin, 'company website'],
    [c.hq?.linkedin, `Prospeo (${c.hq?.matchedBy})`],
    [c.prospeoLinkedin, 'Prospeo people search'],
  ];
  const hit = options.find(([u]) => normLinkedIn(u));
  if (hit) { c.linkedin = normLinkedIn(hit[0]); c.linkedinVia = hit[1]; }
  else { delete c.linkedin; delete c.linkedinVia; }
  if (c.channels?.social) { if (c.linkedin) c.channels.social.linkedin = c.linkedin; else delete c.channels.social.linkedin; }
}

// ---------------------------------------------------------------- 4. email validation

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
state.mx ??= {};
async function mxOk(domain) {
  const hit = state.mx[domain];
  if (hit && Date.now() - Date.parse(hit.at) < 14 * DAY) return hit.ok;
  let ok;
  try {
    const recs = await Promise.race([dns.resolveMx(domain), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 10000))]);
    ok = recs.some(r => r.exchange && r.exchange !== '.');
  } catch (e) {
    ok = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e.code) ? false : null; // null: DNS didn't answer, decide next run
  }
  if (ok !== null) state.mx[domain] = { ok, at: NOW };
  return ok;
}

// ZeroBounce (optional): status per address, cached 60 days, within a daily credit cap.
state.zb ??= {};
async function zeroBounce(emails) {
  if (!ZB_KEY) return { skipped: 'ZEROBOUNCE_API_KEY not set' };
  state.zbCredits ??= {};
  const cap = cfg.zerobounceDailyCredits ?? 100;
  const todo = emails.filter(e => !state.zb[e] || Date.now() - Date.parse(state.zb[e].at) > 60 * DAY);
  let checked = 0;
  while (todo.length && (state.zbCredits[TODAY] || 0) < cap) {
    const batch = todo.splice(0, Math.min(100, cap - (state.zbCredits[TODAY] || 0)));
    let r;
    try {
      const res = await fetch('https://bulkapi.zerobounce.net/v2/validatebatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: ZB_KEY, email_batch: batch.map(email_address => ({ email_address })) }),
        signal: AbortSignal.timeout(120000),
      });
      r = await res.json();
      if (!res.ok || r.Message || r.error) throw new Error(`HTTP ${res.status} ${r.Message || r.error || ''}`);
    } catch (e) { return { error: String(e.message || e).slice(0, 160), checked }; }
    state.zbCredits[TODAY] = (state.zbCredits[TODAY] || 0) + batch.length;
    for (const x of r.email_batch || []) state.zb[String(x.address).toLowerCase()] = { status: x.status, sub: x.sub_status || undefined, at: NOW };
    checked += batch.length;
  }
  return { checked, creditsToday: state.zbCredits[TODAY] || 0, waiting: todo.length };
}

// A published email must: be well-formed, have a mail server, and be verified by Prospeo, listed on
// the company's own site, or confirmed by ZeroBounce; ZeroBounce "invalid" / "spamtrap" / "abuse" /
// "do_not_mail" always removes it. Removed addresses are remembered and never published again.
const ZB_BAD = new Set(['invalid', 'spamtrap', 'abuse', 'do_not_mail']);
async function validateEmails() {
  const entries = [];
  for (const c of db.companies) {
    for (const p of c.contacts || []) if (p.email || p.emailPending) entries.push({ c, kind: 'person', holder: p, email: (p.email || p.emailPending).toLowerCase(), basis: p.emailStatus === 'VERIFIED' ? 'Prospeo verified' : null });
    for (const e of c.channels?.emails || []) entries.push({ c, kind: 'mailbox', holder: e, email: e.email.toLowerCase(), basis: 'listed on the company website' });
  }
  const domains = [...new Set(entries.map(x => x.email.split('@')[1]))];
  const mx = new Map();
  for (const d of domains) mx.set(d, await mxOk(d));
  const zb = await zeroBounce([...new Set(entries.filter(x => mx.get(x.email.split('@')[1]) === true).map(x => x.email))]);
  let valid = 0, removed = 0, pending = 0;
  const drop = (x, why) => {
    state.badEmails[x.email] = { why, at: NOW };
    delete x.holder.emailPending;
    if (x.kind === 'mailbox') x.holder.remove = true; else { delete x.holder.email; x.holder.emailStatus = 'INVALID'; delete x.holder.emailCheck; }
    removed++;
  };
  for (const x of entries) {
    const z = state.zb[x.email];
    const hasMx = mx.get(x.email.split('@')[1]);
    if (state.badEmails[x.email]) { drop(x, state.badEmails[x.email].why); continue; }
    if (!EMAIL_RE.test(x.email)) { drop(x, 'malformed'); continue; }
    if (hasMx === false) { drop(x, 'domain has no mail server'); continue; }
    if (z && ZB_BAD.has(z.status)) { drop(x, `ZeroBounce: ${z.status}${z.sub ? ` (${z.sub})` : ''}`); continue; }
    const basis = z?.status === 'valid' ? 'ZeroBounce valid' : x.basis;
    if (hasMx === true && basis) {
      if (x.holder.emailPending) { x.holder.email = x.holder.emailPending; delete x.holder.emailPending; }
      x.holder.emailCheck = { mx: true, basis, zeroBounce: z?.status, at: NOW };
      valid++;
    } else {
      // Not confirmed yet (DNS didn't answer, or no verification): held back, not published.
      if (x.holder.email) { x.holder.emailPending = x.holder.email; delete x.holder.email; }
      delete x.holder.emailCheck;
      pending++;
    }
  }
  for (const c of db.companies) if (c.channels?.emails) c.channels.emails = c.channels.emails.filter(e => !e.remove && e.email && e.emailCheck);
  report.emails = { valid, removed, heldBack: pending, zeroBounce: zb };
}

// Responses saved from the Prospeo connector (MCP) can be imported with --import.
async function importSaved(files) {
  let people = 0, emails = 0;
  for (const f of files) {
    let j = JSON.parse(await fs.readFile(f, 'utf8'));
    if (Array.isArray(j) && j[0]?.text) j = JSON.parse(j[0].text);
    const d = j.data || j;
    if (d.results) people += handleSearchResults(d.results);
    if (d.matched) emails += handleEnriched(d.matched);
    for (const dom of d.searchedDomains || []) { const c = byDomain.get(dom); if (c) c.prospeoAt = NOW; }
  }
  report.import = { files: files.length, people, emails };
}

// ---------------------------------------------------------------- run

if (args.import) await importSaved(String(args.import).split(','));
// Company lookup first: it fills in websites for companies only known by name, so they get scanned too.
if (API_KEY) await prospeoCompanies();
if (!args['skip-scan']) await scanSites();
if (API_KEY) { await prospeoPeople(); await prospeoMobiles(); }
else report.prospeo = { skipped: 'PROSPEO_API_KEY not set' };

// Contact rules (people.mjs): HR / talent, founders & CTOs, VPs, directors, heads only. Company
// mailboxes: hiring / HR ones only. US locations are never kept (site rule).
for (const c of db.companies) {
  c.contacts = (c.contacts || []).filter(p => (p.team = teamOf(p)));
  for (const p of c.contacts) if (p.location && /united states|\busa\b/i.test(p.location)) delete p.location;
  if (c.channels?.emails) c.channels.emails = c.channels.emails.filter(e => isTalentMailbox(e.email)).map(e => ({ ...e, team: 'Talent & HR' }));
  pickLinkedIn(c);
}
await validateEmails();
for (const c of db.companies) {
  const rank = p => (p.email ? 0 : 2) + (p.linkedin ? 0 : 1);
  c.contacts.sort((a, b) => TEAM_PRIORITY[a.team] - TEAM_PRIORITY[b.team] || rank(a) - rank(b));
}

const all = db.companies;
db.meta.totals = {
  ...db.meta.totals,
  contacts: all.reduce((n, c) => n + (c.contacts?.length || 0), 0),
  emails: all.reduce((n, c) => n + (c.contacts || []).filter(p => p.email).length + (c.channels?.emails?.length || 0), 0),
  phones: all.reduce((n, c) => n + (c.contacts || []).filter(p => p.phone).length + (c.channels?.phones?.length || 0), 0),
};
db.meta.sources = { ...db.meta.sources, contacts: report };
db.meta.lastContactsAt = NOW;
// Keep only 30 days of the credit ledger.
for (const ledger of [state.prospeo.credits, state.prospeo.mobileCredits || {}, state.prospeo.companyCredits || {}, state.zbCredits || {}]) for (const d of Object.keys(ledger)) if (Date.now() - Date.parse(d) > 30 * DAY) delete ledger[d];

await fs.writeFile(LEADS_FILE, JSON.stringify(db));
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1));
// Tiny file the open dashboards poll, so they only re-download leads.json when it changed.
await fs.writeFile(path.join(ROOT, 'data/version.json'), JSON.stringify({ v: new Date().toISOString() }));
console.log(JSON.stringify({ report, totals: db.meta.totals }, null, 2));
