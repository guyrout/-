/**
 * בוט WhatsApp (Twilio Sandbox) + שמירה ב-Google Sheets.
 * Reimbursement Maximization & Audit-Ready Tracking.
 * Columns: Date | Description | Amount | Category | Receipt | Submitted
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cron = require('node-cron');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Twilio ---
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const FROM_WHATSAPP_NUMBER = (process.env.FROM_WHATSAPP_NUMBER || '').trim();
const TO_WHATSAPP_NUMBER = (process.env.TO_WHATSAPP_NUMBER || '').trim();

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function fmtWA(num) {
  return num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
}

// --- Google Sheets ---
const GOOGLE_SHEET_ID = (
  process.env.GOOGLE_SHEET_ID || '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48'
).trim();

function loadGoogleServiceAccountCreds() {
  const localPath = path.join(__dirname, 'Expense-Tracker-Bot.json');
  if (fs.existsSync(localPath)) {
    try {
      return require('./Expense-Tracker-Bot.json');
    } catch (e) {
      console.error('[config] Expense-Tracker-Bot.json:', e.message);
    }
  }
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('[config] GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
    }
  }
  return null;
}

const serviceAccountCreds = loadGoogleServiceAccountCreds();
let sheetsClientPromise = null;

function getSpreadsheetDoc() {
  if (!GOOGLE_SHEET_ID || !serviceAccountCreds) return null;
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const serviceAccountAuth = new JWT({
        email: serviceAccountCreds.client_email,
        key: serviceAccountCreds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
      await doc.loadInfo();
      return doc;
    })();
  }
  return sheetsClientPromise;
}

// ===================== Hebrew Prefix-Aware Matching =====================

const HEB_PREFIX_RE = /^[הובלמכשת]/;

function matchesAny(text, triggers) {
  const words = text.split(/\s+/);
  const stripped = words
    .map((w) => (w.length > 2 && HEB_PREFIX_RE.test(w) ? w.slice(1) : w))
    .join(' ');
  return triggers.some((t) => text.includes(t) || stripped.includes(t));
}

// ===================== Intent Dictionary =====================

const INTENT_SUMMARY = [
  'סיכום', 'דוח', 'דו"ח', 'כמה הוצאתי', 'סטטוס',
  'summary', 'report', 'כמה בזבזתי',
];
const INTENT_UNDO = ['מחק', 'ביטול', 'טעות', 'undo', 'מחיקה', 'תמחק'];
const INTENT_POLITENESS = ['תודה', 'מעולה', 'אחלה', 'יופי', 'thanks', 'great'];
const INTENT_GREETING = ['היי', 'שלום', 'הלו', 'hi', 'hello', 'בוקר טוב', 'ערב טוב'];
const INTENT_STATS = ['סטטיסטיקה', 'נתונים', 'הכי יקרה', 'stats', 'ניתוח'];
const INTENT_CATEGORIES = ['קטגוריות', 'רשימה', 'categories'];
const INTENT_BUDGET = ['יעד', 'תקציב', 'budget'];
const INTENT_NOT_SUBMITTED = ['מה לא הוגש', 'לא הוגש', 'פתוחות', 'unsubmitted'];
const INTENT_MARK_SUBMITTED = ['הגשתי', 'הוגש', 'submitted'];
const INTENT_CONFIRM_YES = ['כן', 'yes', 'כ', 'בטוח', 'נכון'];
const INTENT_CONFIRM_NO = ['לא', 'no', 'ל'];

const CURRENCY_RE = /[$€]|דולר|אירו|euro|dollar/i;

// ===================== Category Mapping =====================

const CATEGORY_MAP = [
  { keywords: ['פסיכולוג'], category: 'החזרי פסיכולוג 🧘' },
  { keywords: ['בריאות', 'תרופות', 'רופא'], category: 'החזרי בריאות 🩺' },
  { keywords: ['חנייה', 'חניה'], category: 'החזרי חנייה 🅿️' },
  { keywords: ['אוטובוס', 'רכבת', 'תחבורה'], category: 'החזרי נסיעות תחבורה ציבורית 🚏' },
  { keywords: ['תספורת', 'קוסמטיקה', 'זקן'], category: 'החזרי תספורת וקוסמטיקה 💇' },
  { keywords: ['ילדים', 'גן', 'חוג'], category: 'החזרי ילדים 👶' },
  { keywords: ['טלפון', 'סלולר', 'אינטרנט'], category: 'החזרי טלפון 📱' },
  { keywords: ['אגרה', 'ממשלה', 'מס'], category: 'החזרי תשלומים ממשלתיים 👩‍⚖️' },
  { keywords: ['בגדים', 'נעליים', 'ביגוד'], category: 'החזרי ביגוד לעובדי חוץ 👕' },
  { keywords: ['בניין', 'ועד', 'תיקון'], category: 'החזרי בניין 🏡' },
  { keywords: ['מונית', 'טאקסי'], category: 'החזרי מוניות 🚕' },
];
const DEFAULT_CATEGORY = 'החזרי הוצאות שונות 🧑‍💻';

function matchCategory(description) {
  if (!description) return DEFAULT_CATEGORY;
  const lower = description.toLowerCase();
  const stripped = lower
    .split(/\s+/)
    .map((w) => (w.length > 2 && HEB_PREFIX_RE.test(w) ? w.slice(1) : w))
    .join(' ');
  for (const { keywords, category } of CATEGORY_MAP) {
    if (keywords.some((kw) => lower.includes(kw) || stripped.includes(kw))) {
      return category;
    }
  }
  return DEFAULT_CATEGORY;
}

function categoryEmoji(description) {
  const cat = matchCategory(description);
  const m = cat.match(/\p{Emoji_Presentation}/u);
  return m ? m[0] : '';
}

// ===================== Description Sanitization =====================

const NOISE_WORDS = new Set([
  'בערך', 'שילמתי', 'הוצאתי', 'יצא', 'קניתי', 'היה',
  'שקל', 'שקלים', 'ש"ח', 'על', 'עבור', 'בשביל', 'את', 'של',
  'לי', 'כמו', 'זה', 'היום', 'אתמול', 'עכשיו',
]);

function sanitizeDescription(text) {
  return text.split(/\s+/).filter((w) => !NOISE_WORDS.has(w)).join(' ').trim();
}

// ===================== Message Parsing =====================

function parseExpenseMessage(text) {
  if (!text || typeof text !== 'string') return { amount: 0, description: '' };
  const trimmed = text.trim();
  const m = trimmed.match(/\d+(?:[.,]\d+)?/);
  if (!m) return { amount: 0, description: sanitizeDescription(trimmed) };
  const amount = parseFloat(m[0].replace(',', '.')) || 0;
  const rawDesc = trimmed.replace(m[0], '').replace(/\s+/g, ' ').trim();
  return { amount, description: sanitizeDescription(rawDesc) };
}

// ===================== TwiML =====================

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendTwiML(res, messageText) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
      messageText
    )}</Message></Response>`
  );
}

// ===================== Google Sheets =====================

const SHEET_HEADERS = ['Date', 'Description', 'Amount', 'Category', 'Receipt', 'Submitted'];

async function ensureHeaders(sheet) {
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const hasAll =
    headers.length >= 6 &&
    headers[0] === 'Date' &&
    headers[4] === 'Receipt' &&
    headers[5] === 'Submitted';
  if (!hasAll && headers.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(SHEET_HEADERS);
  }
}

function getCol(row, col) {
  return (typeof row.get === 'function' ? row.get(col) : row[col]) || '';
}

async function appendExpenseRow(description, amount, category) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  const row = await sheet.addRow({
    Date: new Date().toISOString(),
    Description: description,
    Amount: amount,
    Category: category,
    Receipt: '',
    Submitted: 'No',
  });
  return row;
}

async function updateRowField(row, field, value) {
  if (!row) return;
  try {
    if (typeof row.set === 'function') {
      row.set(field, value);
    } else {
      row[field] = value;
    }
    await row.save();
  } catch (e) {
    console.error(`[sheets] update ${field} failed:`, e.message);
  }
}

async function deleteRow(row) {
  if (!row) return false;
  try {
    await row.delete();
    return true;
  } catch (e) {
    console.error('[sheets] delete failed:', e.message);
    return false;
  }
}

async function saveToSheet(description, amount, category) {
  return appendExpenseRow(description, parseFloat(amount) || 0, category || DEFAULT_CATEGORY);
}

/** Generic: get parsed rows for a given year/month, with optional raw row refs */
async function getRowsForMonth(targetYear, targetMonth, includeRaw) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  const allRows = await sheet.getRows();

  const rows = [];
  for (const row of allRows) {
    const d = new Date(getCol(row, 'Date'));
    if (d.getFullYear() !== targetYear || d.getMonth() !== targetMonth) continue;
    const amt = parseFloat(getCol(row, 'Amount'));
    if (Number.isNaN(amt) || amt === 0) continue;
    const entry = {
      amt,
      cat: getCol(row, 'Category') || DEFAULT_CATEGORY,
      desc: getCol(row, 'Description'),
      receipt: getCol(row, 'Receipt'),
      submitted: getCol(row, 'Submitted'),
    };
    if (includeRaw) entry.row = row;
    rows.push(entry);
  }
  return rows;
}

