// Tags locations with markets. Focus markets: MEA, SEA, Germany, UK, Australia & NZ.

export const FOCUS = ['MEA', 'SEA', 'Germany', 'UK', 'Australia'];

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const US_STATE_RE = new RegExp(`,\\s*(?:${US_STATES})\\b|\\b(?:${US_STATES})\\s*,\\s*(?:US|USA)\\b|^(?:${US_STATES})$`);

const PATTERNS = {
  USA: /united states|\busa?\b|u\.s\.|\bamerica\b(?!s)|north america|\bamer\b|san francisco|\bsf\b|bay area|silicon valley|new york|\bnyc\b|brooklyn|manhattan|seattle|austin|boston|los angeles|chicago|denver|miami|atlanta|palo alto|mountain view|menlo park|sunnyvale|san jose|san mateo|redwood city|san diego|washington,? d\.?c|philadelphia|pittsburgh|portland|salt lake|phoenix|dallas|houston|nashville|raleigh|minneapolis|detroit|columbus|california|texas|florida|massachusetts|colorado|virginia|illinois|georgia(?!n)|pacific time|eastern time|\b[pe]st\b/i,
  Canada: /canada|toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo|ontario|quebec|british columbia/i,
  UK: /\bu\.?k\.?\b|united kingdom|england|scotland|wales|great britain|\bgb\b|london|manchester|cambridge(?!,\s*ma)|oxford|edinburgh|bristol|leeds|birmingham|glasgow|cardiff|belfast|brighton|reading|sheffield|nottingham|liverpool|newcastle/i,
  Germany: /germany|deutschland|berlin|munich|münchen|muenchen|hamburg|frankfurt|cologne|köln|koeln|stuttgart|düsseldorf|dusseldorf|duesseldorf|leipzig|dresden|karlsruhe|heidelberg|hannover|hanover|nuremberg|nürnberg|bonn|chemnitz|leonberg|mannheim|potsdam|freiburg|bremen|essen|dortmund|zweibrücken|aachen|darmstadt|\bdach\b/i,
  SEA: /singapore|indonesia|jakarta|bali|surabaya|bandung|malaysia|kuala lumpur|selangor|subang|shah alam|penang|thailand|bangkok|vietnam|ho chi minh|hanoi|saigon|philippines|manila|makati|taguig|cebu|myanmar|yangon|cambodia|phnom penh|southeast asia|south[- ]east asia|\bsea\b(?! of)|\basean\b/i,
  MEA: /\buae\b|united arab emirates|emirates|dubai|abu dhabi|sharjah|saudi|\bksa\b|riyadh|jeddah|dammam|qatar|doha|bahrain|manama|kuwait|oman|muscat|egypt|cairo|alexandria|jordan|amman|lebanon|beirut|morocco|casablanca|rabat|tunisia|tunis|algeria|algiers|israel|tel aviv|jerusalem|haifa|turkey|türkiye|istanbul|ankara|pakistan|karachi|lahore|islamabad|nigeria|lagos|abuja|kenya|nairobi|ghana|accra|south africa|cape town|johannesburg|durban|pretoria|rwanda|kigali|uganda|kampala|ethiopia|addis|tanzania|dar es salaam|senegal|dakar|namibia|zambia|zimbabwe|botswana|mauritius|côte d'ivoire|ivory coast|cameroon|africa|middle east|\bmena\b|\bmea\b|\bgcc\b/i,
  Australia: /australia|sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|hobart|new zealand|auckland|wellington|christchurch|\banz\b|\bnsw\b|queensland|\bau\s*:|\bau\b\s*-|\baus\b/i,
  India: /india|bengaluru|bangalore|hyderabad|mumbai|pune|delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|coimbatore|\bblr\b/i,
  Europe: /france|paris|spain|madrid|barcelona|valencia|málaga|malaga|portugal|lisbon|porto|netherlands|amsterdam|rotterdam|utrecht|ireland|dublin|poland|warsaw|warszawa|krakow|kraków|cracow|wroclaw|sweden|stockholm|gothenburg|denmark|copenhagen|norway|oslo|finland|helsinki|switzerland|zurich|zürich|geneva|lausanne|austria|vienna|italy|milan|milano|rome|turin|belgium|brussels|czech|prague|brno|romania|bucharest|cluj|bulgaria|sofia|greece|athens|lithuania|vilnius|latvia|riga|estonia|tallinn|hungary|budapest|ukraine|kyiv|kiev|serbia|belgrade|bosnia|sarajevo|croatia|zagreb|slovenia|ljubljana|luxembourg|europe|european|\beu\b|\beea\b|emea|\bcet\b|\bcest\b/i,
  LatAm: /mexico|méxico|brazil|brasil|são paulo|sao paulo|rio de janeiro|argentina|buenos aires|colombia|bogotá|bogota|medellín|medellin|chile|santiago|peru|lima|uruguay|montevideo|costa rica|latam|latin america|south america/i,
  'East Asia': /japan|tokyo|osaka|korea|seoul|china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei/i,
};
const UK_COUNTRY_RE = /\bu\.?k\.?\b|united kingdom|england|scotland|wales|great britain/i;
const REMOTE_RE = /remote|anywhere|worldwide|global|distributed|work from home|wfh/i;

