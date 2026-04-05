/**
 * בוט WhatsApp (Twilio Sandbox) + שמירה ב-Google Sheets.
 * ב-Render: העלה Secret File בשם Expense-Tracker-Bot.json (ליד index.js) — נטען מ-lib/config.
 * מקומית: אם אין קובץ, אפשר GOOGLE_SERVICE_ACCOUNT_JSON.
 */

const http = require('http');
const express = require('express');
const { loadConfig, logConfig } = require('./lib/config');
const { createSheets, firstNumberInMessage } = require('./lib/sheets');
const { createRoutes } = require('./lib/routes');

const config = loadConfig();
logConfig(config);

const sheets = createSheets(config);

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(createRoutes(config, sheets));

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

const TWILIO_FROM_TEST = 'whatsapp:+15551234567';

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
  console.log(
    '\n=== [smoke] סיום (ייתכן ששורות נוספו לגיליון אם הוגדרו credentials) ===\n'
  );
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
    console.log('Webhooks: POST /whatsapp  |  POST /webhook  |  GET /health');
  });
}