async function getCurrentMonthRows(includeRaw) {
  const now = new Date();
  const rows = await getRowsForMonth(now.getFullYear(), now.getMonth(), includeRaw);
  return rows
    ? { rows, curYear: now.getFullYear(), curMonth: now.getMonth() }
    : null;
}

async function sumAmountColumn() {
  const doc = await getSpreadsheetDoc();
  if (!doc) return 0;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  const rows = await sheet.getRows();
  let total = 0;
  for (const row of rows) {
    const n = parseFloat(getCol(row, 'Amount'));
    if (!Number.isNaN(n)) total += n;
  }
  return total;
}

// ===================== Submission & Receipt Logic =====================

async function getUnsubmittedRows() {
  const data = await getCurrentMonthRows(false);
  if (!data) return [];
  return data.rows.filter((r) => r.submitted !== 'Yes');
}

async function markAllCurrentMonthSubmitted() {
  const data = await getCurrentMonthRows(true);
  if (!data) return 0;
  let count = 0;
  for (const entry of data.rows) {
    if (entry.submitted !== 'Yes' && entry.row) {
      await updateRowField(entry.row, 'Submitted', 'Yes');
      count++;
    }
  }
  return count;
}

async function getMissingReceiptRows() {
  const data = await getCurrentMonthRows(false);
  if (!data) return [];
  return data.rows.filter((r) => r.receipt !== 'Yes');
}

