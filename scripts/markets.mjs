// Country / region tagging for job locations.
//
// placesOf(text)  -> countries ("Germany") and region-wide remote tokens ("Europe-wide") named in text
// remotePlaces()  -> is the role remote, and from which countries / regions can people work it
// The site only keeps tech roles that are remote from at least one country outside the US.

const C = (name, iso, region, re) => ({ name, iso, region, re });
export const COUNTRIES = [
  // Focus: UK & Germany
  C('United Kingdom', 'GB', 'UK', /united kingdom|\bu\.?k\.?\b|england|scotland|wales|northern ireland|great britain|london|edinburgh|glasgow|bristol|leeds|cardiff|belfast|brighton|sheffield|nottingham|liverpool|knutsford|oxford/i),
  C('Germany', 'DE', 'Europe', /germany|deutschland|berlin|munich|münchen|muenchen|hamburg|frankfurt|cologne|köln|koeln|stuttgart|düsseldorf|dusseldorf|duesseldorf|leipzig|dresden|karlsruhe|heidelberg|hannover|hanover|nuremberg|nürnberg|bonn|chemnitz|leonberg|mannheim|potsdam|freiburg|bremen|aachen|darmstadt|zweibrücken|\bdach\b/i),
  // Middle East & Africa
  C('United Arab Emirates', 'AE', 'MEA', /\buae\b|united arab emirates|emirates|dubai|abu dhabi|sharjah/i),
  C('Saudi Arabia', 'SA', 'MEA', /saudi|\bksa\b|riyadh|jeddah|dammam|khobar/i),
  C('Qatar', 'QA', 'MEA', /qatar|doha/i),
  C('Bahrain', 'BH', 'MEA', /bahrain|manama/i),
  C('Kuwait', 'KW', 'MEA', /kuwait/i),
  C('Oman', 'OM', 'MEA', /\boman\b|muscat/i),
  C('Egypt', 'EG', 'MEA', /egypt|cairo|alexandria|giza/i),
  C('Jordan', 'JO', 'MEA', /\bjordan\b|amman/i),
  C('Lebanon', 'LB', 'MEA', /lebanon|beirut/i),
  C('Morocco', 'MA', 'MEA', /morocco|casablanca|rabat|marrakech/i),
  C('Tunisia', 'TN', 'MEA', /tunisia|\btunis\b/i),
  C('Algeria', 'DZ', 'MEA', /algeria|algiers/i),
  C('Israel', 'IL', 'MEA', /israel|tel aviv|jerusalem|haifa|herzliya/i),
  C('Turkey', 'TR', 'MEA', /turkey|türkiye|turkiye|istanbul|ankara|izmir/i),
  C('Nigeria', 'NG', 'MEA', /nigeria|lagos|abuja/i),
  C('Kenya', 'KE', 'MEA', /kenya|nairobi/i),
  C('Ghana', 'GH', 'MEA', /ghana|accra/i),
  C('South Africa', 'ZA', 'MEA', /south africa|cape town|johannesburg|durban|pretoria/i),
  C('Rwanda', 'RW', 'MEA', /rwanda|kigali/i),
  C('Uganda', 'UG', 'MEA', /uganda|kampala/i),
  C('Ethiopia', 'ET', 'MEA', /ethiopia|addis ababa/i),
  C('Tanzania', 'TZ', 'MEA', /tanzania|dar es salaam/i),
  C('Senegal', 'SN', 'MEA', /senegal|dakar/i),
  C('Zambia', 'ZM', 'MEA', /zambia|lusaka/i),
  C('Zimbabwe', 'ZW', 'MEA', /zimbabwe|harare/i),
  C('Namibia', 'NA', 'MEA', /namibia|windhoek/i),
  C('Botswana', 'BW', 'MEA', /botswana|gaborone/i),
  C('Mauritius', 'MU', 'MEA', /mauritius/i),
  C("Côte d'Ivoire", 'CI', 'MEA', /ivory coast|côte d'ivoire|cote d'ivoire|abidjan/i),
  C('Cameroon', 'CM', 'MEA', /cameroon|douala|yaoundé/i),
  // Southeast Asia
  C('Singapore', 'SG', 'SEA', /singapore/i),
  C('Indonesia', 'ID', 'SEA', /indonesia|jakarta|bali|surabaya|bandung/i),
  C('Malaysia', 'MY', 'SEA', /malaysia|kuala lumpur|selangor|subang|shah alam|penang|cyberjaya/i),
  C('Thailand', 'TH', 'SEA', /thailand|bangkok|chiang mai/i),
  C('Vietnam', 'VN', 'SEA', /vietnam|viet nam|ho chi minh|hanoi|saigon|da nang/i),
  C('Philippines', 'PH', 'SEA', /philippines|manila|makati|taguig|cebu|pasig|quezon/i),
  C('Myanmar', 'MM', 'SEA', /myanmar|yangon/i),
  C('Cambodia', 'KH', 'SEA', /cambodia|phnom penh/i),
  // Australia & NZ
  C('Australia', 'AU', 'Australia', /australia|sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|hobart|\bnsw\b|queensland/i),
  C('New Zealand', 'NZ', 'New Zealand', /new zealand|auckland|wellington|christchurch/i),
  // Rest of Europe
  C('Ireland', 'IE', 'Europe', /ireland|dublin|\bcork\b|galway/i),
  C('France', 'FR', 'Europe', /france|paris|lyon|toulouse|nantes|bordeaux/i),
  C('Spain', 'ES', 'Europe', /spain|madrid|barcelona|valencia|málaga|malaga|seville/i),
  C('Portugal', 'PT', 'Europe', /portugal|lisbon|porto/i),
  C('Netherlands', 'NL', 'Europe', /netherlands|holland|amsterdam|rotterdam|utrecht|eindhoven|the hague/i),
  C('Belgium', 'BE', 'Europe', /belgium|brussels|antwerp|ghent/i),
  C('Switzerland', 'CH', 'Europe', /switzerland|zurich|zürich|geneva|lausanne|basel|\bzug\b/i),
  C('Austria', 'AT', 'Europe', /austria|vienna|graz/i),
  C('Italy', 'IT', 'Europe', /italy|milan|milano|rome|turin|bologna/i),
  C('Poland', 'PL', 'Europe', /poland|warsaw|warszawa|krakow|kraków|cracow|wroclaw|wrocław|gdansk|poznan/i),
  C('Czechia', 'CZ', 'Europe', /czech|prague|brno/i),
  C('Romania', 'RO', 'Europe', /romania|bucharest|cluj/i),
  C('Bulgaria', 'BG', 'Europe', /bulgaria|sofia|plovdiv/i),
  C('Greece', 'GR', 'Europe', /greece|athens|thessaloniki/i),
  C('Hungary', 'HU', 'Europe', /hungary|budapest/i),
  C('Croatia', 'HR', 'Europe', /croatia|zagreb|split, croatia/i),
  C('Serbia', 'RS', 'Europe', /serbia|belgrade|novi sad/i),
  C('Bosnia and Herzegovina', 'BA', 'Europe', /bosnia|sarajevo/i),
  C('North Macedonia', 'MK', 'Europe', /macedonia|skopje/i),
  C('Slovenia', 'SI', 'Europe', /slovenia|ljubljana/i),
  C('Slovakia', 'SK', 'Europe', /slovakia|bratislava/i),
  C('Lithuania', 'LT', 'Europe', /lithuania|vilnius|kaunas/i),
  C('Latvia', 'LV', 'Europe', /latvia|\briga\b/i),
  C('Estonia', 'EE', 'Europe', /estonia|tallinn/i),
  C('Finland', 'FI', 'Europe', /finland|helsinki|espoo/i),
  C('Sweden', 'SE', 'Europe', /sweden|stockholm|gothenburg|malmö|malmo/i),
  C('Norway', 'NO', 'Europe', /norway|oslo|bergen/i),
  C('Denmark', 'DK', 'Europe', /denmark|copenhagen|aarhus/i),
  C('Iceland', 'IS', 'Europe', /iceland|reykjavik/i),
  C('Luxembourg', 'LU', 'Europe', /luxembourg/i),
  C('Ukraine', 'UA', 'Europe', /ukraine|kyiv|kiev|lviv|kharkiv/i),
  C('Cyprus', 'CY', 'Europe', /cyprus|limassol|nicosia/i),
  C('Malta', 'MT', 'Europe', /malta|valletta/i),
  // South & East Asia
  C('India', 'IN', 'South Asia', /\bindia\b|bengaluru|bangalore|hyderabad|mumbai|pune|delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh/i),
  C('Pakistan', 'PK', 'South Asia', /pakistan|karachi|lahore|islamabad/i),
  C('Bangladesh', 'BD', 'South Asia', /bangladesh|dhaka/i),
  C('Sri Lanka', 'LK', 'South Asia', /sri lanka|colombo/i),
  C('Nepal', 'NP', 'South Asia', /nepal|kathmandu/i),
  C('Japan', 'JP', 'East Asia', /japan|tokyo|osaka/i),
  C('South Korea', 'KR', 'East Asia', /korea|seoul/i),
  C('China', 'CN', 'East Asia', /china|beijing|shanghai|shenzhen/i),
  C('Hong Kong', 'HK', 'East Asia', /hong kong/i),
  C('Taiwan', 'TW', 'East Asia', /taiwan|taipei/i),
  // Americas (non-US)
  C('Canada', 'CA', 'Americas', /canada|toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo|ontario|quebec|british columbia|alberta/i),
  C('Mexico', 'MX', 'Americas', /mexico|méxico|guadalajara|monterrey/i),
  C('Brazil', 'BR', 'Americas', /brazil|brasil|são paulo|sao paulo|rio de janeiro/i),
  C('Argentina', 'AR', 'Americas', /argentina|buenos aires/i),
  C('Colombia', 'CO', 'Americas', /colombia|bogotá|bogota|medellín|medellin/i),
  C('Chile', 'CL', 'Americas', /chile|santiago/i),
  C('Peru', 'PE', 'Americas', /\bperu\b|\blima\b/i),
  C('Uruguay', 'UY', 'Americas', /uruguay|montevideo/i),
  C('Costa Rica', 'CR', 'Americas', /costa rica|san josé, costa/i),
  // United States: detected so it can be excluded.
  C('United States', 'US', 'USA', /united states|\busa\b|u\.s\.a?\.?|(?<!latin |north |south )\bamerica\b(?!s)|san francisco|bay area|silicon valley|new york|\bnyc\b|brooklyn|manhattan|seattle|austin|boston|los angeles|chicago|denver|miami|atlanta|palo alto|mountain view|menlo park|sunnyvale|san jose|santa clara|san mateo|redwood city|san diego|san carlos|berkeley|oakland|washington,? d\.?c|philadelphia|pittsburgh|portland|salt lake|phoenix|dallas|houston|nashville|raleigh|minneapolis|detroit|columbus|idaho|california|texas|florida|massachusetts|colorado|virginia|illinois|new jersey|us timezones?|us[- ](?:east|west|only|based|remote)|\bpst\b/i),
];
const US_UPPER_RE = /\bUS\b/; // case-sensitive: "US", not "us"
const BY_ISO = Object.fromEntries(COUNTRIES.map(c => [c.iso, c.name]));
export const REGION_OF = Object.fromEntries(COUNTRIES.map(c => [c.name, c.region]));

