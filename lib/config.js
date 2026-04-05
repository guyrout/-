const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** מזהה גיליון ברירת מחדל (מקטע ה-URL /d/<ID>/edit) */
const DEFAULT_GOOGLE_SHEET_ID =
  '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48';

/**
 * טוען Service Account: Secret File ב-Render (או קובץ מקומי) —
 * אם הקובץ לא קיים — נסיון דרך GOOGLE_SERVICE_ACCOUNT_JSON.
 */
function loadGoogleServiceAccountCreds() {
  const localPath = path.join(ROOT, 'Expense-Tracker-Bot.json');
  if (fs.existsSync(localPath)) {
    try {
      return JSON.parse(fs.readFileSync(localPath, 'utf8'));
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

function loadConfig() {
  return {
    TWILIO_ACCOUNT_SID: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
    TWILIO_AUTH_TOKEN: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
    FROM_WHATSAPP_NUMBER: (process.env.FROM_WHATSAPP_NUMBER || '').trim(),
    GOOGLE_SHEET_ID: (
      process.env.GOOGLE_SHEET_ID || DEFAULT_GOOGLE_SHEET_ID
    ).trim(),
    serviceAccountCreds: loadGoogleServiceAccountCreds(),
    /** תשובת ברירת מחדל ל-/whatsapp (לא summary) */
    REPLY: '🔥 הקוד החדש עובד 🔥',
    /** timeout לסיכום מ-Google (מניעת תקיעה של Twilio) */
    SUMMARY_TIMEOUT_MS: (() => {
      const n = Number.parseInt(process.env.SUMMARY_TIMEOUT_MS || '12000', 10);
      return Number.isFinite(n) && n > 0 ? n : 12000;
    })(),
  };
}

function logConfig(config) {
  console.log(
    '[config] TWILIO_ACCOUNT_SID:',
    config.TWILIO_ACCOUNT_SID
      ? `${config.TWILIO_ACCOUNT_SID.slice(0, 6)}…`
      : '(missing)'
  );
  console.log(
    '[config] TWILIO_AUTH_TOKEN:',
    config.TWILIO_AUTH_TOKEN ? '(set)' : '(missing)'
  );
  console.log(
    '[config] FROM_WHATSAPP_NUMBER:',
    config.FROM_WHATSAPP_NUMBER || '(missing)'
  );
  console.log('[config] GOOGLE_SHEET_ID:', config.GOOGLE_SHEET_ID || '(missing)');
  const localCredsPath = path.join(ROOT, 'Expense-Tracker-Bot.json');
  const credsSource = config.serviceAccountCreds
    ? fs.existsSync(localCredsPath)
      ? 'Expense-Tracker-Bot.json (Secret File / local)'
      : 'GOOGLE_SERVICE_ACCOUNT_JSON (env)'
    : '(missing — add Expense-Tracker-Bot.json Secret File or env)';
  console.log('[config] Google Service Account:', credsSource);
}

module.exports = { loadConfig, logConfig, ROOT };