// ===================== MoM Helpers =====================

function buildCategoryTotals(rows) {
  const totals = new Map();
  for (const { amt, cat } of rows) {
    totals.set(cat, (totals.get(cat) || 0) + amt);
  }
  return totals;
}

function momLine(curTotals, prevTotals) {
  if (prevTotals.size === 0) return '';
  const lines = [];
  for (const [cat, curAmt] of curTotals) {
    const prevAmt = prevTotals.get(cat);
    if (!prevAmt) continue;
    const diff = Math.round(((curAmt - prevAmt) / prevAmt) * 100);
    if (diff === 0) continue;
    const direction = diff > 0 ? 'יותר' : 'פחות';
    lines.push(`החודש הוצאת *${Math.abs(diff)}%* ${direction} על ${cat} לעומת החודש הקודם.`);
  }
  return lines.length > 0 ? lines.join('\n') : '';
}

async function getPrevMonthTotals() {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() - 1;
  if (m < 0) { m = 11; y--; }
  const rows = await getRowsForMonth(y, m, false);
  return rows ? buildCategoryTotals(rows) : new Map();
}

// ===================== Summary & Stats =====================

const HEB_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const SUMMARY_FOOTERS = [
  'אל תשכח לשמור את הקבלות המקוריות! 📑',
  'הכסף הזה חוזר אליך! 💸',
  'שמור על הסדר — זה משתלם! 🗂️',
];

async function buildMonthlySummary() {
  const data = await getCurrentMonthRows(false);
  if (!data) return null;
  const { rows, curMonth } = data;
  const monthName = HEB_MONTHS[curMonth];

  if (rows.length === 0) {
    return 'עדיין אין הוצאות רשומות לחודש זה. רוצה לרשום משהו עכשיו? ✍️';
  }

  const categoryTotals = new Map();
  const categoryItems = new Map();
  let noReceipt = 0;
  let notSubmitted = 0;

  for (const r of rows) {
    categoryTotals.set(r.cat, (categoryTotals.get(r.cat) || 0) + r.amt);
    if (!categoryItems.has(r.cat)) categoryItems.set(r.cat, []);
    categoryItems.get(r.cat).push({ desc: r.desc, amt: r.amt });
    if (r.receipt !== 'Yes') noReceipt++;
    if (r.submitted !== 'Yes') notSubmitted++;
  }

  let grandTotal = 0;
  const lines = [];

  lines.push(`📊 *סיכום החזרים חודשי - ${monthName}*`);
  lines.push('─────────────────────');

  const sorted = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);

  for (const [cat, total] of sorted) {
    grandTotal += total;
    const emoji = cat.match(/\p{Emoji_Presentation}/u)?.[0] || '•';
    lines.push(`${emoji} *${cat}*: ${total} ₪`);
    const items = categoryItems.get(cat) || [];
    if (items.length > 1) {
      for (const it of items) {
        lines.push(`      ${it.desc} — ${it.amt} ₪`);
      }
    }
  }

  lines.push('─────────────────────');
  lines.push(`💰 *סה"כ מצטבר להחזר: ${grandTotal} ₪*`);

  // MoM
  try {
    const prevTotals = await getPrevMonthTotals();
    const mom = momLine(categoryTotals, prevTotals);
    if (mom) { lines.push(''); lines.push(mom); }
  } catch (e) {
    console.error('[sheets] MoM failed:', e.message);
  }

  // Audit status
  lines.push('');
  if (noReceipt > 0) lines.push(`⚠️ ${noReceipt} הוצאות ללא קבלה`);
  if (notSubmitted > 0) lines.push(`📝 ${notSubmitted} הוצאות טרם הוגשו`);

  lines.push('');
  lines.push(SUMMARY_FOOTERS[Math.floor(Math.random() * SUMMARY_FOOTERS.length)]);

  return lines.join('\n');
}

