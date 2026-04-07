/**
 * בוט WhatsApp — Professional Reimbursement Management System.
 * Twilio Sandbox + Google Sheets + Google Drive receipt images.
 * Columns: A Date | B Description | C Amount | D Category | E Receipt | F Submitted | G Time | H ReceiptImage
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
const cron = require('node-cron');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ===================== Credentials =====================

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const FROM_WHATSAPP_NUMBER = (process.env.FROM_WHATSAPP_NUMBER || '').trim();
const TO_WHATSAPP_NUMBER = (process.env.TO_WHATSAPP_NUMBER || '').trim();
const GOOGLE_SHEET_ID = (
  process.env.GOOGLE_SHEET_ID || '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48'
).trim();
const GOOGLE_DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function fmtWA(num) {
  return num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
}

// ===================== Google Service Account =====================

function loadGoogleServiceAccountCreds() {
  const localPath = path.join(__dirname, 'Expense-Tracker-Bot.json');
  if (fs.existsSync(localPath)) {
    try { return require('./Expense-Tracker-Bot.json'); }
    catch (e) { console.error('[config] Expense-Tracker-Bot.json:', e.message); }
  }
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try { return JSON.parse(raw); }
    catch (e) { console.error('[config] GOOGLE_SERVICE_ACCOUNT_JSON:', e.message); }
  }
  return null;
}

const serviceAccountCreds = loadGoogleServiceAccountCreds();

// ===================== Google Sheets Client =====================

let sheetsClientPromise = null;

function getSpreadsheetDoc() {
  if (!GOOGLE_SHEET_ID || !serviceAccountCreds) return null;
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const auth = new JWT({
        email: serviceAccountCreds.client_email,
        key: serviceAccountCreds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth);
      await doc.loadInfo();
      return doc;
    })();
  }
  return sheetsClientPromise;
}

// ===================== Google Drive Client =====================

let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;
  if (!serviceAccountCreds) return null;
  const auth = new JWT({
    email: serviceAccountCreds.client_email,
    key: serviceAccountCreds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

async function downloadTwilioMedia(mediaUrl) {
  const resp = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
  });
  return { buffer: Buffer.from(resp.data), contentType: resp.headers['content-type'] || 'image/jpeg' };
}

function bufferToStream(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

async function uploadToDrive(buffer, contentType, fileName) {
  const drive = getDriveClient();
  if (!drive) { console.error('[drive] No Drive client'); return null; }

  const fileMetadata = { name: fileName };
  if (GOOGLE_DRIVE_FOLDER_ID) fileMetadata.parents = [GOOGLE_DRIVE_FOLDER_ID];

  try {
    const res = await drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType: contentType, body: bufferToStream(buffer) },
      fields: 'id,webViewLink',
    });

    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    console.log(`[drive] Uploaded ${fileName} → ${res.data.webViewLink}`);
    return res.data.webViewLink;
  } catch (e) {
    console.error('[drive] Upload failed:', e.message);
    return null;
  }
}

async function handleMediaUpload(req) {
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  if (numMedia === 0) return null;

  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0 || 'image/jpeg';
  if (!mediaUrl) return null;

  try {
    const { buffer, contentType } = await downloadTwilioMedia(mediaUrl);
    const ext = contentType.includes('png') ? 'png' : contentType.includes('pdf') ? 'pdf' : 'jpg';
    const fileName = `receipt_${Date.now()}.${ext}`;
    const link = await uploadToDrive(buffer, contentType, fileName);
    return link;
  } catch (e) {
    console.error('[media] Download/upload failed:', e.message);
    return null;
  }
}

/** Extract Google Drive file ID from webViewLink or open URL */
function parseDriveFileIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  const m1 = u.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

