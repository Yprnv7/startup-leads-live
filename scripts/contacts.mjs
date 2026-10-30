#!/usr/bin/env node
// Builds every point of contact for each company in data/leads.json:
//   1. Website scan (free): careers / HR / partnerships / press emails, phone numbers,
//      social profiles and contact/careers/partner pages from the company's own site.
//   2. Prospeo (needs PROSPEO_API_KEY): named founders, talent acquisition, HR,
//      partnerships and BD people with LinkedIn, plus verified emails (credit-capped).
//
//   node scripts/contacts.mjs                       # scan + Prospeo (if key set)
//   flags: --crawl-limit=N  --import=a.json,b.json  (import saved Prospeo responses)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFocusPlaces } from './markets.mjs';

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

const db = JSON.parse(await fs.readFile(LEADS_FILE, 'utf8'));
const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
state.prospeo ??= { credits: {} };
const report = {};

const domainOf = u => { if (!u || u === 'undefined') return null; try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const byDomain = new Map();
for (const c of db.companies) {
  if (!c.domain || c.domain === 'undefined') c.domain = domainOf(c.website);
  if (c.domain && !byDomain.has(c.domain)) byDomain.set(c.domain, c);
}

// ---------------------------------------------------------------- classification

function teamOf(title = '') {
  if (/recruit|talent|human resources|\bhr\b|\bhrbp\b|people (?:ops|operations|partner|team|lead)|head of people|campus|university|hiring|staffing/i.test(title)) return 'Talent & HR';
  if (/partner(?:ship)?s?\b(?! at)|alliance|business development|\bbd\b|bizdev|ecosystem|channel|strategic relations|developer relations/i.test(title) && !/managing partner|general partner/i.test(title)) return 'Partnerships & BD';
  if (/founder|\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|\bcpo\b|chief|president|owner|managing director|founding/i.test(title)) return 'Founders & leadership';
  if (/sales|growth|marketing|account exec|revenue|customer success/i.test(title)) return 'Sales & growth';
  return 'Other';
}
function emailTeam(local) {
  if (/career|job|hiring|recruit|talent|^hr|people|join|work|campus|intern|resume|cv/i.test(local)) return 'Talent & HR';
  if (/partner|alliance|^bd|business|bizdev|collab|affiliate|reseller/i.test(local)) return 'Partnerships & BD';
  if (/press|media|^pr$|news|comms|brand/i.test(local)) return 'Press';
  if (/sales|growth|marketing|demo/i.test(local)) return 'Sales & growth';
  if (/support|help|care|service|billing|privacy|legal|security|abuse|dpo|compliance/i.test(local)) return 'Support & legal';
  if (/hello|^hi$|info|contact|team|founders?|ceo|office|admin|general|enquir|inquir/i.test(local)) return 'General';
  return 'Other';
}

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
    emails: [...ch.emails].slice(0, 15).map(([email, page]) => ({ email, team: emailTeam(email.split('@')[0]), page })),
    phones: [...new Map([...ch.phones.values()].map(x => [x.phone.replace(/\D/g, '').slice(-10), x])).values()].slice(0, 6),
    social: { ...(c.channels?.social || {}), ...ch.social },
    pages: ch.pages,
  };
  if (c.channels.social.linkedin && !c.linkedin) c.linkedin = c.channels.social.linkedin;
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