async function buildMonthlyStats() {
  const data = await getCurrentMonthRows(false);
  if (!data) return null;
  const { rows, curMonth } = data;
  const monthName = HEB_MONTHS[curMonth];

  if (rows.length === 0) {
    return 'עדיין אין מספיק נתונים לניתוח. רשום הוצאות ונסה שוב! 📈';
  }

  const categoryTotals = buildCategoryTotals(rows);
  let grandTotal = 0;
  for (const v of categoryTotals.values()) grandTotal += v;

  const sorted = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
  const [topCat, topAmt] = sorted[0];
  const topPct = grandTotal > 0 ? Math.round((topAmt / grandTotal) * 100) : 0;

  const lines = [];
  lines.push(`📊 *ניתוח הוצאות חודשי - ${monthName}*`);
  lines.push('─────────────────────');
  lines.push(`הקטגוריה הכי יקרה שלך היא *${topCat}* עם סכום של *${topAmt} ₪*.`);
  lines.push(`זה מהווה *${topPct}%* מכלל ההוצאות שלך החודש.`);
  lines.push('');
  lines.push(`סה"כ ${rows.length} רישומים | *${grandTotal} ₪* סך הכל`);

  if (sorted.length > 1) {
    lines.push('');
    lines.push('*פירוט לפי קטגוריה:*');
    for (const [cat, amt] of sorted) {
      const pct = Math.round((amt / grandTotal) * 100);
      const bar = '█'.repeat(Math.max(1, Math.round(pct / 5)));
      lines.push(`${bar} ${cat}: ${amt} ₪ (${pct}%)`);
    }
  }

  // MoM
  try {
    const prevTotals = await getPrevMonthTotals();
    const mom = momLine(categoryTotals, prevTotals);
    if (mom) { lines.push(''); lines.push('*השוואה לחודש קודם:*'); lines.push(mom); }
  } catch (e) {
    console.error('[sheets] MoM failed:', e.message);
  }

  return lines.join('\n');
}

// ===================== Proactive Messaging =====================

async function sendWhatsAppMessage(to, body) {
  if (!twilioClient || !FROM_WHATSAPP_NUMBER) {
    console.error('[cron] Cannot send: missing Twilio credentials or FROM_WHATSAPP_NUMBER');
    return;
  }
  try {
    await twilioClient.messages.create({
      from: fmtWA(FROM_WHATSAPP_NUMBER),
      to: fmtWA(to),
      body,
    });
    console.log('[cron] Sent to', to, ':', body.slice(0, 60));
  } catch (e) {
    console.error('[cron] Send failed:', e.message);
  }
}

// ===================== Session State Machine =====================

const HIGH_AMOUNT_THRESHOLD = 2000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const UNDO_TTL_MS = 5 * 60 * 1000;
const DAILY_PROMPT_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * States:
 *   IDLE, AWAITING_DESCRIPTION, AWAITING_AMOUNT, AWAITING_HIGH_CONFIRM,
 *   AWAITING_RECEIPT, AWAITING_DAILY_REPLY
 */
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { state: 'IDLE', ts: Date.now() });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  const prev = sessions.get(phone);
  const carry = {};
  if (prev && prev.lastRow) {
    carry.lastRow = prev.lastRow;
    carry.lastRowTs = prev.lastRowTs;
  }
  sessions.set(phone, { state: 'IDLE', ts: Date.now(), ...carry });
}

function isSessionExpired(session) {
  const ttl =
    session.state === 'AWAITING_DAILY_REPLY'
      ? DAILY_PROMPT_TTL_MS
      : SESSION_TTL_MS;
  return Date.now() - session.ts > ttl;
}

function canUndo(session) {
  return session.lastRow && session.lastRowTs && Date.now() - session.lastRowTs < UNDO_TTL_MS;
}

function confirmationMsg(amount, desc, category) {
  return (
    `רשמתי לי 🙂 *${amount} ₪* עבור *${desc}*.\n` +
    `זה נכנס תחת ${category}.\n\n` +
    `האם יש לך צילום של הקבלה? (כן / לא)`
  );
}

async function saveAndConfirm(res, phone, amount, desc, category) {
  if (amount > HIGH_AMOUNT_THRESHOLD) {
    const s = getSession(phone);
    s.state = 'AWAITING_HIGH_CONFIRM';
    s.pendingAmount = amount;
    s.pendingDesc = desc;
    s.pendingCategory = category;
    s.ts = Date.now();
    sendTwiML(res, `זה סכום גבוה מהרגיל (*${amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`);
    return;
  }

  try {
    const row = await appendExpenseRow(desc, amount, category);
    const s = getSession(phone);
    s.lastRow = row;
    s.lastRowTs = Date.now();
    s.state = 'AWAITING_RECEIPT';
    s.receiptRow = row;
    s.ts = Date.now();
    sendTwiML(res, confirmationMsg(amount, desc, category));
  } catch (e) {
    console.error('[sheets] append failed:', e.message);
    sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
  }
}

// ===================== Response Templates =====================

function buildCategoriesList() {
  const lines = ['📋 *רשימת הקטגוריות:*', ''];
  for (const { keywords, category } of CATEGORY_MAP) {
    lines.push(`• ${category} — מילות מפתח: ${keywords.join(', ')}`);
  }
  lines.push(`• ${DEFAULT_CATEGORY} — ברירת מחדל`);
  lines.push('');
  lines.push('שלח הוצאה עם מילת מפתח ואני אסווג אוטומטית!');
  return lines.join('\n');
}