// Region-wide remote: which regions each token covers.
export const WIDE = {
  Worldwide: { re: /anywhere|worldwide|world-wide|\bglobal\b|international|any location|all countries|remote first, global/i, covers: ['Australia', 'Europe', 'MEA', 'New Zealand', 'SEA', 'UK'] },
  'Europe-wide': { re: /\beurope\b|european|\beu\b|\beea\b|\bcet\b|\bcest\b/i, covers: ['Europe', 'UK'] },
  EMEA: { re: /\bemea\b/i, covers: ['Europe', 'MEA', 'UK'] },
  'APAC-wide': { re: /\bapac\b|asia[- ]pacific|\basia\b/i, covers: ['Australia', 'New Zealand', 'SEA'] },
  'MENA-wide': { re: /\bmena\b|middle east|\bgcc\b|north africa/i, covers: ['MEA'] },
  'Africa-wide': { re: /(?<!south |north )\bafrica\b/i, covers: ['MEA'] },
  'LatAm-wide': { re: /latam|latin america|south america/i, covers: ['Americas'] },
};
const NORTH_AMERICA_RE = /north america|\bamer\b|\bnoram\b|us\s*\/\s*canada|us or canada|americas? time ?zones?/i;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const REMOTE_RE = /remote|anywhere|worldwide|distributed|work from home|\bwfh\b|home[- ]based|telecommute/i;

