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

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Twilio: נקראים מ-process.env (Render / .env מקומי) ---
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const FROM_WHATSAPP_NUMBER = (process.env.FROM_WHATSAPP_NUMBER || '').trim();

// --- Google: מזהה גיליון מ-GOOGLE_SHEET_ID או ברירת מחדל ---
// מזהה הגיליון (מקטע ה-URL /d/<ID>/edit): 1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48
const GOOGLE_SHEET_ID = (
  process.env.GOOGLE_SHEET_ID || '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48'
).trim();

/**
 * טוען Service Account: Secret File ב-Render (או קובץ מקומי) —
 * const creds = require('./Expense-Tracker-Bot.json');
 * אם הקובץ לא קיים — נסיון דרך GOOGLE_SERVICE_ACCOUNT_JSON (פיתוח / גיבוי).
 */
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

const REPLY = '🔥 הקוד החדש עובד 🔥';

// --- Google Sheets: לקוח API נוצר פעם אחת (singleton) ---
let sheetsClientPromise = null;

function getSpreadsheetDoc() {
  if (!GOOGLE_SHEET_ID || !serviceAccountCreds) {
    return null;
  }
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const serviceAccountAuth = new JWT({
        email: serviceAccountCreds.client_email,
        key: serviceAccountCreds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      // חובה פרמטר שני (JWT) — גישה לגיליון פרטי דרך Google Sheets API
      const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
      await doc.loadInfo();
      return doc;
    })();
  }
  return sheetsClientPromise;
}

/** חילוץ המספר הראשון בהודעה לעמודת Amount (אם אין מספר → 0) */
function firstNumberInMessage(text) {
  if (!text || typeof text !== 'string') return 0;
  const m = text.match(/\d+(?:[.,]\d+)?/);
  if (!m) return 0;
  return parseFloat(m[0].replace(',', '.')) || 0;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** תשובת Twilio ב-TwiML — Content-Type text/xml */
function sendTwiML(res, messageText) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
      messageText
    )}</Message></Response>`
  );
}

/**
 * שמירת שורה בגיליון הראשון: עמודות Date, Message, Amount.
 * אם הגיליון ריק — נוצרת שורת כותרות מתאימה.
 */
async function appendMessageRow(messageBody, amount) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return;
  const sheet = doc.sheetsByIndex[0];
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const hasHeaders =
    headers.length >= 3 &&
    headers[0] === 'Date' &&
    headers[1] === 'Message' &&
    headers[2] === 'Amount';
  if (!hasHeaders && headers.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(['Date', 'Message', 'Amount']);
  }
  await sheet.addRow({
    Date: new Date().toISOString(),
    Message: messageBody,
    Amount: amount,
  });
}

/** סכום כל הערכים בעמודת Amount (לפקודת summary) */
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

function logTwilioEnvOnce() {
  console.log(
    '[config] TWILIO_ACCOUNT_SID:',
    TWILIO_ACCOUNT_SID
      ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}…`
      : '(missing)'
  );
  console.log(
    '[config] TWILIO_AUTH_TOKEN:',
    TWILIO_AUTH_TOKEN ? '(set)' : '(missing)'
  );
  console.log(
    '[config] FROM_WHATSAPP_NUMBER:',
    FROM_WHATSAPP_NUMBER || '(missing)'
  );
  console.log('[config] GOOGLE_SHEET_ID:', GOOGLE_SHEET_ID || '(missing)');
  const localCredsPath = path.join(__dirname, 'Expense-Tracker-Bot.json');
  const credsSource = serviceAccountCreds
    ? fs.existsSync(localCredsPath)
      ? 'Expense-Tracker-Bot.json (Secret File / local)'
      : 'GOOGLE_SERVICE_ACCOUNT_JSON (env)'
    : '(missing — add Expense-Tracker-Bot.json Secret File or env)';
  console.log('[config] Google Service Account:', credsSource);
}
logTwilioEnvOnce();

const TWILIO_FROM_TEST = 'whatsapp:+15551234567';

app.post('/whatsapp', async (req, res) => {
  const bodyRaw = req.body.Body ?? '';
  console.log(bodyRaw || '(no Body)');

  const trimmed = String(bodyRaw).trim();
  const amount = firstNumberInMessage(trimmed);
  const isSummary = trimmed.toLowerCase() === 'summary';

  try {
    await appendMessageRow(trimmed, amount);
  } catch (e) {
    console.error('[sheets] append failed:', e.message);
  }

  let responseText = REPLY;
  if (isSummary) {
    try {
      responseText = `סה״כ: ${await sumAmountColumn()}`;
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
    }
  }

  sendTwiML(res, responseText);
});

/**
 * Webhook חלופי — לוגיקה פשוטה: אם יש ספרות בהודעה → "שמרתי …₪" + שורה ב-Sheets;
 * אחרת → "קיבלתי ממך: …".
 * ב-Twilio הגדר URL: POST …/webhook (או השאר /whatsapp כפי שכבר מוגדר).
 */
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.Body || '';
    const match = message.match(/\d+/);

    let reply = '';

    if (match) {
      const amount = match[0];
      try {
        await appendMessageRow(message, parseFloat(amount) || 0);
      } catch (e) {
        console.error('[webhook] sheets:', e.message);
      }
      reply = `שמרתי ${amount}₪`;
    } else {
      reply = `קיבלתי ממך: ${message}`;
    }

    sendTwiML(res, reply);
  } catch (error) {
    console.error('Error:', error);
    sendTwiML(res, 'קרתה שגיאה, נסה שוב');
  }
});

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

// --- בדיקות אוטומטיות (רק כש-SMOKE_TEST=1): יחידה + POST ל-/whatsapp ---
function runLocalUnitChecks() {
  console.log('\n=== [smoke] בדיקות יחידה (ללא רשת) ===');
  const a = firstNumberInMessage('hello');
  const b = firstNumberInMessage('receipt 42.5');
  const c = firstNumberInMessage('קפה 12,30');
  console.log('  firstNumber("hello") →', a, a === 0 ? '✓' : '✗');
  console.log('  firstNumber("receipt 42.5") →', b, b === 42.5 ? '✓' : '✗');
  console.log('  firstNumber("קפה 12,30") →', c, c === 12.3 ? '✓' : '✗');
}

function postForm(port, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/whatsapp',
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
  console.log('\n=== [smoke] בדיקות HTTP ל-/whatsapp ===');
  const cases = [
    {
      name: 'הודעה רגילה',
      fields: { Body: 'שלום בדיקה', From: TWILIO_FROM_TEST },
    },
    {
      name: 'הודעת קבלה עם סכום',
      fields: { Body: 'קפה 15.75', From: TWILIO_FROM_TEST },
    },
    {
      name: "פקודת 'summary'",
      fields: { Body: 'summary', From: TWILIO_FROM_TEST },
    },
  ];

  for (const t of cases) {
    try {
      const { status, body } = await postForm(port, t.fields);
      const preview = body.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  [${t.name}] HTTP ${status}`);
      console.log(`    TwiML: ${preview}${body.length > 160 ? '…' : ''}`);
    } catch (e) {
      console.error(`  [${t.name}] שגיאה:`, e.message);
    }
  }
  console.log('\n=== [smoke] סיום (ייתכן ששורות נוספו לגיליון אם הוגדרו credentials) ===\n');
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