// Substring match, so avoid short tokens like "cto" (matches "director") or "coo" ("coordinator").
const CSUITE_TITLES = ['founder', 'ceo', 'chief executive', 'chief technology', 'vp engineering', 'vp of engineering', 'head of engineering', 'managing director', 'geschäftsführer'];
const TITLES = ['talent', 'recruit', 'human resources', 'people operations', 'head of people', 'hr manager', 'hr business partner', 'head of hr', 'hrbp', 'campus', 'university relations', 'partnership', 'alliance', 'business development', 'founder', 'ceo', 'chief'];
const TWO_PART_TLD = /\.(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;
const registrable = d => d.split('.').slice(TWO_PART_TLD.test(d) ? -3 : -2).join('.');

const companyForResult = co => {
  const d = (co?.domain || domainOf(co?.website) || '').toLowerCase();
  return byDomain.get(d) || byRegistrable.get(registrable(d));
};
const byRegistrable = new Map();
for (const c of db.companies) if (c.domain && !byRegistrable.has(registrable(c.domain))) byRegistrable.set(registrable(c.domain), c);

const STRICT_CSUITE_RE = /^(?!.*\bassistant\b)(?!.*\bdirector\b(?!.*managing))(?:.*\b(ceo|cto|chief|co-?founder|founder|president|geschäftsführer|managing director|vp,? (?:of )?engineering|head of engineering)\b)/i;
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
    if (!c.linkedin && r.company?.linkedin_url) c.linkedin = r.company.linkedin_url;
    const title = p.current_job_title || p.headline;
    if (!p.full_name || teamOf(title) === 'Other' || (strict && !STRICT_CSUITE_RE.test(p.current_job_title || ''))) continue;
    const revealed = p.email?.revealed && p.email?.email && !p.email.email.includes('*') ? p.email.email.toLowerCase() : undefined;
    const loc = p.location ? [p.location.city, p.location.country].filter(Boolean).join(', ') : undefined;
    addPerson(c, {
      name: p.full_name, title, team: teamOf(title),
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
    if (email && !email.includes('*')) { target.email = email.toLowerCase(); target.emailStatus = p.email?.status || 'VERIFIED'; found++; }
    const mobile = p.mobile?.revealed !== false ? (p.mobile?.mobile_international || p.mobile?.mobile) : null;
    if (mobile && !mobile.includes('*')) target.phone = mobile;
  }
  return found;
}

async function prospeo(endpoint, body) {
  const res = await fetch(`https://api.prospeo.io/${endpoint}`, {
    method: 'POST',
    headers: { 'X-KEY': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${endpoint}: HTTP ${res.status} ${json.error_code || json.message || ''}`);
  return json;
}

const spent = () => state.prospeo.credits[TODAY] || 0;
const spend = n => { state.prospeo.credits[TODAY] = spent() + n; };
const TEAM_PRIORITY = { 'Talent & HR': 0, 'Partnerships & BD': 1, 'Founders & leadership': 2, 'Sales & growth': 3, Other: 4 };

async function prospeoPeople() {
  const budget = cfg.prospeoDailyCredits;
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
            company: { websites: { include: [...new Set(batch.map(c => registrable(c.domain)))] } },
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
            person_job_title: { include: CSUITE_TITLES, match_mode: 'CONTAINS' },
            max_person_per_company: 2,
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
  // Reveal verified emails, recruiters & partnerships first, within the daily credit cap.
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

// Verified mobiles for each hiring company's top C-Suite (CEO, then CTO, then founders), newest
// companies first, under a separate daily credit cap. Prospeo charges 10 credits per number found.
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
      .filter(p => STRICT_CSUITE_RE.test(p.title || '') && !p.phone && p.mobileStatus !== 'UNAVAILABLE' && (p.personId || p.linkedin)
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
      if (email && !email.includes('*') && !p.email) { p.email = email.toLowerCase(); p.emailStatus = 'VERIFIED'; }
      found++;
    }
  }
  report.mobiles = { tried, found, skippedMoved: moved, creditsToday: used(), dailyCap: budget, waiting: queue.length };
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
if (!args['skip-scan']) await scanSites();
if (API_KEY) { await prospeoPeople(); await prospeoMobiles(); }
else report.prospeo = { skipped: 'PROSPEO_API_KEY not set' };

// Founders from YC / HN keep their team label too.
for (const c of db.companies) {
  for (const p of c.contacts || []) p.team ??= p.source === 'HN' ? 'Talent & HR' : teamOf(p.title);
  const rank = p => (p.email ? 0 : 2) + (p.linkedin ? 0 : 1);
  c.contacts?.sort((a, b) => TEAM_PRIORITY[a.team] - TEAM_PRIORITY[b.team] || rank(a) - rank(b));
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
for (const ledger of [state.prospeo.credits, state.prospeo.mobileCredits || {}]) for (const d of Object.keys(ledger)) if (Date.now() - Date.parse(d) > 30 * DAY) delete ledger[d];

await fs.writeFile(LEADS_FILE, JSON.stringify(db));
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1));
// Tiny file the open dashboards poll, so they only re-download leads.json when it changed.
await fs.writeFile(path.join(ROOT, 'data/version.json'), JSON.stringify({ v: new Date().toISOString() }));
console.log(JSON.stringify({ report, totals: db.meta.totals }, null, 2));