function buildGreeting() {
  return (
    'היי! 👋 אני הבוט שלך לניהול החזרי הוצאות.\n\n' +
    '*פקודות עיקריות:*\n' +
    '• *סכום + תיאור* — רישום הוצאה (למשל: *150 דלק*)\n' +
    '• *"סיכום"* — דוח חודשי מלא\n' +
    '• *"סטטיסטיקה"* — ניתוח הוצאות\n' +
    '• *"קטגוריות"* — רשימת קטגוריות\n' +
    '• *"מחק"* — ביטול רישום אחרון\n\n' +
    '*מעקב הגשה:*\n' +
    '• *"מה לא הוגש"* — רשימת הוצאות פתוחות\n' +
    '• *"הגשתי"* — סימון הכל כהוגש\n\n' +
    'בואו נתחיל! 💪'
  );
}

// ===================== Config Log =====================

function logConfigOnce() {
  console.log('[config] TWILIO_ACCOUNT_SID:', TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}…` : '(missing)');
  console.log('[config] TWILIO_AUTH_TOKEN:', TWILIO_AUTH_TOKEN ? '(set)' : '(missing)');
  console.log('[config] FROM_WHATSAPP_NUMBER:', FROM_WHATSAPP_NUMBER || '(missing)');
  console.log('[config] TO_WHATSAPP_NUMBER:', TO_WHATSAPP_NUMBER || '(missing)');
  console.log('[config] GOOGLE_SHEET_ID:', GOOGLE_SHEET_ID || '(missing)');
  const localCredsPath = path.join(__dirname, 'Expense-Tracker-Bot.json');
  const credsSource = serviceAccountCreds
    ? fs.existsSync(localCredsPath) ? 'Expense-Tracker-Bot.json' : 'GOOGLE_SERVICE_ACCOUNT_JSON (env)'
    : '(missing)';
  console.log('[config] Google Service Account:', credsSource);
  console.log('[config] Twilio client:', twilioClient ? 'ready' : '(disabled)');
}
logConfigOnce();

// ===================== Routes =====================

const TWILIO_FROM_TEST = 'whatsapp:+15551234567';

app.post('/whatsapp', async (req, res) => {
  const bodyRaw = req.body.Body ?? '';
  const from = req.body.From || '';
  console.log('[whatsapp]', from, ':', bodyRaw || '(no Body)');

  const trimmed = String(bodyRaw).trim();
  const lower = trimmed.toLowerCase();
  const phone = from.replace('whatsapp:', '');
  const session = getSession(phone);

  if (session.state !== 'IDLE' && isSessionExpired(session)) {
    if (session.state === 'AWAITING_RECEIPT' && session.receiptRow) {
      await updateRowField(session.receiptRow, 'Receipt', 'No');
    }
    resetSession(phone);
  }

  // ─── UNDO ───
  if (matchesAny(lower, INTENT_UNDO)) {
    if (canUndo(getSession(phone))) {
      const s = getSession(phone);
      const ok = await deleteRow(s.lastRow);
      s.lastRow = null;
      s.lastRowTs = null;
      sendTwiML(res, ok ? '✓ הרישום האחרון בוטל בהצלחה.' : 'לא הצלחתי למחוק, נסה שוב.');
    } else {
      sendTwiML(res, 'אין רישום אחרון לביטול (או שעבר יותר מ-5 דקות).');
    }
    return;
  }

  // ─── SUMMARY ───
  if (matchesAny(lower, INTENT_SUMMARY)) {
    let responseText;
    try {
      responseText = await buildMonthlySummary();
      if (!responseText) responseText = `סה״כ הוצאות: ${await sumAmountColumn()} ₪`;
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
      responseText = 'לא הצלחתי לשלוף סיכום, נסה שוב';
    }
    sendTwiML(res, responseText);
    return;
  }

  // ─── STATS ───
  if (matchesAny(lower, INTENT_STATS)) {
    let responseText;
    try {
      responseText = await buildMonthlyStats();
      if (!responseText) responseText = 'לא הצלחתי לשלוף נתונים, נסה שוב';
    } catch (e) {
      console.error('[sheets] stats failed:', e.message);
      responseText = 'לא הצלחתי לשלוף נתונים, נסה שוב';
    }
    sendTwiML(res, responseText);
    return;
  }

  // ─── NOT SUBMITTED (מה לא הוגש) ───
  if (matchesAny(lower, INTENT_NOT_SUBMITTED)) {
    try {
      const open = await getUnsubmittedRows();
      if (open.length === 0) {
        sendTwiML(res, '✅ כל ההוצאות החודש הוגשו! אין פריטים פתוחים.');
      } else {
        const total = open.reduce((s, r) => s + r.amt, 0);
        const lines = [`📝 *${open.length} הוצאות טרם הוגשו (${total} ₪):*`, ''];
        for (const r of open) {
          const rcpt = r.receipt === 'Yes' ? '✅' : '❌';
          lines.push(`• ${r.desc} — *${r.amt} ₪* (${r.cat}) | קבלה: ${rcpt}`);
        }
        lines.push('');
        lines.push('שלח *"הגשתי"* כדי לסמן הכל כהוגש.');
        sendTwiML(res, lines.join('\n'));
      }
    } catch (e) {
      console.error('[sheets] unsubmitted failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לשלוף נתונים, נסה שוב');
    }
    return;
  }

  // ─── MARK SUBMITTED (הגשתי) ───
  if (matchesAny(lower, INTENT_MARK_SUBMITTED)) {
    try {
      const count = await markAllCurrentMonthSubmitted();
      if (count === 0) {
        sendTwiML(res, '✅ כל ההוצאות כבר מסומנות כהוגשו!');
      } else {
        sendTwiML(res, `מעולה! *${count}* הוצאות החודש סומנו כהוגשו. 💰`);
      }
    } catch (e) {
      console.error('[sheets] mark submitted failed:', e.message);
      sendTwiML(res, 'שגיאה בעדכון, נסה שוב');
    }
    return;
  }

  // ─── CATEGORIES LIST ───
  if (matchesAny(lower, INTENT_CATEGORIES)) {
    sendTwiML(res, buildCategoriesList());
    return;
  }

  // ─── BUDGET ───
  if (matchesAny(lower, INTENT_BUDGET)) {
    try {
      const data = await getCurrentMonthRows(false);
      if (data && data.rows.length > 0) {
        const total = data.rows.reduce((s, r) => s + r.amt, 0);
        sendTwiML(res,
          `📈 סה"כ הוצאות החודש: *${total} ₪*\n(${data.rows.length} רישומים)\n\nשלח *"סיכום"* לדוח מלא`
        );
      } else {
        sendTwiML(res, 'עדיין אין הוצאות החודש. רשום הוצאה ונסה שוב!');
      }
    } catch (e) {
      console.error('[sheets] budget failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לשלוף נתונים, נסה שוב');
    }
    return;
  }

  // ─── GREETING ───
  if (matchesAny(lower, INTENT_GREETING) && !lower.match(/\d/)) {
    sendTwiML(res, buildGreeting());
    return;
  }

  // ─── POLITENESS ───
  if (matchesAny(lower, INTENT_POLITENESS)) {
    sendTwiML(res, 'בשמחה! 😊 תכתוב *"סיכום"* כדי לראות את המצב החודשי.');
    return;
  }

  // ─── SESSION STATES ───

  // AWAITING_RECEIPT
  if (getSession(phone).state === 'AWAITING_RECEIPT') {
    const s = getSession(phone);
    const receiptRow = s.receiptRow;
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      await updateRowField(receiptRow, 'Receipt', 'Yes');
      resetSession(phone);
      sendTwiML(res, '✅ מעולה, קבלה מאושרת!\nלביטול הרישום, השב *"מחק"*');
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) {
      await updateRowField(receiptRow, 'Receipt', 'No');
      resetSession(phone);
      sendTwiML(res, '📌 תזכורת: נסה לשמור את הקבלה לצורך ההחזר.\nלביטול הרישום, השב *"מחק"*');
      return;
    }
    // Any other message — default Receipt to No and process normally
    await updateRowField(receiptRow, 'Receipt', 'No');
    resetSession(phone);
    // Fall through to normal parsing
  }

  // AWAITING_DAILY_REPLY
  if (getSession(phone).state === 'AWAITING_DAILY_REPLY') {
    resetSession(phone);
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      sendTwiML(res, 'מעולה! שלח לי את ההוצאות ואני ארשום 📝');
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) {
      sendTwiML(res, 'יופי, ערב טוב! 🌙');
      return;
    }
  }

  // AWAITING_DESCRIPTION
  if (getSession(phone).state === 'AWAITING_DESCRIPTION') {
    const s = getSession(phone);
    const pendingAmount = s.pendingAmount;
    const parsed = parseExpenseMessage(trimmed);
    if (parsed.amount && parsed.description) {
      resetSession(phone);
    } else {
      const desc = sanitizeDescription(trimmed) || '(ללא תיאור)';
      const category = matchCategory(desc);
      resetSession(phone);
      await saveAndConfirm(res, phone, pendingAmount, desc, category);
      return;
    }
  }

  // AWAITING_AMOUNT
  if (getSession(phone).state === 'AWAITING_AMOUNT') {
    const s = getSession(phone);
    const parsed = parseExpenseMessage(trimmed);
    if (parsed.amount) {
      const { pendingDesc, pendingCategory } = s;
      resetSession(phone);
      await saveAndConfirm(res, phone, parsed.amount, pendingDesc, pendingCategory);
      return;
    }
    resetSession(phone);
    sendTwiML(res, 'לא הצלחתי לזהות סכום. נסה שוב עם מספר (למשל: *50*)');
    return;
  }

  // AWAITING_HIGH_CONFIRM
  if (getSession(phone).state === 'AWAITING_HIGH_CONFIRM') {
    const s = getSession(phone);
    const { pendingAmount, pendingDesc, pendingCategory } = s;
    resetSession(phone);
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      try {
        const row = await appendExpenseRow(pendingDesc, pendingAmount, pendingCategory);
        const ns = getSession(phone);
        ns.lastRow = row;
        ns.lastRowTs = Date.now();
        ns.state = 'AWAITING_RECEIPT';
        ns.receiptRow = row;
        ns.ts = Date.now();
        sendTwiML(res, confirmationMsg(pendingAmount, pendingDesc, pendingCategory));
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) {
      sendTwiML(res, 'בוטל ✓ הרישום לא נשמר.');
      return;
    }
  }

  // ─── CURRENCY ALERT ───
  if (CURRENCY_RE.test(trimmed)) {
    sendTwiML(res, '⚠️ שים לב — הבוט רושם הוצאות ב-₪ בלבד.\nאם הסכום בש"ח, שלח בלי סימן מטבע זר.');
    return;
  }

  // ─── NORMAL EXPENSE PARSING ───
  const { amount, description } = parseExpenseMessage(trimmed);

  if (amount && description) {
    const category = matchCategory(description);
    await saveAndConfirm(res, phone, amount, description, category);
    return;
  }

  if (amount && !description) {
    const s = getSession(phone);
    s.state = 'AWAITING_DESCRIPTION';
    s.pendingAmount = amount;
    s.ts = Date.now();
    sendTwiML(res, `קיבלתי *${amount} ₪*. עבור מה ההוצאה? (למשל: חניה)`);
    return;
  }

  if (!amount && description) {
    const category = matchCategory(description);
    const emoji = categoryEmoji(description);
    const s = getSession(phone);
    s.state = 'AWAITING_AMOUNT';
    s.pendingDesc = description;
    s.pendingCategory = category;
    s.ts = Date.now();
    sendTwiML(res, `קיבלתי שזו הוצאה על ${description} ${emoji}. כמה זה עלה?`);
    return;
  }

  sendTwiML(res, 'לא הבנתי 🤔\nשלח *סכום + תיאור* (למשל: *150 דלק*)\nאו שלח *"שלום"* לרשימת הפקודות.');
});

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.Body || '';
    const { amount, description } = parseExpenseMessage(message);
    if (amount) {
      const desc = description || '(ללא תיאור)';
      const category = matchCategory(description);
      try { await saveToSheet(desc, amount, category); } catch (e) { console.error('[webhook] sheets:', e.message); }
      sendTwiML(res, `רשמתי לי 🙂 *${amount} ₪* עבור *${desc}*. זה נכנס תחת ${category}.`);
    } else {
      sendTwiML(res, `קיבלתי ממך: ${message}`);
    }
  } catch (error) {
    console.error(error);
    sendTwiML(res, 'קרתה שגיאה, נסה שוב');
  }
});