async function deleteDriveFileByUrl(url) {
  const id = parseDriveFileIdFromUrl(url);
  if (!id) return false;
  const drive = getDriveClient();
  if (!drive) return false;
  try {
    await drive.files.delete({ fileId: id });
    console.log(`[drive] Deleted file ${id}`);
    return true;
  } catch (e) {
    console.error('[drive] Delete failed:', e.message);
    return false;
  }
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
/** Full-month management list: ניהול / תיקון / מחק (phrases) — bare "מחק" stays quick-undo */
const INTENT_MANAGEMENT = [
  'ניהול', 'תיקון', 'תיקונים', 'נהל', 'עריכה', 'עריכת רשומות',
  'מחק שורה', 'מחק מהרשימה', 'מחק רשומה', 'רשימת ניהול',
];

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
    if (keywords.some((kw) => lower.includes(kw) || stripped.includes(kw))) return category;
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
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendTwiML(res, messageText) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(messageText)}</Message></Response>`);
}

function sendTwiMLMulti(res, parts) {
  const msgs = Array.isArray(parts) ? parts.filter(Boolean) : [parts];
  const inner = msgs.map((p) => `<Message>${escapeXml(p)}</Message>`).join('');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}

// ===================== Google Sheets =====================

const SHEET_HEADERS = ['Date', 'Description', 'Amount', 'Category', 'Receipt', 'Submitted', 'Time', 'ReceiptImage'];

async function ensureHeaders(sheet) {
  await sheet.loadHeaderRow(1);
  const h = sheet.headerValues || [];
  if (!(h.length >= 8 && h[0] === 'Date' && h[7] === 'ReceiptImage') && h.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(SHEET_HEADERS);
  }
}

function formatNow() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return { date: `${dd}/${mm}/${now.getFullYear()}`, time: now.toLocaleTimeString('he-IL') };
}

function parseSheetDate(str) {
  if (!str) return new Date(NaN);
  const p = str.split('/');
  if (p.length === 3) return new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
  return new Date(str);
}

function getCol(row, col) {
  return (typeof row.get === 'function' ? row.get(col) : row[col]) || '';
}

async function appendExpenseRow(description, amount, category, receipt, receiptImage) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  const { date, time } = formatNow();
  const row = await sheet.addRow({
    Date: date,
    Description: description,
    Amount: amount,
    Category: category,
    Receipt: receipt || '',
    Submitted: 'No',
    Time: time,
    ReceiptImage: receiptImage || '',
  });
  return row;
}

async function updateRowField(row, field, value) {
  if (!row) return;
  try {
    if (typeof row.set === 'function') row.set(field, value);
    else row[field] = value;
    await row.save();
  } catch (e) { console.error(`[sheets] update ${field} failed:`, e.message); }
}

async function getRowByIndex(rowIndex) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  const rows = await sheet.getRows();
  return rows.find((r) => r.rowNumber === rowIndex) || null;
}

async function updateRowByIndex(rowIndex, field, value) {
  try {
    const target = await getRowByIndex(rowIndex);
    if (!target) { console.error(`[sheets] row ${rowIndex} not found`); return false; }
    if (typeof target.set === 'function') target.set(field, value);
    else target[field] = value;
    await target.save();
    console.log(`[sheets] row ${rowIndex} → ${field}=${String(value).slice(0, 60)}`);
    return true;
  } catch (e) {
    console.error(`[sheets] updateRowByIndex(${rowIndex}, ${field}) failed:`, e.message);
    return false;
  }
}

async function updateMultipleFieldsByIndex(rowIndex, updates) {
  try {
    const target = await getRowByIndex(rowIndex);
    if (!target) { console.error(`[sheets] row ${rowIndex} not found`); return false; }
    for (const [field, value] of Object.entries(updates)) {
      if (typeof target.set === 'function') target.set(field, value);
      else target[field] = value;
    }
    await target.save();
    console.log(`[sheets] row ${rowIndex} → updated ${Object.keys(updates).join(', ')}`);
    return true;
  } catch (e) {
    console.error(`[sheets] updateMultiple(${rowIndex}) failed:`, e.message);
    return false;
  }
}

async function deleteRowByIndex(rowIndex) {
  try {
    const target = await getRowByIndex(rowIndex);
    if (!target) return false;
    await target.delete();
    return true;
  } catch (e) {
    console.error(`[sheets] deleteRowByIndex(${rowIndex}) failed:`, e.message);
    return false;
  }
}

async function saveToSheet(description, amount, category) {
  return appendExpenseRow(description, parseFloat(amount) || 0, category || DEFAULT_CATEGORY, '', '');
}

async function getRowsForMonth(targetYear, targetMonth, includeRaw) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  const allRows = await sheet.getRows();
  const rows = [];
  for (const row of allRows) {
    const d = parseSheetDate(getCol(row, 'Date'));
    if (d.getFullYear() !== targetYear || d.getMonth() !== targetMonth) continue;
    const amt = parseFloat(getCol(row, 'Amount'));
    if (Number.isNaN(amt) || amt === 0) continue;
    const entry = {
      amt, cat: getCol(row, 'Category') || DEFAULT_CATEGORY,
      desc: getCol(row, 'Description'), receipt: getCol(row, 'Receipt'),
      submitted: getCol(row, 'Submitted'), date: getCol(row, 'Date'),
      time: getCol(row, 'Time'), receiptImage: getCol(row, 'ReceiptImage'),
    };
    if (includeRaw) entry.row = row;
    rows.push(entry);
  }
  return rows;
}

async function getCurrentMonthRows(includeRaw) {
  const now = new Date();
  const rows = await getRowsForMonth(now.getFullYear(), now.getMonth(), includeRaw);
  return rows ? { rows, curYear: now.getFullYear(), curMonth: now.getMonth() } : null;
}

async function sumAmountColumn() {
  const doc = await getSpreadsheetDoc();
  if (!doc) return 0;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  let total = 0;
  for (const row of await sheet.getRows()) {
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
  for (const { amt, cat } of rows) totals.set(cat, (totals.get(cat) || 0) + amt);
  return totals;
}

function momLine(curTotals, prevTotals, prevMonthName) {
  if (prevTotals.size === 0) return '';
  const lines = [];
  for (const [cat, curAmt] of curTotals) {
    const prevAmt = prevTotals.get(cat);
    if (!prevAmt) continue;
    const diff = Math.round(((curAmt - prevAmt) / prevAmt) * 100);
    if (diff === 0) continue;
    const direction = diff > 0 ? 'יותר' : 'פחות';
    lines.push(`החודש הוצאת *${Math.abs(diff)}%* ${direction} על ${cat} לעומת ${prevMonthName}.`);
  }
  return lines.join('\n');
}

async function getPrevMonthData() {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() - 1;
  if (m < 0) { m = 11; y--; }
  const rows = await getRowsForMonth(y, m, false);
  return { totals: rows ? buildCategoryTotals(rows) : new Map(), monthName: HEB_MONTHS[m] };
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

  if (rows.length === 0) return 'עדיין אין הוצאות רשומות לחודש זה. רוצה לרשום משהו עכשיו? ✍️';

  const categoryTotals = new Map();
  const categoryItems = new Map();
  let noReceipt = 0, notSubmitted = 0;

  for (const r of rows) {
    categoryTotals.set(r.cat, (categoryTotals.get(r.cat) || 0) + r.amt);
    if (!categoryItems.has(r.cat)) categoryItems.set(r.cat, []);
    categoryItems.get(r.cat).push({ desc: r.desc, amt: r.amt, time: r.time });
    if (r.receipt !== 'Yes') noReceipt++;
    if (r.submitted !== 'Yes') notSubmitted++;
  }

  let grandTotal = 0;
  const lines = [];
  lines.push(`📊 *סיכום החזרים חודשי - ${monthName}*`);
  lines.push('─────────────────────');

  for (const [cat, total] of [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])) {
    grandTotal += total;
    const emoji = cat.match(/\p{Emoji_Presentation}/u)?.[0] || '•';
    lines.push(`${emoji} *${cat}*: ${total} ₪`);
    const items = categoryItems.get(cat) || [];
    if (items.length > 1) {
      for (const it of items) {
        const ts = it.time ? ` (${it.time})` : '';
        lines.push(`      ${it.desc} — ${it.amt} ₪${ts}`);
      }
    }
  }

  lines.push('─────────────────────');
  lines.push(`💰 *סה"כ מצטבר להחזר: ${grandTotal} ₪*`);

  try {
    const prev = await getPrevMonthData();
    const mom = momLine(categoryTotals, prev.totals, prev.monthName);
    if (mom) { lines.push(''); lines.push(mom); }
  } catch (_) {}

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

  if (rows.length === 0) return 'עדיין אין מספיק נתונים לניתוח. רשום הוצאות ונסה שוב! 📈';

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

  try {
    const prev = await getPrevMonthData();
    const mom = momLine(categoryTotals, prev.totals, prev.monthName);
    if (mom) { lines.push(''); lines.push('*השוואה לחודש קודם:*'); lines.push(mom); }
  } catch (_) {}

  return lines.join('\n');
}

