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
 * שמירת שורה בגיליון הראשון: עמודות Date, Description, Amount.
 * אם הגיליון ריק — נוצרת שורת כותרות מתאימה.
 */
async function appendExpenseRow(description, amount) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return;
  const sheet = doc.sheetsByIndex[0];
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const hasHeaders =
    headers.length >= 3 &&
    headers[0] === 'Date' &&
    headers[1] === 'Description' &&
    headers[2] === 'Amount';
  if (!hasHeaders && headers.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(['Date', 'Description', 'Amount']);
  }
  await sheet.addRow({
    Date: new Date().toISOString(),
    Description: description,
    Amount: amount,
  });
}

/** שמירה ל-Google Sheets (ל-/webhook) — עוטף את appendExpenseRow */
async function saveToSheet(description, amount) {
  await appendExpenseRow(description, parseFloat(amount) || 0);
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
  console.log('[whatsapp]', bodyRaw || '(no Body)');

  const trimmed = String(bodyRaw).trim();
  const isSummary = trimmed.toLowerCase() === 'summary';

  if (isSummary) {
    let responseText;
    try {
      responseText = `סה״כ הוצאות: ${await sumAmountColumn()}₪`;
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
      responseText = 'לא הצלחתי לשלוף סיכום, נסה שוב';
    }
    sendTwiML(res, responseText);
    return;
  }

  const { amount, description } = parseExpenseMessage(trimmed);

  if (!amount) {
    sendTwiML(
      res,
      'כדי לרשום הוצאה, שלח מספר + תיאור.\nלדוגמה: 150 דלק\nאו: קפה 12'
    );
    return;
  }

  try {
    await appendExpenseRow(description || '(ללא תיאור)', amount);
  } catch (e) {
    console.error('[sheets] append failed:', e.message);
    sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
    return;
  }

  sendTwiML(res, `נשמר! ${amount}₪ — ${description || '(ללא תיאור)'}`);
});

/**
 * Webhook חלופי — לוגיקה פשוטה: אם יש ספרות בהודעה → "שמרתי …₪" + שורה ב-Sheets;
 * אחרת → "קיבלתי ממך: …".
 * ב-Twilio הגדר URL: POST …/webhook (או השאר /whatsapp כפי שכבר מוגדר).
 */
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.Body || '';

    let reply = '';

    const match = message.match(/\d+/);

    if (match) {
      const amount = match[0];
      try {
        await saveToSheet(message, amount);
      } catch (e) {
        console.error('[webhook] sheets:', e.message);
      }
      reply = `שמרתי ${amount}₪`;
    } else {
      reply = `קיבלתי ממך: ${message}`;
    }

    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>`);
  } catch (error) {
    console.error(error);
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml('קרתה שגיאה, נסה שוב')}</Message>
</Response>`);
  }
});

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

// --- בדיקות אוטומטיות (רק כש-SMOKE_TEST=1): יחידה + POST ל-/whatsapp ---
function runLocalUnitChecks() {
  console.log('\n=== [smoke] בדיקות יחידה (ללא רשת) ===');
  const a = parseExpenseMessage('hello');
  const b = parseExpenseMessage('150 דלק');
  const c = parseExpenseMessage('קפה 12,30');
  const d = parseExpenseMessage('42.5');
  console.log('  parse("hello") →', JSON.stringify(a), a.amount === 0 ? '✓' : '✗');
  console.log('  parse("150 דלק") →', JSON.stringify(b), b.amount === 150 && b.description === 'דלק' ? '✓' : '✗');
  console.log('  parse("קפה 12,30") →', JSON.stringify(c), c.amount === 12.3 && c.description === 'קפה' ? '✓' : '✗');
  console.log('  parse("42.5") →', JSON.stringify(d), d.amount === 42.5 && d.description === '' ? '✓' : '✗');
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