// ===================== Cron Jobs =====================

const CRON_TZ = process.env.CRON_TZ || 'Asia/Jerusalem';

if (TO_WHATSAPP_NUMBER && twilioClient) {
  // Daily 20:00
  cron.schedule('0 20 * * *', async () => {
    console.log('[cron] Daily expense prompt');
    const phone = TO_WHATSAPP_NUMBER.replace('whatsapp:', '');
    const s = getSession(phone);
    s.state = 'AWAITING_DAILY_REPLY';
    s.ts = Date.now();
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, 'היי! 👋 היו לך הוצאות היום? (כן / לא)');
  }, { timezone: CRON_TZ });

  // Sundays 10:00 — missing receipts reminder
  cron.schedule('0 10 * * 0', async () => {
    console.log('[cron] Missing receipts reminder');
    try {
      const missing = await getMissingReceiptRows();
      if (missing.length === 0) return;
      const lines = [`היי, רשמת *${missing.length}* הוצאות ללא אישור קבלה. הכל שמור? 📑`, ''];
      for (const r of missing.slice(0, 10)) {
        lines.push(`• ${r.desc} — *${r.amt} ₪*`);
      }
      if (missing.length > 10) lines.push(`...ועוד ${missing.length - 10}`);
      await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, lines.join('\n'));
    } catch (e) {
      console.error('[cron] Missing receipts failed:', e.message);
    }
  }, { timezone: CRON_TZ });

  // 25th 20:00 — deadline alert
  cron.schedule('0 20 25 * *', async () => {
    console.log('[cron] Deadline alert');
    try {
      const open = await getUnsubmittedRows();
      if (open.length === 0) return;
      const total = open.reduce((s, r) => s + r.amt, 0);
      await sendWhatsAppMessage(
        TO_WHATSAPP_NUMBER,
        `🚨 יום הגשת החזרים מתקרב!\nיש לך *${open.length}* הוצאות פתוחות בסך *${total} ₪* שטרם הוגשו.\nכדאי לסיים עם זה!\n\nשלח *"הגשתי"* לסמן הכל.`
      );
    } catch (e) {
      console.error('[cron] Deadline alert failed:', e.message);
    }
  }, { timezone: CRON_TZ });

  // Monthly 29th 20:00
  cron.schedule('0 20 29 * *', async () => {
    console.log('[cron] Monthly report reminder');
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, 'תזכורת חודשית 📋 הגיע הזמן להגיש דוחות!\nשלח *"סיכום"* לקבלת סה״כ ההוצאות.');
  }, { timezone: CRON_TZ });

  console.log(`[cron] Scheduled: daily 20:00, Sundays 10:00, 25th 20:00, 29th 20:00 (${CRON_TZ})`);
} else {
  console.log('[cron] Disabled — set TO_WHATSAPP_NUMBER + Twilio credentials to enable.');
}