// ===================== Proactive Messaging =====================

async function sendWhatsAppMessage(to, body) {
  if (!twilioClient || !FROM_WHATSAPP_NUMBER) return;
  try {
    await twilioClient.messages.create({ from: fmtWA(FROM_WHATSAPP_NUMBER), to: fmtWA(to), body });
    console.log('[cron] Sent to', to, ':', body.slice(0, 60));
  } catch (e) { console.error('[cron] Send failed:', e.message); }
}

// ===================== Session State Machine =====================

const HIGH_AMOUNT_THRESHOLD = 2000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const RECEIPT_IMAGE_TTL_MS = 5 * 60 * 1000;
const UNDO_TTL_MS = 5 * 60 * 1000;
const DAILY_PROMPT_TTL_MS = 4 * 60 * 60 * 1000;
const MANAGEMENT_TTL_MS = 10 * 60 * 1000;

const MANAGEMENT_STATES = new Set([
  'MANAGEMENT_SELECTING',
  'MANAGEMENT_EDIT_MENU',
  'MANAGEMENT_AWAITING_NEW_AMOUNT',
  'MANAGEMENT_AWAITING_NEW_DESC',
  'MANAGEMENT_AWAITING_RECEIPT_EDIT',
]);

/**
 * States:
 *   IDLE, AWAITING_DESCRIPTION, AWAITING_AMOUNT, AWAITING_HIGH_CONFIRM,
 *   AWAITING_RECEIPT_IMAGE  — text-first: waiting for image or כן/לא (5 min)
 *   AWAITING_EXPENSE_DETAILS — image-first: waiting for text (amount+desc)
 *   AWAITING_DAILY_REPLY
 *   MANAGEMENT_* — full-month edit flow (10 min TTL)
 */
const sessions = new Map();
const userState = {};

function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { state: 'IDLE', ts: Date.now() });
  return sessions.get(phone);
}

function getUserState(phone) {
  if (!userState[phone]) userState[phone] = {};
  return userState[phone];
}

function resetSession(phone) {
  sessions.set(phone, { state: 'IDLE', ts: Date.now() });
}

function isSessionExpired(session) {
  if (session.state === 'AWAITING_DAILY_REPLY') return Date.now() - session.ts > DAILY_PROMPT_TTL_MS;
  if (session.state === 'AWAITING_RECEIPT_IMAGE') return Date.now() - session.ts > RECEIPT_IMAGE_TTL_MS;
  if (MANAGEMENT_STATES.has(session.state)) return Date.now() - session.ts > MANAGEMENT_TTL_MS;
  return Date.now() - session.ts > SESSION_TTL_MS;
}

function clearManagement(phone) {
  const us = userState[phone];
  if (us) {
    delete us.activeSelection;
    delete us.managementEditRow;
  }
}

function formatEditRowDetails(entry) {
  return `${entry.date} | ${entry.desc} | *${entry.amt} ₪*`;
}

function editMenuPrompt(entry) {
  return `בחרת ב: ${formatEditRowDetails(entry)}.\nמה תרצה לעשות?\n(מחק / סכום חדש / תיאור חדש / שלח קבלה / ביטול)`;
}

async function refreshManagementEditSnapshot(phone) {
  const us = getUserState(phone);
  const rowNum = us.managementEditRow?.sheetRowNumber;
  if (!rowNum) return null;
  const row = await getRowByIndex(rowNum);
  if (!row) return null;
  const entry = {
    sheetRowNumber: rowNum,
    date: getCol(row, 'Date'),
    desc: getCol(row, 'Description'),
    amt: parseFloat(getCol(row, 'Amount')) || 0,
    receiptImage: getCol(row, 'ReceiptImage'),
  };
  us.managementEditRow = entry;
  return entry;
}

async function buildAndSendManagementList(res, phone) {
  const data = await getCurrentMonthRows(true);
  if (!data || data.rows.length === 0) {
    sendTwiML(res, 'אין הוצאות רשומות לחודש הנוכחי. ✍️');
    return;
  }

  const items = [];
  const header = `📋 *ניהול הוצאות — ${HEB_MONTHS[data.curMonth]}*\nשלח מספר שורה לעריכה (תוקף 10 דק׳):\n`;

  for (let i = 0; i < data.rows.length; i++) {
    const r = data.rows[i];
    const displayIndex = i + 1;
    const rowNum = r.row ? r.row.rowNumber : null;
    items.push({
      displayIndex,
      sheetRowNumber: rowNum,
      date: r.date || '',
      desc: r.desc || '',
      amt: r.amt,
    });
  }

  const us = getUserState(phone);
  us.activeSelection = { items, ts: Date.now() };

  const s = getSession(phone);
  s.state = 'MANAGEMENT_SELECTING';
  s.ts = Date.now();

  const bodyLines = items.map(
    (it) => `${it.displayIndex}. ${it.date || '—'} | ${it.desc || '—'} | *${it.amt} ₪*`
  );
  const fullText = `${header}\n${bodyLines.join('\n')}`;

  if (fullText.length <= 1600) {
    sendTwiML(res, fullText);
    return;
  }

  const chunks = [];
  let buf = header.trim();
  for (const line of bodyLines) {
    if ((buf + '\n' + line).length > 1500) {
      chunks.push(buf);
      buf = `*(המשך)*\n${line}`;
    } else {
      buf += '\n' + line;
    }
  }
  if (buf) chunks.push(buf);
  sendTwiMLMulti(res, chunks);
}

function canUndo(phone) {
  const us = userState[phone];
  return us && us.lastRowIndex && us.lastRowTs && Date.now() - us.lastRowTs < UNDO_TTL_MS;
}

function confirmWithImageMsg(amount, desc, category) {
  return (
    `📸 רשמתי לי 🙂 *${amount} ₪* עבור *${desc}*.\n` +
    `זה נכנס תחת ${category}.\nקבלה צורפה ✅\n\nלביטול הרישום, השב *"מחק"*`
  );
}

