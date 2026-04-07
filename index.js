/**
 * בוט WhatsApp (Twilio Sandbox) + שמירה ב-Google Sheets.
 * ב-Render: העלה Secret File בשם Expense-Tracker-Bot.json (ליד index.js) — נטען עם require.
 * מקומית: אם אין קובץ, אפשר GOOGLE_SERVICE_ACCOUNT_JSON.
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
  for (const { keywords, category } of CATEGORY_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return DEFAULT_CATEGORY;
}

// ===================== Message Parsing =====================

/**
 * מפרק הודעה לסכום ותיאור.
 * "150 דלק" → { amount: 150, description: "דלק" }
 * "קפה 25"  → { amount: 25,  description: "קפה" }
 * "שלום"    → { amount: 0,   description: "שלום" }
 */
function parseExpenseMessage(text) {
  if (!text || typeof text !== 'string') return { amount: 0, description: '' };
  const trimmed = text.trim();
  const m = trimmed.match(/\d+(?:[.,]\d+)?/);
  if (!m) return { amount: 0, description: trimmed };
  const amount = parseFloat(m[0].replace(',', '.')) || 0;
  const description = trimmed.replace(m[0], '').replace(/\s+/g, ' ').trim();
  return { amount, description };
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

const SHEET_HEADERS = ['Date', 'Description', 'Amount', 'Category'];

async function appendExpenseRow(description, amount, category) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return;
  const sheet = doc.sheetsByIndex[0];
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const hasHeaders =
    headers.length >= 4 &&
    headers[0] === 'Date' &&
    headers[1] === 'Description' &&
    headers[2] === 'Amount' &&
    headers[3] === 'Category';
  if (!hasHeaders && headers.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(SHEET_HEADERS);
  }
  await sheet.addRow({
    Date: new Date().toISOString(),
    Description: description,
    Amount: amount,
    Category: category,
  });
}

async function saveToSheet(description, amount, category) {
  await appendExpenseRow(
    description,
    parseFloat(amount) || 0,
    category || DEFAULT_CATEGORY
  );
}

async function sumAmountColumn() {
  const doc = await getSpreadsheetDoc();
  if (!doc) return 0;
  const sheet = doc.sheetsByIndex[0];
  await sheet.loadHeaderRow(1);
  const rows = await sheet.getRows();
  let total = 0;
  for (const row of rows) {
    const raw =
      typeof row.get === 'function' ? row.get('Amount') : row.Amount;
    const n = parseFloat(raw);
    if (!Number.isNaN(n)) total += n;
  }
  return total;
}

const HEB_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const SUMMARY_FOOTERS = [
  'אל תשכח לשמור את הקבלות המקוריות! 📑',
  'הכסף הזה חוזר אליך! 💸',
  'שמור על הסדר — זה משתלם! 🗂️',
];

/**
 * בונה סיכום חודשי מעוצב עם WhatsApp markdown.
 * מסנן רק שורות מהחודש הנוכחי, מקבץ לפי קטגוריה.
 */
