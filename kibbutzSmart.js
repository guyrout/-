/**
 * התאמת kibbutzData, החזר משוער לפי תקרה, ובירור כשיש כמה נושאים.
 */

const kibbutzData = require('./kibbutzData');

function formatShekelDisplay(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return '0';
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '');
}

function haystackFrom(descLower, messageLower) {
  const d = String(descLower || '').toLowerCase();
  const m = String(messageLower || '').toLowerCase();
  return `${d} ${m}`.replace(/\s+/g, ' ').trim();
}

function keywordInHaystack(kw, hay) {
  const k = String(kw).toLowerCase();
  return k.length >= 2 && hay.includes(k);
}

/** כל הרשומות שהמפתח שלהן מופיע כמחרוזת מלאה ב-haystack */
function findStrictMatches(hay) {
  const seen = new Set();
  const out = [];
  for (const entry of kibbutzData) {
    if (seen.has(entry.topic)) continue;
    const kws = entry.keywords || [];
    if (kws.some((kw) => keywordInHaystack(kw, hay))) {
      seen.add(entry.topic);
      out.push(entry);
    }
  }
  return out;
}

/** התאמה מעומעמת: 3 תווים ראשונים משותפים בין מילה בהודעה לבין מפתח */
function findFuzzyMatches(hay) {
  const words = hay
    .split(/[^\u0590-\u05FFa-z0-9]+/i)
    .filter((w) => w.length >= 3)
    .map((w) => w.toLowerCase());
  const seen = new Set();
  const out = [];
  for (const entry of kibbutzData) {
    if (seen.has(entry.topic)) continue;
    const kws = entry.keywords || [];
    outer: for (const kw of kws) {
      const k = String(kw).toLowerCase();
      if (k.length < 3) continue;
      if (hay.includes(k)) continue outer;
      const p3 = k.slice(0, 3);
      for (const w of words) {
        if (w.includes(k) || k.includes(w)) {
          seen.add(entry.topic);
          out.push(entry);
          break outer;
        }
        if (w.slice(0, 3) === p3 || k.slice(0, Math.min(3, w.length)) === w.slice(0, 3)) {
          seen.add(entry.topic);
          out.push(entry);
          break outer;
        }
      }
    }
  }
  return out;
}

/**
 * כל ההתאמות הרלוונטיות (אם אין התאמה מלאה — מנסה מעומעם).
 * יותר מנושא אחד → לבירור משתמש.
 */
function findKibbutzMatches(descLower, messageLower) {
  const hay = haystackFrom(descLower, messageLower);
  if (!hay) return [];
  let m = findStrictMatches(hay);
  if (m.length === 0) m = findFuzzyMatches(hay);
  return m;
}

/** תאימות לאחור: רק כשיש בדיוק התאמה אחת */
function findKibbutzEntryForText(descLower, messageLower) {
  const all = findKibbutzMatches(descLower, messageLower);
  return all.length === 1 ? all[0] : null;
}

function limitForKibbutzTopic(topicStr) {
  const t = String(topicStr || '').trim();
  const e = kibbutzData.find((x) => x.topic === t);
  const lim = e != null ? Number(e.limit) : NaN;
  if (!Number.isFinite(lim) || lim <= 0) return null;
  return lim;
}

/** החזר משוער לשורה אחת: min(סכום, תקרה) או מלא אם אין תקרה בנתונים */
function potentialRefundForAmountAndTopic(amount, topicOrCat) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return 0;
  const lim = limitForKibbutzTopic(topicOrCat);
  if (lim == null) return a;
  return Math.min(a, lim);
}

function estimatedRefund(amount, limit) {
  const a = Number(amount);
  const l = Number(limit);
  if (!Number.isFinite(a) || a <= 0) return 0;
  if (!Number.isFinite(l) || l <= 0) return a;
  return Math.min(a, l);
}

function capNoteFromEntry(amount, entry) {
  const lim = Number(entry && entry.limit);
  if (!Number.isFinite(lim) || lim <= 0) return '';
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= lim) return '';
  return `שים לב: סכום הרישום גבוה מהתקרה בנתונים (*${formatShekelDisplay(lim)}* ש"ח).`;
}

/** נרשם + החזר משוער (עברית; מקביל ללוגיקה שביקשת באנגלית) */
function buildSmartLogReply({
  amountDisplay,
  limitDisplay,
  refundDisplay,
  topic,
  contact,
  capNote,
  dupSuffix,
}) {
  let msg =
    `*נרשם:* *${amountDisplay}* ש"ח\n` +
    `*לפי תקרה* *${limitDisplay}* ש"ח, *החזר משוער:* *${refundDisplay}* ש"ח\n` +
    `*הגשה מול:* *${contact}*\n` +
    `שלח קבלה.`;
  if (capNote) msg += `\n\n${capNote}`;
  if (dupSuffix) msg += dupSuffix;
  return msg;
}

function serializeDisambigEntry(e) {
  return {
    topic: e.topic,
    limit: e.limit,
    contact: e.contact,
    answer: e.answer,
  };
}

/**
 * חילוץ contact מטקסט תשובה (גיבוי לרשומות ישנות בלי שדה contact).
 */
function extractSubmissionContacts(answer) {
  const text = String(answer || '').replace(/\*\*/g, '*');
  const lines = text.split(/\n/);
  const chunks = [];
  for (const line of lines) {
    const L = line.trim();
    if (!L) continue;
    if (!/👤/.test(L) && !/(הגשה|תיאום\/אישור|תיאום|אחראי|אחראית|דיווח|חובה)/.test(L)) {
      continue;
    }
    const colon = L.indexOf(':');
    if (colon === -1) continue;
    let rest = L.slice(colon + 1).trim().replace(/\*+/g, '').trim();
    if (!rest) continue;
    rest = rest.replace(/\.\s*$/, '');
    if (rest) chunks.push(rest);
  }
  if (chunks.length) return chunks[0].replace(/\s+/g, ' ').trim();
  return 'רכז/ת הגשה (לפי התקנון)';
}

/** @deprecated — השתמש ב-entry.limit; נשמר לתאימות */
function findBreachedPolicyCap(userAmount, answerText) {
  const amt = Number(userAmount);
  if (!amt || amt <= 0) return null;
  const text = String(answerText || '').replace(/\u200f/g, '');
  const found = new Set();
  const re = /עד\s*(?:ל-?)?\s*([\d,]+)\s*ש"?\s*ח/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(String(m[1]).replace(/,/g, ''));
    if (!Number.isNaN(n) && n > 0) found.add(n);
  }
  const caps = [...found].filter((c) => c < amt);
  if (caps.length === 0) return null;
  const limit = Math.max(...caps);
  return {
    limit,
    note: `שים לב: לפי התקנון, תקרת ההחזר היא עד *${formatShekelDisplay(limit)}* ש"ח.`,
  };
}

module.exports = {
  kibbutzData,
  findKibbutzMatches,
  findKibbutzEntryForText,
  limitForKibbutzTopic,
  potentialRefundForAmountAndTopic,
  estimatedRefund,
  capNoteFromEntry,
  buildSmartLogReply,
  serializeDisambigEntry,
  extractSubmissionContacts,
  findBreachedPolicyCap,
  formatShekelDisplay,
};