function confirmTextFirstMsg(amount, desc, category) {
  return (
    `רשמתי לי 🙂 *${amount} ₪* עבור *${desc}*.\n` +
    `זה נכנס תחת ${category}.\n\n` +
    `האם יש לך קבלה להוסיף? (שלח תמונה או ענה כן / לא)`
  );
}

async function saveFullRow(phone, amount, desc, category, receipt, receiptImage) {
  const row = await appendExpenseRow(desc, amount, category, receipt, receiptImage);
  const rowIndex = row ? row.rowNumber : null;
  console.log(`[sheets] saved row ${rowIndex} for ${phone}`);
  const us = getUserState(phone);
  us.lastRowIndex = rowIndex;
  us.lastRowTs = Date.now();
  return rowIndex;
}

// ===================== Response Templates =====================

function buildCategoriesList() {
  const lines = ['📋 *רשימת הקטגוריות:*', ''];
  for (const { keywords, category } of CATEGORY_MAP) lines.push(`• ${category} — ${keywords.join(', ')}`);
  lines.push(`• ${DEFAULT_CATEGORY} — ברירת מחדל`);
  lines.push('');
  lines.push('שלח הוצאה עם מילת מפתח ואני אסווג אוטומטית!');
  return lines.join('\n');
}

function buildGreeting() {
  return (
    'היי! 👋 אני הבוט שלך לניהול החזרי הוצאות.\n\n' +
    '*רישום הוצאה:*\n' +
    '• שלח *סכום + תיאור* (למשל: *150 דלק*)\n' +
    '• שלח *תמונת קבלה* + כיתוב — ארשום עם הקבלה\n' +
    '• שלח *תמונה בלבד* — אשאל פרטים\n\n' +
    '*פקודות:*\n' +
    '• *"סיכום"* — דוח חודשי מלא\n' +
    '• *"סטטיסטיקה"* — ניתוח הוצאות\n' +
    '• *"קטגוריות"* — רשימת קטגוריות\n' +
    '• *"מחק"* — ביטול רישום אחרון (5 דק׳)\n' +
    '• *"ניהול"* / *"תיקון"* — רשימת הוצאות החודש לעריכה\n\n' +
    '*מעקב הגשה:*\n' +
    '• *"מה לא הוגש"* — הוצאות פתוחות\n' +
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
  console.log('[config] GOOGLE_DRIVE_FOLDER_ID:', GOOGLE_DRIVE_FOLDER_ID || '(not set — uploads to root)');
  console.log('[config] Google SA:', serviceAccountCreds ? 'loaded' : '(missing)');
  console.log('[config] Drive client:', getDriveClient() ? 'ready' : '(disabled)');
  console.log('[config] Twilio client:', twilioClient ? 'ready' : '(disabled)');
}
logConfigOnce();

// ===================== Routes =====================

const TWILIO_FROM_TEST = 'whatsapp:+15551234567';

app.post('/whatsapp', async (req, res) => {
  const bodyRaw = req.body.Body ?? '';
  const from = req.body.From || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  console.log('[whatsapp]', from, ':', bodyRaw || '(no Body)', numMedia > 0 ? `[${numMedia} media]` : '');

  const trimmed = String(bodyRaw).trim();
  const lower = trimmed.toLowerCase();
  const phone = from.replace('whatsapp:', '');
  const hasMedia = numMedia > 0;
  const session = getSession(phone);

  // ─── EXPIRY ───
  if (session.state !== 'IDLE' && isSessionExpired(session)) {
    if (session.state === 'AWAITING_RECEIPT_IMAGE' && session.receiptRowIndex) {
      try { await updateRowByIndex(session.receiptRowIndex, 'Receipt', 'No'); } catch (_) {}
    }
    if (MANAGEMENT_STATES.has(session.state)) clearManagement(phone);
    resetSession(phone);
  }

  const MGMT_OK = 'בוצע! עדכנתי את השורה בשיטס. ✨';

  // ─── FULL-MONTH MANAGEMENT & EDIT ───
  if (MANAGEMENT_STATES.has(session.state)) {
    const us = getUserState(phone);
    const touchMgmt = () => { session.ts = Date.now(); };

    if (matchesAny(lower, INTENT_MANAGEMENT) && !hasMedia) {
      try {
        await buildAndSendManagementList(res, phone);
      } catch (e) {
        console.error('[mgmt] list failed:', e.message);
        sendTwiML(res, 'לא הצלחתי לטעון את הרשימה, נסה שוב.');
      }
      return;
    }

    // Receipt image for selected row
    if (session.state === 'MANAGEMENT_AWAITING_RECEIPT_EDIT') {
      const rowNum = us.managementEditRow?.sheetRowNumber;
      if (!rowNum) { clearManagement(phone); resetSession(phone); sendTwiML(res, 'פג תוקף הניהול. שלח *ניהול* מחדש.'); return; }
      if (hasMedia) {
        const oldLink = us.managementEditRow?.receiptImage || '';
        const driveLink = await handleMediaUpload(req);
        if (oldLink) await deleteDriveFileByUrl(oldLink);
        await updateMultipleFieldsByIndex(rowNum, { Receipt: 'Yes', ReceiptImage: driveLink || oldLink });
        await refreshManagementEditSnapshot(phone);
        session.state = 'MANAGEMENT_EDIT_MENU';
        touchMgmt();
        sendTwiML(res, `${MGMT_OK}\n\n${editMenuPrompt(us.managementEditRow)}`);
        return;
      }
      if (lower === 'ביטול' || lower === 'בטל') {
        session.state = 'MANAGEMENT_EDIT_MENU';
        touchMgmt();
        sendTwiML(res, editMenuPrompt(us.managementEditRow));
        return;
      }
      sendTwiML(res, 'שלח *תמונת קבלה* 📸 או *ביטול* לחזרה לתפריט.');
      return;
    }

    if (session.state === 'MANAGEMENT_AWAITING_NEW_AMOUNT') {
      const rowNum = us.managementEditRow?.sheetRowNumber;
      if (!rowNum) { clearManagement(phone); resetSession(phone); sendTwiML(res, 'פג תוקף הניהול. שלח *ניהול* מחדש.'); return; }
      if (lower === 'ביטול' || lower === 'בטל') {
        session.state = 'MANAGEMENT_EDIT_MENU';
        touchMgmt();
        sendTwiML(res, editMenuPrompt(us.managementEditRow));
        return;
      }
      const mAmt = trimmed.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/);
      if (!mAmt) {
        sendTwiML(res, 'שלח *סכום מספרי* בלבד (למשל: *85.5*) או *ביטול*');
        return;
      }
      const newAmt = parseFloat(mAmt[1].replace(',', '.')) || 0;
      await updateRowByIndex(rowNum, 'Amount', newAmt);
      await refreshManagementEditSnapshot(phone);
      session.state = 'MANAGEMENT_EDIT_MENU';
      touchMgmt();
      sendTwiML(res, `${MGMT_OK}\n\n${editMenuPrompt(us.managementEditRow)}`);
      return;
    }

    if (session.state === 'MANAGEMENT_AWAITING_NEW_DESC') {
      const rowNum = us.managementEditRow?.sheetRowNumber;
      if (!rowNum) { clearManagement(phone); resetSession(phone); sendTwiML(res, 'פג תוקף הניהול. שלח *ניהול* מחדש.'); return; }
      if (lower === 'ביטול' || lower === 'בטל') {
        session.state = 'MANAGEMENT_EDIT_MENU';
        touchMgmt();
        sendTwiML(res, editMenuPrompt(us.managementEditRow));
        return;
      }
      const newDesc = sanitizeDescription(trimmed) || trimmed || '(ללא תיאור)';
      const cat = matchCategory(newDesc);
      await updateMultipleFieldsByIndex(rowNum, { Description: newDesc, Category: cat });
      await refreshManagementEditSnapshot(phone);
      session.state = 'MANAGEMENT_EDIT_MENU';
      touchMgmt();
      sendTwiML(res, `${MGMT_OK}\n\n${editMenuPrompt(us.managementEditRow)}`);
      return;
    }

    if (session.state === 'MANAGEMENT_EDIT_MENU') {
      const rowNum = us.managementEditRow?.sheetRowNumber;
      if (!rowNum) { clearManagement(phone); resetSession(phone); sendTwiML(res, 'פג תוקף הניהול. שלח *ניהול* מחדש.'); return; }

      if (hasMedia) {
        const oldLink = us.managementEditRow?.receiptImage || '';
        const driveLink = await handleMediaUpload(req);
        if (oldLink) await deleteDriveFileByUrl(oldLink);
        await updateMultipleFieldsByIndex(rowNum, { Receipt: 'Yes', ReceiptImage: driveLink || '' });
        await refreshManagementEditSnapshot(phone);
        touchMgmt();
        sendTwiML(res, `${MGMT_OK}\n\n${editMenuPrompt(us.managementEditRow)}`);
        return;
      }

      if (lower === 'ביטול' || lower === 'בטל') {
        session.state = 'MANAGEMENT_SELECTING';
        delete us.managementEditRow;
        touchMgmt();
        sendTwiML(res, 'חזרה לרשימה. שלח *מספר שורה* לעריכה או *ניהול* לרענון הרשימה.');
        return;
      }

      if (matchesAny(lower, ['מחק', 'מחיקה', 'תמחק']) && !matchesAny(lower, ['מחק שורה', 'מחק מהרשימה'])) {
        const oldLink = us.managementEditRow?.receiptImage || '';
        if (oldLink) await deleteDriveFileByUrl(oldLink);
        await deleteRowByIndex(rowNum);
        clearManagement(phone);
        resetSession(phone);
        sendTwiML(res, 'בוצע! השורה נמחקה מהשיטס. ✨\nשלח *ניהול* לרשימה מעודכנת.');
        return;
      }

      if (matchesAny(lower, ['סכום חדש', 'סכום', 'עדכן סכום', 'שינוי סכום'])) {
        session.state = 'MANAGEMENT_AWAITING_NEW_AMOUNT';
        touchMgmt();
        sendTwiML(res, `שלח את *הסכום החדש* ב-₪ (מספר בלבד). או *ביטול*`);
        return;
      }

      if (matchesAny(lower, ['תיאור חדש', 'תיאור', 'עדכן תיאור', 'שינוי תיאור'])) {
        session.state = 'MANAGEMENT_AWAITING_NEW_DESC';
        touchMgmt();
        sendTwiML(res, 'שלח את *התיאור החדש* כטקסט. או *ביטול*');
        return;
      }

      if (matchesAny(lower, ['שלח קבלה', 'קבלה', 'תמונת קבלה', 'צילום קבלה'])) {
        session.state = 'MANAGEMENT_AWAITING_RECEIPT_EDIT';
        touchMgmt();
        sendTwiML(res, 'שלח *תמונת קבלה* 📸 (הקובץ הישן ב-Drive יימחק אוטומטית)');
        return;
      }

      sendTwiML(res, `לא הבנתי 🤔\n${editMenuPrompt(us.managementEditRow)}`);
      return;
    }

    if (session.state === 'MANAGEMENT_SELECTING') {
      if (lower === 'ביטול' || lower === 'בטל') {
        clearManagement(phone);
        resetSession(phone);
        sendTwiML(res, 'יצאת ממצב ניהול.');
        return;
      }
      if (/^\d+$/.test(trimmed)) {
        const n = parseInt(trimmed, 10);
        const sel = us.activeSelection;
        if (!sel || !sel.items) {
          clearManagement(phone);
          resetSession(phone);
          sendTwiML(res, 'הרשימה פגה. שלח *ניהול* מחדש.');
          return;
        }
        const item = sel.items.find((x) => x.displayIndex === n);
        if (!item || !item.sheetRowNumber) {
          sendTwiML(res, `מספר *${n}* לא נמצא ברשימה. נסה שוב או שלח *ניהול* לרענון.`);
          return;
        }
        const row = await getRowByIndex(item.sheetRowNumber);
        if (!row) {
          sendTwiML(res, 'השורה לא נמצאה בגיליון. שלח *ניהול* מחדש.');
          return;
        }
        us.managementEditRow = {
          sheetRowNumber: item.sheetRowNumber,
          date: getCol(row, 'Date'),
          desc: getCol(row, 'Description'),
          amt: parseFloat(getCol(row, 'Amount')) || 0,
          receiptImage: getCol(row, 'ReceiptImage'),
        };
        session.state = 'MANAGEMENT_EDIT_MENU';
        touchMgmt();
        sendTwiML(res, editMenuPrompt(us.managementEditRow));
        return;
      }
      sendTwiML(res, 'שלח *מספר שורה* מהרשימה (למשל: *3*) או *ביטול*.');
      return;
    }
  }

  // ─── MANAGEMENT LIST INTENT (רק מ-IDLE או מתוך מצבי ניהול — לא באמצע רישום הוצאה) ───
  const canOpenManagement =
    session.state === 'IDLE' || MANAGEMENT_STATES.has(session.state);
  if (matchesAny(lower, INTENT_MANAGEMENT) && !hasMedia && canOpenManagement) {
    try {
      await buildAndSendManagementList(res, phone);
    } catch (e) {
      console.error('[mgmt] list failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לטעון את הרשימה, נסה שוב.');
    }
    return;
  }

  // ─── AWAITING_RECEIPT_IMAGE: image sent → update Col E + H ───
  if (session.state === 'AWAITING_RECEIPT_IMAGE') {
    const rowIdx = session.receiptRowIndex;
    if (hasMedia) {
      const driveLink = await handleMediaUpload(req);
      if (rowIdx) {
        const updates = { Receipt: 'Yes' };
        if (driveLink) updates.ReceiptImage = driveLink;
        await updateMultipleFieldsByIndex(rowIdx, updates);
      }
      resetSession(phone);
      sendTwiML(res, `📸 קבלה צורפה בהצלחה!${driveLink ? '' : ' (העלאה ל-Drive נכשלה, אך הקבלה סומנה)'}\nלביטול הרישום, השב *"מחק"*`);
      return;
    }
    if (lower === 'כן' || lower === 'yes') {
      if (rowIdx) await updateRowByIndex(rowIdx, 'Receipt', 'Yes');
      resetSession(phone);
      sendTwiML(res, '✅ מעולה, קבלה מאושרת!\nלביטול הרישום, השב *"מחק"*');
      return;
    }
    if (lower === 'לא' || lower === 'no') {
      if (rowIdx) await updateRowByIndex(rowIdx, 'Receipt', 'No');
      resetSession(phone);
      sendTwiML(res, '📌 תזכורת: נסה לשמור את הקבלה לצורך ההחזר.\nלביטול הרישום, השב *"מחק"*');
      return;
    }
    if (rowIdx) await updateRowByIndex(rowIdx, 'Receipt', 'No');
    resetSession(phone);
  }

  // ─── AWAITING_EXPENSE_DETAILS: image-first, now expecting text ───
  if (session.state === 'AWAITING_EXPENSE_DETAILS') {
    const pendingDriveLink = session.pendingDriveLink || '';
    const { amount, description } = parseExpenseMessage(trimmed);
    if (amount) {
      const desc = description || '(ללא תיאור)';
      const category = matchCategory(desc);
      resetSession(phone);

      if (amount > HIGH_AMOUNT_THRESHOLD) {
        const s = getSession(phone);
        s.state = 'AWAITING_HIGH_CONFIRM';
        s.pendingAmount = amount;
        s.pendingDesc = desc;
        s.pendingCategory = category;
        s.pendingDriveLink = pendingDriveLink;
        s.ts = Date.now();
        sendTwiML(res, `זה סכום גבוה מהרגיל (*${amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`);
        return;
      }

      try {
        await saveFullRow(phone, amount, desc, category, 'Yes', pendingDriveLink);
        sendTwiML(res, confirmWithImageMsg(amount, desc, category));
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }
    sendTwiML(res, 'לא זיהיתי סכום. שלח *סכום + תיאור* (למשל: *50 חניה*)');
    return;
  }

  // ─── SCENARIO A: Image + Caption with expense data ───
  if (hasMedia) {
    const { amount, description } = parseExpenseMessage(trimmed);

    if (amount) {
      const desc = description || '(ללא תיאור)';
      const category = matchCategory(desc);
      const driveLink = await handleMediaUpload(req);

      if (amount > HIGH_AMOUNT_THRESHOLD) {
        const s = getSession(phone);
        s.state = 'AWAITING_HIGH_CONFIRM';
        s.pendingAmount = amount;
        s.pendingDesc = desc;
        s.pendingCategory = category;
        s.pendingDriveLink = driveLink || '';
        s.ts = Date.now();
        sendTwiML(res, `זה סכום גבוה מהרגיל (*${amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`);
        return;
      }

      try {
        await saveFullRow(phone, amount, desc, category, 'Yes', driveLink || '');
        sendTwiML(res, confirmWithImageMsg(amount, desc, category));
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }

    // ─── SCENARIO B: Image without expense text ───
    const driveLink = await handleMediaUpload(req);
    const s = getSession(phone);
    s.state = 'AWAITING_EXPENSE_DETAILS';
    s.pendingDriveLink = driveLink || '';
    s.ts = Date.now();
    sendTwiML(res, 'קיבלתי את הקבלה! 📸\nעבור מה ההוצאה וכמה היא עלתה? (למשל: *50 חניה*)');
    return;
  }

  // ─── UNDO (לא במצב ניהול חודשי) ───
  if (matchesAny(lower, INTENT_UNDO) && !MANAGEMENT_STATES.has(session.state)) {
    if (canUndo(phone)) {
      const us = getUserState(phone);
      const ok = await deleteRowByIndex(us.lastRowIndex);
      us.lastRowIndex = null;
      us.lastRowTs = null;
      sendTwiML(res, ok ? '✓ הרישום האחרון בוטל בהצלחה.' : 'לא הצלחתי למחוק, נסה שוב.');
    } else {
      sendTwiML(res, 'אין רישום אחרון לביטול (או שעבר יותר מ-5 דקות).');
    }
    return;
  }

  // ─── SUMMARY ───
  if (matchesAny(lower, INTENT_SUMMARY)) {
    try {
      const txt = await buildMonthlySummary();
      sendTwiML(res, txt || `סה״כ הוצאות: ${await sumAmountColumn()} ₪`);
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לשלוף סיכום, נסה שוב');
    }
    return;
  }

  // ─── STATS ───
  if (matchesAny(lower, INTENT_STATS)) {
    try {
      sendTwiML(res, (await buildMonthlyStats()) || 'לא הצלחתי לשלוף נתונים, נסה שוב');
    } catch (e) {
      console.error('[sheets] stats failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לשלוף נתונים, נסה שוב');
    }
    return;
  }

  // ─── NOT SUBMITTED ───
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
        lines.push('', 'שלח *"הגשתי"* כדי לסמן הכל כהוגש.');
        sendTwiML(res, lines.join('\n'));
      }
    } catch (e) {
      console.error('[sheets] unsubmitted failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לשלוף נתונים, נסה שוב');
    }
    return;
  }

  // ─── MARK SUBMITTED ───
  if (matchesAny(lower, INTENT_MARK_SUBMITTED)) {
    try {
      const count = await markAllCurrentMonthSubmitted();
      sendTwiML(res, count === 0
        ? '✅ כל ההוצאות כבר מסומנות כהוגשו!'
        : `מעולה! *${count}* הוצאות החודש סומנו כהוגשו. 💰`);
    } catch (e) {
      console.error('[sheets] mark submitted failed:', e.message);
      sendTwiML(res, 'שגיאה בעדכון, נסה שוב');
    }
    return;
  }

  // ─── CATEGORIES ───
  if (matchesAny(lower, INTENT_CATEGORIES)) { sendTwiML(res, buildCategoriesList()); return; }

  // ─── BUDGET ───
  if (matchesAny(lower, INTENT_BUDGET)) {
    try {
      const data = await getCurrentMonthRows(false);
      if (data && data.rows.length > 0) {
        const total = data.rows.reduce((s, r) => s + r.amt, 0);
        sendTwiML(res, `📈 סה"כ הוצאות החודש: *${total} ₪*\n(${data.rows.length} רישומים)\n\nשלח *"סיכום"* לדוח מלא`);
      } else {
        sendTwiML(res, 'עדיין אין הוצאות החודש. רשום הוצאה ונסה שוב!');
      }
    } catch (e) {
      sendTwiML(res, 'לא הצלחתי לשלוף נתונים, נסה שוב');
    }
    return;
  }

  // ─── GREETING ───
  if (matchesAny(lower, INTENT_GREETING) && !lower.match(/\d/)) { sendTwiML(res, buildGreeting()); return; }

  // ─── POLITENESS ───
  if (matchesAny(lower, INTENT_POLITENESS)) {
    sendTwiML(res, 'בשמחה! 😊 תכתוב *"סיכום"* כדי לראות את המצב החודשי.');
    return;
  }

  // ─── SESSION STATES ───

  if (getSession(phone).state === 'AWAITING_DAILY_REPLY') {
    resetSession(phone);
    if (matchesAny(lower, INTENT_CONFIRM_YES)) { sendTwiML(res, 'מעולה! שלח לי את ההוצאות ואני ארשום 📝'); return; }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) { sendTwiML(res, 'יופי, ערב טוב! 🌙'); return; }
  }

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
      try {
        const rowIdx = await saveFullRow(phone, pendingAmount, desc, category, 'No', '');
        const ns = getSession(phone);
        ns.state = 'AWAITING_RECEIPT_IMAGE';
        ns.receiptRowIndex = rowIdx;
        ns.ts = Date.now();
        sendTwiML(res, confirmTextFirstMsg(pendingAmount, desc, category));
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }
  }

  if (getSession(phone).state === 'AWAITING_AMOUNT') {
    const s = getSession(phone);
    const parsed = parseExpenseMessage(trimmed);
    if (parsed.amount) {
      const { pendingDesc, pendingCategory } = s;
      resetSession(phone);
      try {
        const rowIdx = await saveFullRow(phone, parsed.amount, pendingDesc, pendingCategory, 'No', '');
        const ns = getSession(phone);
        ns.state = 'AWAITING_RECEIPT_IMAGE';
        ns.receiptRowIndex = rowIdx;
        ns.ts = Date.now();
        sendTwiML(res, confirmTextFirstMsg(parsed.amount, pendingDesc, pendingCategory));
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }
    resetSession(phone);
    sendTwiML(res, 'לא הצלחתי לזהות סכום. נסה שוב עם מספר (למשל: *50*)');
    return;
  }

  if (getSession(phone).state === 'AWAITING_HIGH_CONFIRM') {
    const s = getSession(phone);
    const { pendingAmount, pendingDesc, pendingCategory, pendingDriveLink } = s;
    resetSession(phone);
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      try {
        const hasImage = !!pendingDriveLink;
        const receipt = hasImage ? 'Yes' : 'No';
        const rowIdx = await saveFullRow(phone, pendingAmount, pendingDesc, pendingCategory, receipt, pendingDriveLink || '');
        if (hasImage) {
          sendTwiML(res, confirmWithImageMsg(pendingAmount, pendingDesc, pendingCategory));
        } else {
          const ns = getSession(phone);
          ns.state = 'AWAITING_RECEIPT_IMAGE';
          ns.receiptRowIndex = rowIdx;
          ns.ts = Date.now();
          sendTwiML(res, confirmTextFirstMsg(pendingAmount, pendingDesc, pendingCategory));
        }
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

  // ─── SCENARIO C: NORMAL TEXT EXPENSE ───
  const { amount, description } = parseExpenseMessage(trimmed);

  if (amount && description) {
    const category = matchCategory(description);
    if (amount > HIGH_AMOUNT_THRESHOLD) {
      const s = getSession(phone);
      s.state = 'AWAITING_HIGH_CONFIRM';
      s.pendingAmount = amount;
      s.pendingDesc = description;
      s.pendingCategory = category;
      s.pendingDriveLink = '';
      s.ts = Date.now();
      sendTwiML(res, `זה סכום גבוה מהרגיל (*${amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`);
      return;
    }
    try {
      const rowIdx = await saveFullRow(phone, amount, description, category, 'No', '');
      const s = getSession(phone);
      s.state = 'AWAITING_RECEIPT_IMAGE';
      s.receiptRowIndex = rowIdx;
      s.ts = Date.now();
      sendTwiML(res, confirmTextFirstMsg(amount, description, category));
    } catch (e) {
      console.error('[sheets] append failed:', e.message);
      sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
    }
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

  sendTwiML(res, 'לא הבנתי 🤔\nשלח *סכום + תיאור* (למשל: *150 דלק*)\nאו שלח *תמונת קבלה* 📸\nאו שלח *"שלום"* לרשימת הפקודות.');
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
  cron.schedule('0 20 * * *', async () => {
    const phone = TO_WHATSAPP_NUMBER.replace('whatsapp:', '');
    const s = getSession(phone);
    s.state = 'AWAITING_DAILY_REPLY';
    s.ts = Date.now();
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, 'היי! 👋 היו לך הוצאות היום? (כן / לא)');
  }, { timezone: CRON_TZ });

  cron.schedule('0 10 * * 0', async () => {
    try {
      const missing = await getMissingReceiptRows();
      if (missing.length === 0) return;
      const lines = [`היי, רשמת *${missing.length}* הוצאות ללא אישור קבלה. הכל שמור? 📑`, ''];
      for (const r of missing.slice(0, 10)) lines.push(`• ${r.desc} — *${r.amt} ₪*`);
      if (missing.length > 10) lines.push(`...ועוד ${missing.length - 10}`);
      await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, lines.join('\n'));
    } catch (e) { console.error('[cron] Missing receipts failed:', e.message); }
  }, { timezone: CRON_TZ });

  cron.schedule('0 20 25 * *', async () => {
    try {
      const open = await getUnsubmittedRows();
      if (open.length === 0) return;
      const total = open.reduce((s, r) => s + r.amt, 0);
      await sendWhatsAppMessage(TO_WHATSAPP_NUMBER,
        `🚨 יום הגשת החזרים מתקרב!\nיש לך *${open.length}* הוצאות פתוחות בסך *${total} ₪* שטרם הוגשו.\nכדאי לסיים עם זה!\n\nשלח *"הגשתי"* לסמן הכל.`);
    } catch (e) { console.error('[cron] Deadline alert failed:', e.message); }
  }, { timezone: CRON_TZ });

  cron.schedule('0 20 29 * *', async () => {
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, 'תזכורת חודשית 📋 הגיע הזמן להגיש דוחות!\nשלח *"סיכום"* לקבלת סה״כ ההוצאות.');
  }, { timezone: CRON_TZ });

  console.log(`[cron] Scheduled: daily 20:00, Sundays 10:00, 25th 20:00, 29th 20:00 (${CRON_TZ})`);
} else {
  console.log('[cron] Disabled — set TO_WHATSAPP_NUMBER + Twilio creds.');
}