async function buildMonthlySummary() {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await sheet.loadHeaderRow(1);
  const rows = await sheet.getRows();

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();
  const monthName = HEB_MONTHS[curMonth];

  const categoryTotals = new Map();
  const categoryItems = new Map();

  for (const row of rows) {
    const dateStr =
      typeof row.get === 'function' ? row.get('Date') : row.Date;
    const d = new Date(dateStr);
    if (d.getFullYear() !== curYear || d.getMonth() !== curMonth) continue;

    const amt = parseFloat(
      typeof row.get === 'function' ? row.get('Amount') : row.Amount
    );
    if (Number.isNaN(amt) || amt === 0) continue;

    const cat =
      (typeof row.get === 'function' ? row.get('Category') : row.Category) ||
      DEFAULT_CATEGORY;
    const desc =
      (typeof row.get === 'function'
        ? row.get('Description')
        : row.Description) || '';

    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + amt);
    if (!categoryItems.has(cat)) categoryItems.set(cat, []);
    categoryItems.get(cat).push({ desc, amt });
  }

  if (categoryTotals.size === 0) {
    return 'עדיין אין הוצאות רשומות לחודש זה. רוצה לרשום משהו עכשיו? ✍️';
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
  lines.push('');
  lines.push(SUMMARY_FOOTERS[Math.floor(Math.random() * SUMMARY_FOOTERS.length)]);

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

// ===================== Conversation State =====================

const pendingDailyPrompt = new Map();
const DAILY_PROMPT_TTL_MS = 4 * 60 * 60 * 1000;

function setDailyPrompt(phone) {
  pendingDailyPrompt.set(phone, Date.now());
}

function consumeDailyPrompt(phone) {
  const ts = pendingDailyPrompt.get(phone);
  if (!ts) return false;
  pendingDailyPrompt.delete(phone);
  return Date.now() - ts < DAILY_PROMPT_TTL_MS;
}

// ===================== Config Log =====================

function logConfigOnce() {
  console.log(
    '[config] TWILIO_ACCOUNT_SID:',
    TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}…` : '(missing)'
  );
  console.log('[config] TWILIO_AUTH_TOKEN:', TWILIO_AUTH_TOKEN ? '(set)' : '(missing)');
  console.log('[config] FROM_WHATSAPP_NUMBER:', FROM_WHATSAPP_NUMBER || '(missing)');
  console.log('[config] TO_WHATSAPP_NUMBER:', TO_WHATSAPP_NUMBER || '(missing)');
  console.log('[config] GOOGLE_SHEET_ID:', GOOGLE_SHEET_ID || '(missing)');
  const localCredsPath = path.join(__dirname, 'Expense-Tracker-Bot.json');
  const credsSource = serviceAccountCreds
    ? fs.existsSync(localCredsPath)
      ? 'Expense-Tracker-Bot.json (Secret File / local)'
      : 'GOOGLE_SERVICE_ACCOUNT_JSON (env)'
    : '(missing — add Expense-Tracker-Bot.json Secret File or env)';
  console.log('[config] Google Service Account:', credsSource);
  console.log('[config] Twilio client:', twilioClient ? 'ready' : '(disabled — missing SID/token)');
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

  // --- Daily prompt reply (כן / לא) ---
  const senderPhone = from.replace('whatsapp:', '');
  if (consumeDailyPrompt(senderPhone)) {
    if (['כן', 'yes', 'כ'].includes(lower)) {
      sendTwiML(res, 'מעולה! שלח לי את ההוצאות ואני ארשום 📝');
      return;
    }
    if (['לא', 'no', 'ל'].includes(lower)) {
      sendTwiML(res, 'יופי, ערב טוב! 🌙');
      return;
    }
  }

  // --- Summary ---
  if (lower === 'summary' || lower === 'סיכום') {
    let responseText;
    try {
      responseText = await buildMonthlySummary();
      if (!responseText) {
        responseText = `סה״כ הוצאות: ${await sumAmountColumn()}₪`;
      }
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
      responseText = 'לא הצלחתי לשלוף סיכום, נסה שוב';
    }
    sendTwiML(res, responseText);
    return;
  }

  // --- Parse expense ---
  const { amount, description } = parseExpenseMessage(trimmed);

  if (!amount) {
    sendTwiML(
      res,
      'כדי לרשום הוצאה, שלח מספר + תיאור.\nלדוגמה: 150 דלק\nאו: תספורת 50'
    );
    return;
  }

  const desc = description || '(ללא תיאור)';
  const category = matchCategory(description);

  try {
    await appendExpenseRow(desc, amount, category);
  } catch (e) {
    console.error('[sheets] append failed:', e.message);
    sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
    return;
  }

  sendTwiML(res, `רשמתי לי 🙂 ${amount} ש"ח עבור ${desc}. זה נכנס תחת ${category}.`);
});

/**
 * Webhook חלופי — אם יש ספרות בהודעה → "שמרתי …₪" + שורה ב-Sheets;
 * אחרת → "קיבלתי ממך: …".
 */
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.Body || '';
    const { amount, description } = parseExpenseMessage(message);

    if (amount) {
      const desc = description || '(ללא תיאור)';
      const category = matchCategory(description);
      try {
        await saveToSheet(desc, amount, category);
      } catch (e) {
        console.error('[webhook] sheets:', e.message);
      }
      sendTwiML(res, `רשמתי לי 🙂 ${amount} ש"ח עבור ${desc}. זה נכנס תחת ${category}.`);
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
  // יומי 20:00 — שאל אם היו הוצאות היום
  cron.schedule(
    '0 20 * * *',
    async () => {
      console.log('[cron] Daily expense prompt');
      setDailyPrompt(TO_WHATSAPP_NUMBER.replace('whatsapp:', ''));
      await sendWhatsAppMessage(
        TO_WHATSAPP_NUMBER,
        'היי! 👋 היו לך הוצאות היום? (כן / לא)'
      );
    },
    { timezone: CRON_TZ }
  );

  // חודשי — 29 בחודש ב-20:00 — תזכורת דוחות
  cron.schedule(
    '0 20 29 * *',
    async () => {
      console.log('[cron] Monthly report reminder');
      await sendWhatsAppMessage(
        TO_WHATSAPP_NUMBER,
        'תזכורת חודשית 📋 הגיע הזמן להגיש דוחות!\nשלח "סיכום" לקבלת סה״כ ההוצאות.'
      );
    },
    { timezone: CRON_TZ }
  );

  console.log(`[cron] Scheduled: daily 20:00 + monthly 29th 20:00 (${CRON_TZ})`);
} else {
  console.log(
    '[cron] Disabled — set TO_WHATSAPP_NUMBER + Twilio credentials to enable.'
  );
}

