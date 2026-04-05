const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Twilio (נקראים מהסביבה; נדרשים ל-Render / Sandbox) ---
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const FROM_WHATSAPP_NUMBER = (process.env.FROM_WHATSAPP_NUMBER || '').trim();

// --- Google Sheets: Service Account מ-env; מזהה הגיליון קבוע ---
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

const REPLY = 'היי! הבוט עובד 🎉';

// --- Google: לקוח משותף (נוצר פעם אחת) ---
let sheetsClientPromise = null;

function getSpreadsheetDoc() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    return null;
  }
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON.trim());
      const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      // חובה להעביר auth כפרמטר שני — בלי JWT אין גישה לגיליון דרך ה-API
      const doc = new GoogleSpreadsheet(
        '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48',
        serviceAccountAuth
      );
      await doc.loadInfo();
      return doc;
    })();
  }
  return sheetsClientPromise;
}

/** המספר הראשון בטקסט, או 0 אם אין */
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

function sendTwiML(res, messageText) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
      messageText
    )}</Message></Response>`
  );
}

/** שומר שורה: Date, Message, Amount (דורש שורת כותרות תואמת בגיליון, או יוצר אותה אם הגיליון ריק) */
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

/** סכום כל ערכי Amount בעמודה */
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
  console.log(
    '[config] Google Sheet ID:',
    '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48 (hardcoded)'
  );
  console.log(
    '[config] GOOGLE_SERVICE_ACCOUNT_JSON:',
    GOOGLE_SERVICE_ACCOUNT_JSON ? '(set)' : '(missing)'
  );
}
logTwilioEnvOnce();

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

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