// Countries + region-wide tokens named in one location string.
export function placesOf(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const out = new Set();
  for (const c of COUNTRIES) if (c.re.test(s)) out.add(c.name);
  if (US_UPPER_RE.test(s)) out.add('United States');
  if (NORTH_AMERICA_RE.test(s)) { out.add('United States'); out.add('Canada'); }
  // ISO codes: "Riyadh, Riyadh Province, SA", "(SG; ID; MY)", "IN / Remote (IN)"
  const parts = s.split(',').map(x => x.trim());
  const last = parts.at(-1)?.replace(/[()]/g, '');
  if (/^[A-Z]{2}$/.test(last || '')) {
    if (parts.length === 2 && US_STATES.has(last) && !out.size) out.add('United States');
    else if (parts.length >= 3 || !US_STATES.has(last)) BY_ISO[last] && out.add(BY_ISO[last]);
  }
  for (const m of s.matchAll(/\(([A-Z]{2}(?:\s*;\s*[A-Z]{2})*)\)/g)) for (const code of m[1].split(/\s*;\s*/)) BY_ISO[code] && out.add(BY_ISO[code]);
  if (/^[A-Z]{2}$/.test(s.trim()) && BY_ISO[s.trim()]) out.add(BY_ISO[s.trim()]);
  for (const [name, w] of Object.entries(WIDE)) if (w.re.test(s)) out.add(name);
  // "Europe" also matched as a region-wide token; drop wide tokens already implied by "Worldwide".
  return [...out];
}