// ===================== Server =====================

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

// --- Smoke tests (SMOKE_TEST=1) ---
function runLocalUnitChecks() {
  console.log('\n=== [smoke] בדיקות יחידה ===');
  const a = parseExpenseMessage('hello');
  const b = parseExpenseMessage('150 דלק');
  const c = parseExpenseMessage('קפה 12,30');
  const d = parseExpenseMessage('42.5');
  console.log('  parse("hello") →', JSON.stringify(a), a.amount === 0 ? '✓' : '✗');
  console.log('  parse("150 דלק") →', JSON.stringify(b), b.amount === 150 && b.description === 'דלק' ? '✓' : '✗');
  console.log('  parse("קפה 12,30") →', JSON.stringify(c), c.amount === 12.3 && c.description === 'קפה' ? '✓' : '✗');
  console.log('  parse("42.5") →', JSON.stringify(d), d.amount === 42.5 && d.description === '' ? '✓' : '✗');

  console.log('\n=== [smoke] קטגוריות ===');
  const cats = [
    ['פסיכולוג', 'החזרי פסיכולוג 🧘'],
    ['תרופות מרקחת', 'החזרי בריאות 🩺'],
    ['חנייה בעיר', 'החזרי חנייה 🅿️'],
    ['אוטובוס', 'החזרי נסיעות תחבורה ציבורית 🚏'],
    ['תספורת', 'החזרי תספורת וקוסמטיקה 💇'],
    ['חוג ילדים', 'החזרי ילדים 👶'],
    ['סלולר', 'החזרי טלפון 📱'],
    ['אגרה', 'החזרי תשלומים ממשלתיים 👩‍⚖️'],
    ['נעליים', 'החזרי ביגוד לעובדי חוץ 👕'],
    ['ועד בית', 'החזרי בניין 🏡'],
    ['מונית', 'החזרי מוניות 🚕'],
    ['קפה', 'החזרי הוצאות שונות 🧑‍💻'],
  ];
  for (const [desc, expected] of cats) {
    const got = matchCategory(desc);
    console.log(`  category("${desc}") → ${got}`, got === expected ? '✓' : `✗ (expected: ${expected})`);
  }
}

function postForm(port, urlPath, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (ch) => {
          data += ch;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runHttpSmokeTests(port) {
  console.log('\n=== [smoke] בדיקות HTTP ===');
  const cases = [
    { name: 'ללא מספר', path: '/whatsapp', fields: { Body: 'שלום', From: TWILIO_FROM_TEST } },
    { name: '150 דלק', path: '/whatsapp', fields: { Body: '150 דלק', From: TWILIO_FROM_TEST } },
    { name: 'תרופות 80', path: '/whatsapp', fields: { Body: 'תרופות 80', From: TWILIO_FROM_TEST } },
    { name: 'מונית 45', path: '/whatsapp', fields: { Body: 'מונית 45', From: TWILIO_FROM_TEST } },
    { name: 'summary', path: '/whatsapp', fields: { Body: 'summary', From: TWILIO_FROM_TEST } },
    { name: 'סיכום', path: '/whatsapp', fields: { Body: 'סיכום', From: TWILIO_FROM_TEST } },
    { name: 'webhook 200', path: '/webhook', fields: { Body: '200 חנייה', From: TWILIO_FROM_TEST } },
  ];

  for (const t of cases) {
    try {
      const { status, body } = await postForm(port, t.path, t.fields);
      const preview = body.replace(/\s+/g, ' ').slice(0, 200);
      console.log(`  [${t.name}] HTTP ${status}`);
      console.log(`    ${preview}${body.length > 200 ? '…' : ''}`);
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
    try {
      await runHttpSmokeTests(PORT);
    } finally {
      server.close(() => {
        process.exit(0);
      });
    }
  });
} else {
  app.listen(PORT, () => {
    console.log(`Listening on ${PORT}`);
    console.log('Webhooks: POST /whatsapp  |  POST /webhook');
  });
}