// ===================== Server =====================

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

function runLocalUnitChecks() {
  console.log('\n=== [smoke] בדיקות יחידה ===');
  const a = parseExpenseMessage('hello');
  const b = parseExpenseMessage('150 דלק');
  const c = parseExpenseMessage('הוצאתי 50 שקל על דלק');
  console.log('  parse("hello") →', JSON.stringify(a), a.amount === 0 ? '✓' : '✗');
  console.log('  parse("150 דלק") →', JSON.stringify(b), b.amount === 150 && b.description === 'דלק' ? '✓' : '✗');
  console.log('  parse("הוצאתי 50 שקל על דלק") →', JSON.stringify(c), c.amount === 50 && c.description === 'דלק' ? '✓' : '✗');

  console.log('\n=== [smoke] קטגוריות ===');
  const cats = [['בחנייה', 'החזרי חנייה 🅿️'], ['למונית', 'החזרי מוניות 🚕']];
  for (const [desc, expected] of cats) {
    const got = matchCategory(desc);
    console.log(`  category("${desc}") → ${got}`, got === expected ? '✓' : `✗`);
  }

  console.log('\n=== [smoke] intents ===');
  console.log('  "הסיכום" → SUMMARY:', matchesAny('הסיכום', INTENT_SUMMARY) ? '✓' : '✗');
  console.log('  "מה לא הוגש" → NOT_SUB:', matchesAny('מה לא הוגש', INTENT_NOT_SUBMITTED) ? '✓' : '✗');
  console.log('  "הגשתי" → MARK_SUB:', matchesAny('הגשתי', INTENT_MARK_SUBMITTED) ? '✓' : '✗');
}

