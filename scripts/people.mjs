// Who is listed as a point of contact, and how company LinkedIn links are written.
//
// Only these people are kept:
//   Talent & HR      recruiters, talent acquisition, HR, people team, campus / early careers
//   Founders & CTO   founders, co-founders, CTOs
//   Leadership       VPs, directors, heads of a team (managing directors / Geschäftsführer included)
// Everyone else is dropped: partnerships / business development / alliances, and CEOs, COOs, CFOs
// and other titles that aren't founders, CTOs, VPs, directors, heads or HR.

export const TEAMS = ['Talent & HR', 'Founders & CTO', 'Leadership'];

const FOUNDER_RE = /\bco-?founders?\b|\bfounders?\b|\bcto\b|chief technology officer|chief technical officer/i;
const TALENT_RE = /recruit|talent|human resources|\bhr\b|\bhrbp\b|people (?:ops|operations|partner|team|lead|director|manager|and culture|& culture)|head of people|chief people officer|\bpeople\b.*\bculture\b|campus|university (?:relations|recruiting)|early careers|internship (?:program|programme)|hiring manager/i;
const PARTNER_RE = /partner(?:ship)?s?\b|alliance|business development|\bbd\b|bizdev|\bchannel\b|ecosystem|affiliate|reseller/i;
const LEAD_RE = /\bvp\b|\bsvp\b|\bevp\b|vice[- ]president|\bdirector\b|\bhead of\b|\bhead,|^head\b|geschäftsführer|geschaftsfuhrer/i;

// YC lists a company's founders; their titles are often just "CEO", so the source decides.
export function teamOf(p) {
  const t = p.title || '';
  if (p.source === 'YC' || (FOUNDER_RE.test(t) && !/founder'?s'? (?:associate|assistant|office)/i.test(t))) return 'Founders & CTO';
  if (TALENT_RE.test(t)) return 'Talent & HR';
  if (PARTNER_RE.test(t)) return null;
  if (LEAD_RE.test(t)) return 'Leadership';
  return null;
}

// Company mailboxes kept: only the hiring / HR ones (careers@, jobs@, hr@, talent@, ...).
export const isTalentMailbox = email => /^(careers?|jobs?|hiring|recruit\w*|talent|hr|people|join|work|campus|interns?|internships?|apply|cv|resumes?)([._-]|$)/i.test(String(email).split('@')[0]);

// Canonical company LinkedIn URL: https://www.linkedin.com/company/<slug> (or /school/, /showcase/).
export function normLinkedIn(u) {
  const m = /linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i.exec(String(u || ''));
  if (!m) return null;
  const slug = decodeURIComponent(m[2]).trim();
  if (!slug || /^(unavailable|undefined|null)$/i.test(slug)) return null;
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${encodeURIComponent(slug).replace(/%2D/gi, '-')}`;
}