// ===================== Server =====================

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

function runLocalUnitChecks() {
  console.log('\n=== [smoke] Unit tests ===');
  const t = (label, ok) => console.log(`  ${label}: ${ok ? '✓' : '✗'}`);
  const a = parseExpenseMessage('150 דלק');
  t('parse "150 דלק"', a.amount === 150 && a.description === 'דלק');
  const b = parseExpenseMessage('הוצאתי 50 שקל על דלק');
  t('parse sanitize', b.amount === 50 && b.description === 'דלק');
  t('category "בחנייה"', matchCategory('בחנייה') === 'החזרי חנייה 🅿️');
  t('category "למונית"', matchCategory('למונית') === 'החזרי מוניות 🚕');
  t('intent "הסיכום"', matchesAny('הסיכום', INTENT_SUMMARY));
  t('intent "מה לא הוגש"', matchesAny('מה לא הוגש', INTENT_NOT_SUBMITTED));
  t('intent "הגשתי"', matchesAny('הגשתי', INTENT_MARK_SUBMITTED));
  t('intent "ניהול"', matchesAny('ניהול', INTENT_MANAGEMENT));
  t('intent "מחק שורה"', matchesAny('מחק שורה', INTENT_MANAGEMENT));
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
  console.log('\n=== [smoke] HTTP tests ===');
  const F = TWILIO_FROM_TEST;
  const strip = (b) => b.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 140);

  const cases = [
    { name: 'greeting', fields: { Body: 'שלום', From: F } },
    { name: '150 דלק → save', fields: { Body: '150 דלק', From: F } },
    { name: 'כן → receipt', fields: { Body: 'כן', From: F } },
    { name: 'תרופות 80 → save', fields: { Body: 'תרופות 80', From: F } },
    { name: 'לא → no receipt', fields: { Body: 'לא', From: F } },
    { name: 'מחק → undo', fields: { Body: 'מחק', From: F } },
    { name: '42 → ask desc', fields: { Body: '42', From: F } },
    { name: 'חניה → complete', fields: { Body: 'חניה', From: F } },
    { name: 'כן → receipt', fields: { Body: 'כן', From: F } },
    { name: 'img-only → ask details', fields: { Body: '', From: F, NumMedia: '1', MediaUrl0: 'https://example.com/img.jpg', MediaContentType0: 'image/jpeg' } },
    { name: '55 מונית → complete img', fields: { Body: '55 מונית', From: F } },
    { name: '3000 דלק → high', fields: { Body: '3000 דלק', From: F } },
    { name: 'כן → confirm', fields: { Body: 'כן', From: F } },
    { name: 'לא → no receipt', fields: { Body: 'לא', From: F } },
    { name: 'מה לא הוגש', fields: { Body: 'מה לא הוגש', From: F } },
    { name: 'הגשתי', fields: { Body: 'הגשתי', From: F } },
    { name: 'סיכום', fields: { Body: 'סיכום', From: F } },
    { name: 'ניהול → list', fields: { Body: 'ניהול', From: F } },
    { name: 'mgmt ביטול', fields: { Body: 'ביטול', From: F } },
    { name: '$50 → currency', fields: { Body: '$50 דלק', From: F } },
  ];

  for (const t of cases) {
    try {
      const { status, body } = await postForm(port, t.path || '/whatsapp', t.fields);
      console.log(`  [${t.name}] ${status} → ${strip(body)}`);
    } catch (e) { console.error(`  [${t.name}] ERR:`, e.message); }
  }
  console.log('\n=== [smoke] Done ===\n');
}

if (process.env.SMOKE_TEST === '1') {
  runLocalUnitChecks();
  const server = app.listen(PORT, async () => {
    console.log(`[smoke] Temp server on ${PORT}`);
    try { await runHttpSmokeTests(PORT); }
    finally { server.close(() => process.exit(0)); }
  });
} else {
  app.listen(PORT, () => {
    console.log(`Listening on ${PORT}`);
    console.log('Webhooks: POST /whatsapp  |  POST /webhook');
  });
}