function postForm(port, urlPath, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, body: d })); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runHttpSmokeTests(port) {
  console.log('\n=== [smoke] בדיקות HTTP ===');
  const F = TWILIO_FROM_TEST;
  const strip = (b) => b.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 130);

  const cases = [
    { name: 'greeting', fields: { Body: 'שלום', From: F } },
    { name: '150 דלק → save+receipt', fields: { Body: '150 דלק', From: F } },
    { name: 'כן → receipt yes', fields: { Body: 'כן', From: F } },
    { name: 'תרופות 80 → save', fields: { Body: 'תרופות 80', From: F } },
    { name: 'לא → receipt no', fields: { Body: 'לא', From: F } },
    { name: 'מחק → undo', fields: { Body: 'מחק', From: F } },
    { name: '42 → ask desc', fields: { Body: '42', From: F } },
    { name: 'חניה → complete', fields: { Body: 'חניה', From: F } },
    { name: 'כן → receipt', fields: { Body: 'כן', From: F } },
    { name: 'מונית → ask amt', fields: { Body: 'מונית', From: F } },
    { name: '55 → complete', fields: { Body: '55', From: F } },
    { name: 'לא → receipt', fields: { Body: 'לא', From: F } },
    { name: '3000 דלק → high', fields: { Body: '3000 דלק', From: F } },
    { name: 'כן → confirm high', fields: { Body: 'כן', From: F } },
    { name: 'כן → receipt', fields: { Body: 'כן', From: F } },
    { name: 'מה לא הוגש', fields: { Body: 'מה לא הוגש', From: F } },
    { name: 'הגשתי', fields: { Body: 'הגשתי', From: F } },
    { name: 'סיכום', fields: { Body: 'סיכום', From: F } },
    { name: 'סטטיסטיקה', fields: { Body: 'סטטיסטיקה', From: F } },
    { name: '$50 → currency', fields: { Body: '$50 דלק', From: F } },
  ];

  for (const t of cases) {
    try {
      const { status, body } = await postForm(port, t.path || '/whatsapp', t.fields);
      console.log(`  [${t.name}] ${status} → ${strip(body)}${body.length > 130 ? '…' : ''}`);
    } catch (e) {
      console.error(`  [${t.name}] שגיאה:`, e.message);
    }
  }
  console.log('\n=== [smoke] סיום ===\n');
}

if (process.env.SMOKE_TEST === '1') {
  runLocalUnitChecks();
  const server = app.listen(PORT, async () => {
    console.log(`[smoke] שרת זמני על פורט ${PORT}`);
    try { await runHttpSmokeTests(PORT); }
    finally { server.close(() => { process.exit(0); }); }
  });
} else {
  app.listen(PORT, () => {
    console.log(`Listening on ${PORT}`);
    console.log('Webhooks: POST /whatsapp  |  POST /webhook');
  });
}