// Split "A / B or C; D | E" at top level (not inside parentheses).
function segments(text) {
  const out = []; let depth = 0, cur = '';
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    const rest = s.slice(i);
    if (depth === 0 && (ch === '/' || ch === ';' || ch === '|' || ch === '·' || /^ or /i.test(rest))) {
      out.push(cur); cur = '';
      if (/^ or /i.test(rest)) i += 3;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * Where can this role be worked remotely from?
 * @param location  the role's location text
 * @param flagged   the job board says the role is remote
 * @param context   places of the company (HQ), used when a role just says "Remote"
 */
export function remotePlaces(location, flagged, context = []) {
  const segs = segments(location);
  let remoteSegs = segs.filter(s => REMOTE_RE.test(s));
  if (!remoteSegs.length && flagged) remoteSegs = segs.length ? segs : [''];
  if (!remoteSegs.length) return { remote: false, places: [] };
  const places = new Set();
  let unspecified = false;
  for (const seg of remoteSegs) {
    const p = placesOf(seg);
    if (p.length) p.forEach(x => places.add(x)); else unspecified = true;
  }
  if (unspecified) {
    // "London, GB / Remote" → remote within the same country as the office.
    const siblings = segs.filter(s => !remoteSegs.includes(s)).flatMap(placesOf);
    (siblings.length ? siblings : context).forEach(x => places.add(x));
  }
  return { remote: true, places: [...places] };
}

// The site's geography: these six macro-regions only (alphabetical). Nothing in the US.
export const SCOPE_REGIONS = ['Australia', 'Europe', 'MEA', 'New Zealand', 'SEA', 'UK'];
const SHORT = { Australia: 'AU', Europe: 'EU', MEA: 'MEA', 'New Zealand': 'NZ', SEA: 'SEA', UK: 'UK' };

// Keep only places inside the six regions (countries there, or region-wide tokens covering them).
export const inScopePlaces = places => places.filter(p =>
  SCOPE_REGIONS.includes(REGION_OF[p]) || WIDE[p]?.covers.some(r => SCOPE_REGIONS.includes(r)));

// Macro-regions a set of places reaches (a "Europe-wide" role reaches Europe and the UK).
export function regionsOf(places) {
  const out = new Set();
  for (const p of places) {
    if (SCOPE_REGIONS.includes(REGION_OF[p])) out.add(REGION_OF[p]);
    for (const r of WIDE[p]?.covers || []) out.add(r);
  }
  return SCOPE_REGIONS.filter(r => out.has(r));
}

// Badge text: "100% Remote (Global)" or "100% Remote (EU/UK)".
export function remoteLabel(places) {
  if (places.includes('Worldwide')) return '100% Remote (Global)';
  return `100% Remote (${regionsOf(places).map(r => SHORT[r]).join('/')})`;
}

export const isFocusPlaces = places => regionsOf(places).length > 0;
export const INDIA_RE = /\bindia\b|bengaluru|bangalore|hyderabad|mumbai|\bpune\b|gurugram|gurgaon|noida|chennai|new delhi|kolkata|ahmedabad/i;

// ---------------------------------------------------------------- the site's countries
// Remote tech internships open to people in these five countries only (alphabetical).
export const SCOPE_COUNTRIES = ['Australia', 'Germany', 'Singapore', 'United Arab Emirates', 'United Kingdom'];
const COUNTRY_SHORT = { Australia: 'AU', Germany: 'DE', Singapore: 'SG', 'United Arab Emirates': 'UAE', 'United Kingdom': 'UK' };

/**
 * Which of the five countries a remote role is open to.
 * A role counts for a country when it names that country, or when it is remote across a wider area
 * (worldwide, Europe, EMEA, APAC, MENA) and the company is based in that country.
 * @param places  countries / wide tokens from the role's location (remotePlaces)
 * @param hq      countries the company is based in
 */
export function scopeCountries(places, hq = []) {
  const out = new Set(places.filter(p => SCOPE_COUNTRIES.includes(p)));
  for (const p of places) {
    if (!WIDE[p]) continue;
    for (const c of SCOPE_COUNTRIES) if (WIDE[p].covers.includes(REGION_OF[c]) && hq.includes(c)) out.add(c);
  }
  return SCOPE_COUNTRIES.filter(c => out.has(c));
}

// Badge text: "100% Remote (UK)", "100% Remote (UK/DE)"; "(Global)" when the posting is worldwide.
export const countryLabel = (countries, places = []) =>
  places.includes('Worldwide') ? '100% Remote (Global)' : `100% Remote (${countries.map(c => COUNTRY_SHORT[c]).join('/')})`;
