/**
 * זיהוי נושאים מ־kibbutzData, חילוץ אנשי קשר להגשה, ובדיקת תקרות לפי טקסט התקנון.
 */

const kibbutzData = require('./kibbutzData');

function formatShekelDisplay(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return '0';
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * התאמה ראשונה: מילת מפתח מופיעה בתיאור או בכל ההודעה (lower).
 */
function findKibbutzEntryForText(descLower, messageLower) {
  const d = String(descLower || '').toLowerCase();
  const m = String(messageLower || '').toLowerCase();
  const hay = d.length >= 2 ? d : m;
  for (const entry of kibbutzData) {
    for (const kw of entry.keywords || []) {
      const k = String(kw).toLowerCase();
      if (!k || k.length < 2) continue;
      if (hay.includes(k) || (m !== hay && m.includes(k))) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * חילוץ שורות 👤 / הגשה / אחראי / חובה (מידע על אן להגיש).
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

  if (chunks.length) {
    return chunks[0].replace(/\s+/g, ' ').trim();
  }

  const known =
    text.match(
      /(הדס בראון|סיגל שיינקמן|ורד קולהאס|גלי אורן|לורה כהן|מאיר בראון|עופר בנדיקט|לילי שוויגמן|ליאור גולדשטיין|הילה סיוון|תמר צנטנר|נופר ארזי|זוהר בן שימול|מירה אדוט|מורן ינאי)/
    );
  if (known) return known[1];

  return 'רכז/ת הגשה (לפי התקנון)';
}

/**
 * איתור תקרת "עד N ש"ח" שנפרצה ע"י הסכום (היוריסטיקה לפי כל ה־"עד" בטקסט).
 */
function findBreachedPolicyCap(userAmount, answerText) {
  const amt = Number(userAmount);
  if (!amt || amt <= 0 || !answerText) return null;

  const text = String(answerText).replace(/\u200f/g, '');
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

function buildSmartLogReply(amountDisplay, topic, contact, capNote, dupSuffix) {
  let msg =
    `סוכם: *${amountDisplay}* ש"ח עבור *${topic}*.\n` +
    `שויך להגשה מול *${contact}*.\n` +
    `שלח קבלה.`;
  if (capNote) msg += `\n\n${capNote}`;
  if (dupSuffix) msg += dupSuffix;
  return msg;
}

module.exports = {
  kibbutzData,
  findKibbutzEntryForText,
  extractSubmissionContacts,
  findBreachedPolicyCap,
  buildSmartLogReply,
  formatShekelDisplay,
};