// YC's own region labels.
const YC_REGION = {
  'United Kingdom': 'UK', Germany: 'Germany',
  'Southeast Asia': 'SEA', Singapore: 'SEA', Indonesia: 'SEA', Malaysia: 'SEA', Vietnam: 'SEA', Philippines: 'SEA', Thailand: 'SEA',
  'Middle East and North Africa': 'MEA', Africa: 'MEA', 'United Arab Emirates': 'MEA', 'Saudi Arabia': 'MEA', Nigeria: 'MEA', Jordan: 'MEA',
  Israel: 'MEA', Tanzania: 'MEA', Algeria: 'MEA', 'South Africa': 'MEA', Namibia: 'MEA', Turkey: 'MEA', Egypt: 'MEA', Kenya: 'MEA', Pakistan: 'MEA',
  Australia: 'Australia', Oceania: 'Australia', 'New Zealand': 'Australia',
  India: 'India', 'South Asia': 'India',
  'America / Canada': 'USA', 'United States of America': 'USA', Canada: 'Canada',
  'Latin America': 'LatAm', Mexico: 'LatAm', Brazil: 'LatAm', Colombia: 'LatAm', Argentina: 'LatAm', Chile: 'LatAm', Peru: 'LatAm',
  'East Asia': 'East Asia', Japan: 'East Asia', 'South Korea': 'East Asia', China: 'East Asia', 'Hong Kong': 'East Asia',
  'Fully Remote': 'Remote', Remote: 'Remote',
};
const EUROPE_LABELS = /Europe|France|Spain|Sweden|Norway|Switzerland|Denmark|Poland|Ireland|Netherlands|Belgium|Italy|Finland|Greece|Portugal|Lithuania|Romania|Ukraine|Austria/;

// Markets for one free-text location (split on ; | / and " or ").
export function marketsOf(text) {
  const out = new Set();
  for (const part of String(text || '').split(/\s*(?:;|\||\/|·| or |\n)\s*/i)) {
    if (!part) continue;
    let found = Object.keys(PATTERNS).filter(m => PATTERNS[m].test(part));
    // ", MA" style state codes: only trust them when nothing else is named, or when the only
    // other hit is a UK city with a US twin ("Cambridge, MA", "Birmingham, AL").
    if (US_STATE_RE.test(part)) {
      if (!found.length) found = ['USA'];
      else if (found.length === 1 && found[0] === 'UK' && !UK_COUNTRY_RE.test(part)) found = ['USA'];
    }
    found.forEach(m => out.add(m));
    if (!found.length && REMOTE_RE.test(part)) out.add('Remote');
  }
  return [...out];
}

export function companyMarkets(c) {
  const out = new Set(marketsOf(c.location));
  for (const r of c.regions || []) {
    if (YC_REGION[r]) out.add(YC_REGION[r]);
    else if (EUROPE_LABELS.test(r)) out.add('Europe');
  }
  for (const j of c.jobs || []) if (j.status === 'open') (j.markets || []).forEach(m => out.add(m));
  return [...out];
}

export const isFocus = markets => markets.some(m => FOCUS.includes(m));
export const isUsOnly = markets => markets.length > 0 && markets.every(m => m === 'USA' || m === 'Canada') && markets.includes('USA');
