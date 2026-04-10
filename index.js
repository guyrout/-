/**
 * בוט WhatsApp — כלי מינימליסטי להחזרי קיבוץ (Sheets + Drive).
 * עמודות: Date, Amount, Category, Drive_Link, Status, Notes, User
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
const cron = require('node-cron');
const twilio = require('twilio');
const MessagingResponse = twilio.twiml.MessagingResponse;
const {
  findKibbutzMatches,
  findKibbutzEntryForText,
  extractSubmissionContacts,
  buildSmartLogReply,
  serializeDisambigEntry,
  capNoteFromEntry,
  estimatedRefund,
  potentialRefundForAmountAndTopic,
} = require('./kibbutzSmart');
const { runGeminiKibbutzTurn } = require('./geminiKibbutzAssistant');
const kibbutzData = require('./kibbutzData');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ===================== UI: מינימליסטי, RTL, מפרידי כרטיס =====================

const UI_DIV = '──────────────';

const DRIVE_UPLOAD_FAIL_USER_MSG =
  'העלאה לדרייב נכשלה.\n\nשלח שוב את הקבלה, או שמור אצלך עד שנסגר.\n\nאם זה נמשך — בדוק הרשאות Drive.';

const MEDIA_PROCESSING_ACK_MSG = 'מעלה את הקובץ… רגע.';

/** תשובות FAQ מ־kibbutzData: Markdown **bold** → *bold* ל-WhatsApp */
function formatKibbutzKnowledgeAnswer(answer) {
  return String(answer || '').replace(/\*\*/g, '*');
}

/** בירור: מספר שורה או חלק משם נושא */
function resolveKibbutzDisambigIndex(trimmed, matches) {
  const t = String(trimmed || '').trim();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 1 && n <= matches.length) return n - 1;
    return -1;
  }
  const lower = t.toLowerCase();
  let best = -1;
  let bestLen = 0;
  matches.forEach((m, i) => {
    const top = String(m.topic || '').toLowerCase();
    if (!top) return;
    if (lower.includes(top) || top.includes(lower)) {
      if (top.length > bestLen) {
        bestLen = top.length;
        best = i;
      }
    }
  });
  return best;
}

function savvySummaryTotalLine(total) {
  return `*סה״כ מחכה לך:* *${formatShekelDisplay(total)}* ש״ח`;
}

// ===================== Credentials =====================

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const FROM_WHATSAPP_NUMBER = (process.env.FROM_WHATSAPP_NUMBER || '').trim();
const TO_WHATSAPP_NUMBER = (process.env.TO_WHATSAPP_NUMBER || '').trim();
const GOOGLE_SHEET_ID = (
  process.env.GOOGLE_SHEET_ID || '1xd9BILngzkLX57ja4On73TIehGJIPkCmuS9aEjAhc48'
).trim();
const GOOGLE_DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
/** Public base URL (no trailing slash) so Twilio can fetch one-time chart PNGs from GET /__media/chart/:token */
const PUBLIC_WEBHOOK_BASE = (process.env.PUBLIC_WEBHOOK_BASE || '').trim().replace(/\/$/, '');
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/** WhatsApp Content API (quick-reply / list-picker); optional env overrides */
let contentSidReceiptQr = (process.env.TWILIO_CONTENT_SID_RECEIPT_QR || '').trim();
let contentSidCategoryList = (process.env.TWILIO_CONTENT_SID_CATEGORY_LIST || '').trim();
/** v4: כפתורי טקסט בלבד (ללא אימוג׳י בכפתורים) */
const CONTENT_FN_RECEIPT_QR = 'kibbutz_bot_receipt_qr_v5';
const CONTENT_FN_CATEGORY_LIST = 'kibbutz_bot_category_list_v5';
const CONTENT_FN_CATEGORY_CONFIRM = 'kibbutz_bot_cat_confirm_v5';
let contentSidCategoryConfirm = (process.env.TWILIO_CONTENT_SID_CATEGORY_CONFIRM || '').trim();
let contentTemplatesInitPromise = null;

function fmtWA(num) {
  return num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
}

// ===================== Access control & user identity =====================

/**
 * Allowed WhatsApp senders (E.164 with whatsapp: prefix, e.g. 'whatsapp:+972501234567').
 * Merge with env ALLOWED_WHATSAPP_NUMBERS (comma- or space-separated).
 * If the combined list is empty, all senders are allowed (dev/smoke); set both for production.
 */
const ALLOWED_USERS = [
  // 'whatsapp:+972501234567',
];

function loadAllowedUsersList() {
  const fromEnv = (process.env.ALLOWED_WHATSAPP_NUMBERS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...ALLOWED_USERS, ...fromEnv];
}

const MERGED_ALLOWED_USERS = loadAllowedUsersList();

/** Canonical Twilio From: whatsapp:+<digits> */
function normalizeWaFrom(fromRaw) {
  if (!fromRaw || typeof fromRaw !== 'string') return '';
  const digits = fromRaw.replace(/^whatsapp:/i, '').replace(/\D/g, '');
  if (!digits) return '';
  return `whatsapp:+${digits}`;
}

function e164FromWaNorm(waNorm) {
  return waNorm.replace(/^whatsapp:/i, '+');
}

function isAllowedWaFrom(waNorm) {
  if (!waNorm) return false;
  if (MERGED_ALLOWED_USERS.length === 0) return true;
  return MERGED_ALLOWED_USERS.some((a) => normalizeWaFrom(a) === waNorm);
}

/** Value stored in sheet column User (I): visible name + stable phone for filtering */
function formatUserSheetValue(profileName, waNorm) {
  const phone = e164FromWaNorm(waNorm);
  const name = (profileName || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
  const label = name || phone;
  return `${label} (${phone})`;
}

function userCellMatchesOwner(userCell, waNorm) {
  if (!waNorm) return false;
  const needle = e164FromWaNorm(waNorm).replace(/\s/g, '');
  const hay = String(userCell || '').replace(/\s/g, '');
  if (!needle || !hay) return false;
  return hay.includes(needle);
}

function profileSlugForFiles(profileName) {
  const base = (profileName || '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return base || 'User';
}

/** Session / userState key = canonical From (same as Twilio after normalize) */
function buildWhatsAppContext(req) {
  const fromRaw = (req.body.From || '').trim();
  const waNorm = normalizeWaFrom(fromRaw);
  const profileName = (req.body.ProfileName || '').trim();
  return {
    fromRaw,
    waNorm,
    sessionKey: waNorm,
    profileName,
    userSheetValue: waNorm ? formatUserSheetValue(profileName, waNorm) : '',
    fileSlug: profileSlugForFiles(profileName),
  };
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
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('[media] Download failed: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing');
    throw new Error('Twilio credentials not configured for media download');
  }
  console.log('[media] Downloading media via axios (arraybuffer + Twilio Basic auth)...');
  const resp = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    maxContentLength: 25 * 1024 * 1024,
    maxBodyLength: 25 * 1024 * 1024,
    auth: {
      username: TWILIO_ACCOUNT_SID,
      password: TWILIO_AUTH_TOKEN,
    },
  });
  const buffer = Buffer.from(resp.data);
  console.log('[media] Download finished, bytes:', buffer.length);
  return { buffer, contentType: resp.headers['content-type'] || 'image/jpeg' };
}

function bufferToStream(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

/**
 * Upload bytes to Drive. Files stay private (no link sharing / no "anyone").
 * Only accounts with access to GOOGLE_DRIVE_FOLDER_ID (owner + service account) can open them.
 */
async function uploadToDrive(buffer, contentType, fileName) {
  const drive = getDriveClient();
  if (!drive) {
    console.error('[drive] Drive upload failed: no Drive client (check service account)');
    return null;
  }
  const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (!folderId) {
    console.error('[drive] Drive upload failed: GOOGLE_DRIVE_FOLDER_ID is not set');
    return null;
  }

  console.log('[drive] Drive upload started:', fileName, `(${buffer.length} bytes)`);
  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };

  try {
    const createRes = await drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType: contentType, body: bufferToStream(buffer) },
      fields: 'id,webViewLink',
    });
    const id = createRes.data.id;
    const webViewLink =
      createRes.data.webViewLink || (id ? `https://drive.google.com/file/d/${id}/view` : null);
    console.log('[drive] Drive upload finished: fileId=', id, 'webViewLink=', webViewLink ? '(set)' : '(missing)');
    return webViewLink;
  } catch (error) {
    console.error('DRIVE ERROR DETAILS:', error.response ? error.response.data : error.message);
    return null;
  }
}

async function handleMediaUpload(req, fileBaseName) {
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  if (numMedia === 0) return null;

  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0 || 'image/jpeg';
  if (!mediaUrl) return null;

  console.log('[media] Image detected, MediaContentType0=', mediaType);
  try {
    const { buffer, contentType } = await downloadTwilioMedia(mediaUrl);
    const ext = contentType.includes('png') ? 'png' : contentType.includes('pdf') ? 'pdf' : 'jpg';
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const safeBase = (fileBaseName || 'Receipt')
      .replace(/[^\p{L}\p{N}_.-]/gu, '_')
      .replace(/_+/g, '_')
      .slice(0, 80) || 'Receipt';
    const fileName = `${safeBase}_${dd}_${mm}.${ext}`;
    const link = await uploadToDrive(buffer, contentType, fileName);
    return link;
  } catch (e) {
    console.error(
      '[media] Download/upload failed:',
      e.response ? e.response.data : e.message
    );
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
/** Broad summary trigger: substring / regex (includes סטטיסטיקה, תראה לי, …) */
const SUMMARY_INTENT_SUBSTRINGS = ['סיכום', 'כמה הוצאתי', 'תראה לי', 'סטטיסטיקה', 'דוח', 'דו"ח', 'סטטוס', 'summary', 'report'];
const SUMMARY_INTENT_RE = /כמה\s+(?:הוצאתי|בזבזתי|שילמתי)|תראה\s+לי|סיכום|סטטיסטיקה|דוח|דו["״]ח|סטטוס|summary|report/i;

const INTENT_HELP_SUBSTRINGS = ['עזרה', 'מה אתה יודע', 'איך להשתמש', 'help', 'מדריך', 'פקודות'];
const HELP_INTENT_RE = /עזרה|מה\s+אתה\s+יודע|איך\s+להשתמש|^help$|מדריך|איך\s+עובד/i;

/** Delete flow (not management row-delete phrases) */
const DELETE_INTENT_RE = /מחק|להסיר|טעות|מחיקה|תמחק|undo|remove|delete/i;
const DELETE_INTENT_EXCLUDE_RE = /מחק\s+שורה|מחק\s+מהרשימה|מחק\s+רשומה|רשימת\s+ניהול/i;

const INTENT_POLITENESS = ['תודה', 'מעולה', 'אחלה', 'יופי', 'thanks', 'great'];
const INTENT_GREETING = ['היי', 'שלום', 'הלו', 'hi', 'hello', 'בוקר טוב', 'ערב טוב'];
const INTENT_CATEGORIES = ['קטגוריות', 'רשימה', 'categories'];
const INTENT_BUDGET = ['יעד', 'תקציב', 'budget'];
const INTENT_NOT_SUBMITTED = ['מה לא הוגש', 'לא הוגש', 'פתוחות', 'unsubmitted'];
const INTENT_MARK_SUBMITTED = ['הגשתי', 'הוגש', 'submitted'];
const INTENT_CONFIRM_YES = [
  'כן', 'yes', 'כ', 'בטוח', 'נכון', 'יאללה', 'יאללה כן', 'אש', 'סגור', 'סגור סגור',
  'בטח', 'עוד', 'מסכים', 'מאשר', 'נשמע', 'קדימה', 'ok', 'okay',
];
const INTENT_CONFIRM_NO = [
  'לא', 'no', 'ל', 'עזוב', 'לא עכשיו', 'לא רוצה', 'טעות', 'ביטול', 'בטל', 'תעזוב',
  'לא מעוניין', 'לא מעוניינת', 'עזוב אותי', 'תפסיק',
];
/** Full-month management list: ניהול / תיקון / מחק (phrases) — bare "מחק" stays quick-undo */
const INTENT_MANAGEMENT = [
  'ניהול', 'תיקון', 'תיקונים', 'נהל', 'עריכה', 'עריכת רשומות',
  'מחק שורה', 'מחק מהרשימה', 'מחק רשומה', 'רשימת ניהול',
];

function detectSummaryIntent(lower, trimmed) {
  if (SUMMARY_INTENT_RE.test(trimmed)) return true;
  return SUMMARY_INTENT_SUBSTRINGS.some((s) => lower.includes(s));
}

function detectHelpIntent(lower, trimmed) {
  if (HELP_INTENT_RE.test(trimmed)) return true;
  return INTENT_HELP_SUBSTRINGS.some((s) => lower.includes(s));
}

/** True if user wants the guided delete flow (excludes ניהול phrases). */
function detectDeleteIntent(lower, trimmed) {
  if (DELETE_INTENT_EXCLUDE_RE.test(trimmed)) return false;
  return DELETE_INTENT_RE.test(trimmed);
}

const CURRENCY_RE = /[$€]|דולר|אירו|euro|dollar/i;

// ===================== 11 קטגוריות קיבוץ (שמות מלאים + אימוג׳י בשיטס) =====================

const CAT = {
  psych: 'החזרי פסיכולוג 🧘',
  health: 'החזרי בריאות 🩺',
  parking: 'החזרי חנייה 🅿️',
  transit: 'החזרי נסיעות תחבורה ציבורית 🚏',
  hair: 'החזרי תספורת וקוסמטיקה 💇',
  kids: 'החזרי ילדים 👶',
  phone: 'החזרי טלפון 📱',
  gov: 'החזרי תשלומים ממשלתיים ⚖️',
  clothing: 'החזרי ביגוד לעובדי חוץ 👕',
  building: 'החזרי בניין 🏡',
  taxi: 'החזרי מוניות 🚕',
};

const CANONICAL_CATEGORIES = [
  CAT.psych,
  CAT.health,
  CAT.parking,
  CAT.transit,
  CAT.hair,
  CAT.kids,
  CAT.phone,
  CAT.gov,
  CAT.clothing,
  CAT.building,
  CAT.taxi,
];

/** מילות מפתח (40+ לקטגוריה); ביטויים רב־מילים לפני טוקנים חופשיים */
const CATEGORY_MAP = [
  {
    category: CAT.psych,
    keywords: [
      'טיפול נפשי', 'טיפול פסיכולוגי', 'בריאות הנפש', 'ייעוץ נפשי', 'שיחה טיפולית', 'טיפול זוגי',
      'טיפול משפחתי', 'טיפול דינמי', 'טיפול קבוצתי', 'פסיכותרפיה', 'פסיכולוגיה קלינית',
      'cbt', 'קוגניטיבי התנהגותי', 'mindfulness', 'מיינדפולנס', 'היפנוזה קלינית',
      'פוסט טראומה', 'ptsd', 'ocd', 'חרדה', 'דיכאון', 'אבחון נפשי', 'אבחון פסיכולוגי',
      'פסיכולוג', 'פסיכולוגית', 'פסיכולוגיה', 'מטפל', 'מטפלת', 'פסיכיאטר', 'פסיכיאטריה',
      'טיפול', 'נפשי', 'נפשית', 'פסיכולוגית', 'פסיכולוג', 'מטפלת', 'מטפל', 'פסיכיאטרית',
      'פסיכיאטר', 'טיפול בילדים', 'טיפול מתבגרים', 'קבוצת תמיכה', 'טיפול באמנות',
      'psychologist', 'therapy', 'therapist', 'psychiatry', 'מכון לבריאות הנפש',
    ],
  },
  {
    category: CAT.health,
    keywords: [
      'בית חולים', 'מרכז רפואי', 'מיון', 'אשפוז', 'ניתוח', 'מרפאה', 'קופת חולים', 'קופ"ח',
      'ביקור רופא', 'רופא משפחה', 'רופא מומחה', 'מומחה', 'אורתופד', 'גינקולוג', 'גניקולוג',
      'עור', 'אף אוזן גרון', 'עיניים', 'שיניים', 'סטומטולוג', 'דנטלי', 'פיזיותרפיה',
      'רפואה משלימה', 'דיקור', 'כירופרקט', 'בדיקת דם', 'בדיקות דם', 'MRI', 'CT', 'רנטגן',
      'אולטרסאונד', 'אולטרה סאונד', 'קליניקה', 'מרשם', 'תרופות', 'בית מרקחת', 'רוקחות',
      'רפואה', 'בריאות', 'טיפול רפואי', 'אשפוז יום', 'מרפאת חוץ', 'מכון דימות', 'בדיקה רפואית',
      'רופא', 'רופאה', 'אחות', 'אחיות', 'מעבדה רפואית', 'פיזיותרפיסט', 'קלינאית תקשורת',
    ],
  },
  {
    category: CAT.parking,
    keywords: [
      'חניון', 'חנייה', 'חניה', 'חנית', 'תו חניה', 'תו חנייה', 'חניה בתשלום', 'שובר חניה',
      'פנגו', 'pango', 'סלופארק', 'slopark', 'סלופרק', 'אפליקציית חניה', 'תשלום חניה',
      'כחול לבן', 'חניון עירייה', 'חניון מקורה', 'חניון חיצוני', 'דיסק חניה', 'מטר חניה',
      'חניית נכה', 'נכה חניה', 'אחסון רכב', 'חניון שדה', 'חניון קניון', 'חניון בית חולים',
      'parking', 'park', 'חניית לילה', 'חניית שבת', 'חניון עבודה', 'חניון משרד',
      'תו כחול', 'תו אזורי', 'חניון עירוני', 'חניון רב קומות', 'שער חניה', 'מחסום חניה',
      'חניון אוטומטי', 'smart parking', 'סמארט פארק', 'חניית רחוב', 'חניה ברחוב',
    ],
  },
  {
    category: CAT.transit,
    keywords: [
      'תחבורה ציבורית', 'אוטובוס', 'רכבת', 'רכבת ישראל', 'רק"ל', 'רקל', 'מטרונית', 'קו אדום',
      'קו ירוק', 'קו סגול', 'דן', 'דן באדס', 'אגד', 'אגד תעוברה', 'אגד תעבורה', 'מטרופולין',
      'נתיב', 'קווים', 'קווי', 'רב קו', 'רב־קו', 'כרטיסיה', 'מונית שירות', 'מוניות שירות',
      'שירות', 'קו לילה', 'קווי לילה', 'אפיקים', 'סופרבוס', 'מעברות', 'תחנת רכבת',
      'תחנת אוטובוס', 'מסוף', 'מסוף רכבת', 'נתיב מהיר', 'מיניבוס ציבורי', 'שרותל',
      'רכבת קלה', 'light rail', 'תשלום אוטובוס', 'תשלום רכבת', 'מנוי רכבת', 'מנוי אוטובוס',
      'העלאה לאוטובוס', 'נסיעה באוטובוס', 'נסיעה ברכבת', 'תחבורה', 'ציבורית',
    ],
  },
  {
    category: CAT.hair,
    keywords: [
      'תספורת', 'מספרה', 'ספר', 'ספרית', 'תספורת גברים', 'תספורת נשים', 'עיצוב שיער',
      'צבע שיער', 'גוונים', 'הבהרה', 'תספורת ילדים', 'גילוח', 'זקן', 'טיפוח זקן',
      'קוסמטיקאית', 'קוסמטיקה', 'טיפוח', 'סלון יופי', 'סלון', 'מניקור', 'פדיקור', 'לק',
      'לק ג׳ל', 'ג׳ל', 'ציפורניים', 'הרמת ריסים', 'החלקה', 'טיפול פנים', 'פילינג', 'barber',
      'hair', 'nails', 'manicure', 'pedicure', 'שעווה', 'שיזוף', 'סאונה יופי', 'מסכה לשיער',
      'תסרוקת', 'איפור', 'איפור קבוע', 'עיצוב גבות', 'הדבקת ריסים',
    ],
  },
  {
    category: CAT.kids,
    keywords: [
      'גן ילדים', 'גן חובה', 'גן עירייה', 'מעון', 'מעון יום', 'צהרון', 'בייביסיטר', 'שמרטפית',
      'קייטנה', 'קייטנת', 'חוג לילדים', 'חוגים לילדים', 'פעוטון', 'פעוטות', 'תינוק', 'תינוקות',
      'בייבי', 'בייביסיטר', 'משחקייה', 'מסיבת ילדים', 'יום הולדת ילדים', 'מסיבת גן',
      'ציוד לתינוק', 'חיתולים', 'מוצצים', 'בקבוקים', 'עגלת תינוק', 'מושב בטיחות', 'בטיחות ילדים',
      'גן שעשועים', 'פארק שעשועים', 'אטרקציה לילדים', 'סדנת ילדים', 'קיץ לילדים', 'חוג ספורט ילדים',
      'ילדים', 'ילד', 'ילדה', 'בן גן', 'בת גן', 'מסגרת חינוך', 'חינוך בוקר', 'פעילות לילדים',
    ],
  },
  {
    category: CAT.phone,
    keywords: [
      'סלולר', 'סלולאר', 'פלאפון', 'סלקום', 'פרטנר', 'גולן טלקום', 'הוט מובייל', 'hot mobile',
      'וריץון', 'wecom', 'טלפון נייד', 'מכשיר', 'חבילת גלישה', 'גלישה', 'גיגה', 'GB', 'gb',
      'סים', 'sim', 'esim', 'eSIM', 'החלפת מסך', 'תיקון טלפון', 'מנוי סלולר', 'חבילה משפחתית',
      'שיחות', 'הודעות', 'וואטסאפ ביזנס', 'מספר וירטואלי', 'קו עסקי', 'טלפון', 'נייד',
      'אינטרנט בטלפון', 'נטפליקס בנייד', 'חיבור סלולר', 'מודם סלולרי', 'רouter נייד',
      'הארכת אחריות טלפון', 'ביטוח מכשיר', 'מכשיר חכם', 'סמארטפון', 'אייפון', 'אנדרואיד',
    ],
  },
  {
    category: CAT.gov,
    keywords: [
      'ביטוח לאומי', 'ביטוח הלאומי', 'תביעה לביטוח לאומי', 'תביעת ביטוח', 'קצבת ילדים',
      'קצבת זקנה', 'קצבת נכות', 'דמי אבטלה', 'דמי מחלה', 'דמי לידה', 'חופשת לידה',
      'מענק לידה', 'מענק עובדים', 'פיצוי פיטורין', 'פנסיה', 'קרן השתלמות', 'החזר ביטוח',
      'החזר ממשלה', 'משרד הפנים', 'רשות האוכלוסין', 'אגרת רישוי', 'רישיון רכב', 'רישיון נהיגה',
      'תשלום עירייה', 'ארנונה', 'היטל השבחה', 'הוצאות משפט מול רשות', 'עורך דין ממשלתי',
      'גמלאות', 'גמלה', 'תגמולים', 'פיצויים מהמדינה', 'מענק חירום', 'סיוע ממשלתי',
      'תשלום ממשלתי', 'משרד הרווחה', 'משרד הכלכלה', 'רשות המיסים החזר', 'מע״מ החזר',
    ],
  },
  {
    category: CAT.clothing,
    keywords: [
      'ביגוד עבודה', 'מדי עבודה', 'מדים', 'נעלי בטיח', 'נעלי עבודה', 'אפוד זוהר', 'אפוד רפלקטיבי',
      'קסדה', 'קסדת עבודה', 'משקפי מגן', 'כפפות עבודה', 'כפפות בטיחות', 'מעיל עבודה', 'מכנס עבודה',
      'חולצת עבודה', 'בגדי חוץ', 'ציוד מגן אישי', 'צמ״א', 'נעלי שטח', 'מגפי עבודה', 'סרבל',
      'בגדים לעבודה בשטח', 'עובד חוץ', 'עובדי חוץ', 'ציוד בטיחות', 'בגדים מיוחדים לעבודה',
      'מדי בטיחות', 'חגורת בטיחות', 'רתמה', 'נעלי סטילס', 'בגדים תרמיים לעבודה', 'מעיל חורף עבודה',
      'ביגוד מגן', 'חליפת גשם עבודה', 'מסכת ריתוך', 'אוזניות מגן', 'אטמי אוזניים תעסוקתיים',
      'מגפיים גבוהים', 'סוודר עבודה', 'חולצה מחממת לעבודה', 'בגדים לאתר', 'ציוד אתר',
    ],
  },
  {
    category: CAT.building,
    keywords: [
      'ועד בית', 'ועד הבית', 'אחזקת בניין', 'אחזקה משותפת', 'דירה', 'בניין מגורים', 'בית משותף',
      'תיקון מעלית', 'מעלית', 'דוד שמש', 'דוד חשמלי', 'אינסטלטור בניין', 'חשמלאי בניין',
      'נזילה בבניין', 'גג נזילה', 'מרפסת משותפת', 'גינה משותפת', 'שער חשמלי בניין', 'מצלמות בניין',
      'ניקיון בניין', 'שיפוץ משותף', 'צביעת בניין', 'גג', 'קרן בניין', 'החזר ועד בית',
      'הוצאות דיירים', 'אסיפת דיירים', 'ניהול בניין', 'חברת ניהול', 'דמי ניהול', 'ועד מתחם',
      'תשלום בניין', 'תיקון גג', 'איטום גג', 'חיזוק מבנה', 'בטיחות בניין', 'מערכת סולארית משותפת',
    ],
  },
  {
    category: CAT.taxi,
    keywords: [
      'מונית', 'מוניות', 'נסיעה במונית', 'הזמנת מונית', 'מונית שירות פרטית', 'מונית פרטית',
      'גט', 'gett', 'get taxi', 'יאנגו', 'yango', 'בול', 'בול מוניות', 'uber', 'יובר',
      'קווי מוניות', 'מונית משרד', 'מונית לשדה', 'מונית לנתבג', 'מונית לבית חולים',
      'מונית לעבודה', 'נסיעה עסקית במונית', 'נסיעת מונית', 'אפליקציית מוניות', 'הזמנה באפליקציה',
      'מונית 24 שעות', 'מונית לילה', 'מונית שבת', 'מחיר מונית', 'מונה מונית', 'נסיעה מהירה',
      'taxi', 'cab', 'מונית מיוחדת', 'מונית גדולה', 'מונית שרות פרטי', 'נסיעה דחופה במונית',
    ],
  },
];

const CLARIFY_CATEGORY_MSG =
  `*בחירת קטגוריה*\n\nלא זיהיתי קטגוריה מהטקסט.\n\nבחר מהרשימה — *לא מנחשים*.`;

/** List-picker id → שם מלא כמו בשיטס */
const LIST_ITEM_ID_TO_CATEGORY = {
  CAT_K_PSYCH: CAT.psych,
  CAT_K_HEALTH: CAT.health,
  CAT_K_PARK: CAT.parking,
  CAT_K_TRANSIT: CAT.transit,
  CAT_K_HAIR: CAT.hair,
  CAT_K_KIDS: CAT.kids,
  CAT_K_PHONE: CAT.phone,
  CAT_K_GOV: CAT.gov,
  CAT_K_CLOTH: CAT.clothing,
  CAT_K_BUILD: CAT.building,
  CAT_K_TAXI: CAT.taxi,
};

/** Quick-reply button payloads (inbound ButtonPayload) */
const QR_PAYLOAD_SUMMARY = 'btn_summary';
const QR_PAYLOAD_UNDO_LAST = 'btn_undo_last';
const QR_PAYLOAD_CAT_YES = 'btn_cat_yes';
const QR_PAYLOAD_CAT_NO = 'btn_cat_no';

const CATEGORY_RETRY_MSG =
  'לא זיהיתי.\n\nלחץ *בחר קטגוריה* ברשימה, או כתוב מילה ברורה (מונית, אוטובוס, פנגו…).';

function normalizeCategoryText(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[״"']/g, '')
    .toLowerCase();
}

function stripCategoryEmojis(s) {
  return String(s || '').replace(/\p{Extended_Pictographic}\uFE0F?/gu, '').replace(/\s+/g, ' ').trim();
}

function textIncludesPhrase(hayNorm, phraseNorm) {
  if (!phraseNorm) return false;
  return hayNorm.includes(phraseNorm);
}

/**
 * מחזיר קטגוריה מלאה אחת או null אם אין התאמה או יש עמימות (לא מנחשים).
 */
function matchCategory(description) {
  if (!description || typeof description !== 'string') return null;
  const raw = description.trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const stripped = lower
    .split(/\s+/)
    .map((w) => (w.length > 2 && HEB_PREFIX_RE.test(w) ? w.slice(1) : w))
    .join(' ');
  const hay = `${lower} ${stripped}`;
  const hayNorm = normalizeCategoryText(hay);

  const matched = new Set();
  for (const { category, keywords } of CATEGORY_MAP) {
    for (const kw of keywords) {
      const kn = normalizeCategoryText(kw);
      if (!kn) continue;
      if (kn.includes(' ')) {
        if (textIncludesPhrase(hayNorm, kn)) matched.add(category);
        continue;
      }
      if (hayNorm.includes(kn)) matched.add(category);
    }
  }
  if (matched.size === 1) return [...matched][0];
  return null;
}

/**
 * תשובת משתמש אחרי רשימה / טקסט קצר — רק התאמה חד־משמעית (כולל שם מלא מהרשימה).
 */
function resolveCategoryFromReply(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (LIST_ITEM_ID_TO_CATEGORY[trimmed]) return LIST_ITEM_ID_TO_CATEGORY[trimmed];
  const lower = trimmed.toLowerCase();
  const stripped = lower
    .split(/\s+/)
    .map((w) => (w.length > 2 && HEB_PREFIX_RE.test(w) ? w.slice(1) : w))
    .join(' ');
  const blob = `${trimmed} ${lower} ${stripped}`;
  const blobNorm = normalizeCategoryText(blob);

  for (const canon of CANONICAL_CATEGORIES) {
    const cn = normalizeCategoryText(stripCategoryEmojis(canon));
    if (
      blobNorm === cn ||
      normalizeCategoryText(trimmed) === cn ||
      blobNorm.includes(cn) ||
      cn.includes(blobNorm)
    ) {
      return canon;
    }
  }
  return matchCategory(trimmed);
}

function categoryEmoji(description) {
  const cat = matchCategory(description);
  if (!cat) return '💰';
  const m = cat.match(/\p{Emoji_Presentation}\uFE0F?|\p{Extended_Pictographic}/gu);
  return m && m.length ? m[m.length - 1] : '💰';
}

function buildDeletionFeedbackCard(description, amount) {
  const desc = (description || '—').trim() || '—';
  const amt = formatShekelDisplay(amount);
  return (
    `*הפעולה בוטלה*\n\n` +
    `${UI_DIV}\n\n` +
    `~${desc} — ${amt} ש״ח~\n\n` +
    `${UI_DIV}\n\n` +
    `השורה הוסרה מהגיליון.`
  );
}

function buildSuccessRecordCard(amount, category, dateDisplay, options = {}) {
  const dup = options.duplicateAppend || '';
  const receiptBlock = options.awaitingReceipt
    ? `\n\n*קבלה:* שלח תמונה, או השב *כן* / *לא*.`
    : '';
  return (
    `*הפרטים נשמרו בהצלחה*\n\n` +
    `${UI_DIV}\n\n` +
    `*קטגוריה:* ${category}\n` +
    `*סכום:* *${formatShekelDisplay(amount)}* ש״ח\n` +
    `*תאריך:* ${dateDisplay}\n\n` +
    `${UI_DIV}\n\n` +
    `הנתונים עודכנו בגיליון הקיבוץ.` +
    dup +
    receiptBlock
  );
}

/** Small talk / גישור רגשי → נידנוד לקטגוריה הרלוונטית */
const BRIDGE_PSYCH = ['פסיכולוג', 'פסיכולוגית', 'מטפל', 'מטפלת', 'טיפול נפשי', 'חרדה', 'דיכאון', 'נפשי'];
const BRIDGE_HEALTH = ['כואב', 'כאב', 'חולה', 'חולת', 'רופא', 'בית חולים', 'קופה', 'בריאות', 'חולים'];
const BRIDGE_LOOKS = ['תספורת', 'מסתפר', 'מספרה', 'קוסמטיק', 'שיער', 'זקן', 'מראה'];
const BRIDGE_DRIVE = ['נהג', 'נוהג', 'פקק', 'כביש', 'דרך', 'חניה בלי', 'תחבורה'];

function tryBridgingSmallTalk(lower, trimmed) {
  if (!trimmed || trimmed.length > 140) return null;
  if (/\d/.test(trimmed)) return null;
  const t = ` ${lower} `;
  if (BRIDGE_PSYCH.some((k) => t.includes(k))) {
    return (
      `רשמתי.\n\n` +
      `אגב, אם יש קבלה על *${CAT.psych}* או *${CAT.health}*, אפשר לרשום כאן *סכום + תיאור*.`
    );
  }
  if (BRIDGE_HEALTH.some((k) => t.includes(k))) {
    return (
      `רשמתי.\n\n` +
      `אגב, אם יש קבלה על *${CAT.health}*, אני פה — *סכום + תיאור*.`
    );
  }
  if (BRIDGE_LOOKS.some((k) => t.includes(k))) {
    return (
      `רשמתי.\n\n` +
      `אגב, אם יש קבלה על *${CAT.hair}*, אפשר לשלוח *סכום + תיאור*.`
    );
  }
  if (BRIDGE_DRIVE.some((k) => t.includes(k))) {
    return (
      `רשמתי.\n\n` +
      `אגב, אם יש קבלה על *${CAT.taxi}*, *${CAT.transit}* או *${CAT.parking}*, אני פה.`
    );
  }
  return null;
}

async function startCategoryClarification(res, phone, pick, opts = {}) {
  const s = getSession(phone);
  s.state = 'AWAITING_CATEGORY_CLARIFICATION';
  s.pendingCategoryPick = pick;
  s.ts = Date.now();
  const wa = opts.waNorm || '';
  await ensureWhatsAppContentTemplates();

  const sentList =
    wa &&
    contentSidCategoryList &&
    (await sendWhatsAppContentMessage(wa, contentSidCategoryList, {}));

  if (sentList) {
    if (res && !res.headersSent) emptyTwiMLResponse(res);
    return;
  }

  if (opts.useOutboundApi && wa) {
    void replyWhatsAppToUser(wa, CLARIFY_CATEGORY_MSG);
  } else if (res && !res.headersSent) {
    sendTwiML(res, CLARIFY_CATEGORY_MSG);
  }
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

/** Strip common Hebrew prefixes before amount (בסך, בעלות, הוצאתי, …) */
const LEADING_AMOUNT_PHRASES =
  /^(?:(?:בסך\s+של|בסך|בעלות\s+של|בעלות|סכום\s+של|סכום|שילמתי|הוצאתי|יצאתי|יצא|עלות\s+של|עלות)\s+)+/i;

function stripHebrewArticleWords(s) {
  return s
    .split(/\s+/)
    .map((w) => {
      if (w.length > 2 && w.startsWith('ה') && /[\u0590-\u05FF]/.test(w[1])) return w.slice(1);
      return w;
    })
    .join(' ')
    .trim();
}

function parseExpenseMessage(text) {
  if (!text || typeof text !== 'string') return { amount: 0, description: '' };
  let trimmed = text.trim().replace(/\s+/g, ' ');
  trimmed = trimmed.replace(LEADING_AMOUNT_PHRASES, '').trim();

  let forAmount = trimmed
    .replace(/[$€£]/g, ' ')
    .replace(/\b(?:דולרים?|דולר|אירו|euro|dollar|שקלים?|ש״ח|ש"ח|₪|nis)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const m = forAmount.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) {
    const d = stripHebrewArticleWords(trimmed);
    return { amount: 0, description: sanitizeDescription(d) };
  }

  const amount = parseFloat(m[1].replace(',', '.')) || 0;
  const idx = forAmount.indexOf(m[1]);
  const before = forAmount.slice(0, idx).trim();
  const after = forAmount.slice(idx + m[1].length).trim();
  const rawDesc = (after || before).replace(/\s+/g, ' ').trim();
  const desc = sanitizeDescription(stripHebrewArticleWords(rawDesc));

  return { amount, description: desc };
}

// ===================== TwiML (Twilio MessagingResponse — send after all async work) =====================

function sendTwiML(res, messageText) {
  if (res.headersSent) return;
  const twiml = new MessagingResponse();
  twiml.message(String(messageText));
  res.type('text/xml').send(twiml.toString());
}

function sendTwiMLMulti(res, parts) {
  if (res.headersSent) return;
  const msgs = Array.isArray(parts) ? parts.filter(Boolean) : [parts];
  const twiml = new MessagingResponse();
  for (const p of msgs) twiml.message(String(p));
  res.type('text/xml').send(twiml.toString());
}

/** Close webhook without sending a visible TwiML message; follow up via REST API. */
function emptyTwiMLResponse(res) {
  if (res.headersSent) return;
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

/** WhatsApp typing indicator (Twilio v2 beta). Requires inbound MessageSid / SmsSid. */
async function sendWhatsAppTypingIndicator(messageSid) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !messageSid) return;
  try {
    await axios.post(
      'https://messaging.twilio.com/v2/Indicators/Typing.json',
      new URLSearchParams({ messageId: messageSid, channel: 'whatsapp' }).toString(),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      }
    );
  } catch (e) {
    console.warn('[twilio] typing indicator:', e.response?.data || e.message);
  }
}

/** Outbound reply to the user (same sender as the bot). Used after empty TwiML. */
async function replyWhatsAppToUser(waNorm, body) {
  if (!twilioClient || !FROM_WHATSAPP_NUMBER || !waNorm || body == null || body === '') return;
  const to = waNorm.startsWith('whatsapp:') ? waNorm : fmtWA(waNorm);
  try {
    await twilioClient.messages.create({
      from: fmtWA(FROM_WHATSAPP_NUMBER),
      to,
      body: String(body),
    });
    console.log('[whatsapp] outbound reply:', String(body).slice(0, 72));
  } catch (e) {
    console.error('[whatsapp] outbound reply failed:', e.message);
  }
}

/** WhatsApp image(s) from public URL(s) (e.g. QuickChart PNG). */
async function replyWhatsAppWithMedia(waNorm, mediaUrlList, body) {
  if (!twilioClient || !FROM_WHATSAPP_NUMBER || !waNorm || !mediaUrlList?.length) return false;
  const to = waNorm.startsWith('whatsapp:') ? waNorm : fmtWA(waNorm);
  try {
    const payload = {
      from: fmtWA(FROM_WHATSAPP_NUMBER),
      to,
      mediaUrl: mediaUrlList,
    };
    const b = body != null ? String(body).trim() : '';
    if (b) payload.body = b;
    await twilioClient.messages.create(payload);
    console.log('[whatsapp] outbound media:', mediaUrlList.length, 'url(s)');
    return true;
  } catch (e) {
    console.error('[whatsapp] outbound media failed:', e.message);
    return false;
  }
}

function clipWhatsAppButtonTitle(s, maxCp = 20) {
  const cp = [...s];
  if (cp.length <= maxCp) return s;
  return cp.slice(0, Math.max(1, maxCp - 1)).join('') + '…';
}

function clipWhatsAppListField(s, max) {
  const cp = [...s];
  if (cp.length <= max) return s;
  return cp.slice(0, Math.max(1, max - 1)).join('') + '…';
}

function categoryListPickerItems() {
  const meta = {
    [CAT.psych]: 'טיפול, מטפל, פסיכולוג',
    [CAT.health]: 'רופא, בית חולים, קופה',
    [CAT.parking]: 'חניון, פנגו, סלופארק',
    [CAT.transit]: 'אוטובוס, רכבת, רב־קו',
    [CAT.hair]: 'תספורת, קוסמטיקה, סלון',
    [CAT.kids]: 'גן, מעון, צהרון, קייטנה',
    [CAT.phone]: 'סלולר, חבילה, סים',
    [CAT.gov]: 'ביטוח לאומי, קצבאות, מענקים',
    [CAT.clothing]: 'מדי עבודה, בטיחות, צמ״א',
    [CAT.building]: 'ועד בית, אחזקה, מעלית',
    [CAT.taxi]: 'מונית, גט, יאנגו, בול',
  };
  const idByCat = {
    [CAT.psych]: 'CAT_K_PSYCH',
    [CAT.health]: 'CAT_K_HEALTH',
    [CAT.parking]: 'CAT_K_PARK',
    [CAT.transit]: 'CAT_K_TRANSIT',
    [CAT.hair]: 'CAT_K_HAIR',
    [CAT.kids]: 'CAT_K_KIDS',
    [CAT.phone]: 'CAT_K_PHONE',
    [CAT.gov]: 'CAT_K_GOV',
    [CAT.clothing]: 'CAT_K_CLOTH',
    [CAT.building]: 'CAT_K_BUILD',
    [CAT.taxi]: 'CAT_K_TAXI',
  };
  return CANONICAL_CATEGORIES.map((cat) => ({
    item: clipWhatsAppListField(cat, 24),
    description: clipWhatsAppListField(meta[cat] || 'החזר מהקיבוץ', 72),
    id: idByCat[cat],
  }));
}

async function twilioContentRequest(method, pathSuffix, data) {
  const path = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
  return axios({
    method,
    url: `https://content.twilio.com/v1${path}`,
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    headers: data ? { 'Content-Type': 'application/json' } : {},
    data,
    timeout: 20000,
    validateStatus: () => true,
  });
}

async function fetchContentFriendlyNameToSid() {
  const map = new Map();
  let nextPath = '/Content?PageSize=100';
  for (let i = 0; i < 12 && nextPath; i++) {
    const r = await twilioContentRequest('GET', nextPath);
    if (r.status !== 200) {
      console.warn('[twilio-content] list Content', r.status, JSON.stringify(r.data || {}).slice(0, 240));
      break;
    }
    for (const c of r.data.contents || []) {
      if (c.friendly_name && c.sid) map.set(c.friendly_name, c.sid);
    }
    const nextUrl = r.data.meta?.next_page_url || '';
    nextPath = nextUrl ? nextUrl.replace(/^https:\/\/content\.twilio\.com\/v1/i, '') : '';
  }
  return map;
}

async function postTwilioContentTemplate(payload) {
  const r = await twilioContentRequest('POST', '/Content', payload);
  if (r.status === 200 || r.status === 201) return String(r.data?.sid || '').trim();
  console.warn('[twilio-content] create template:', r.status, r.data);
  return '';
}

async function createReceiptQuickReplyTemplate() {
  const t1 = 'סיכום החזרים';
  const t2 = 'ביטול פעולה אחרונה';
  const payload = {
    friendly_name: CONTENT_FN_RECEIPT_QR,
    language: 'he',
    variables: { 1: 'אישור רישום' },
    types: {
      'twilio/text': {
        body: '{{1}}',
      },
      'twilio/quick-reply': {
        body: '{{1}}',
        actions: [
          { type: 'QUICK_REPLY', title: clipWhatsAppButtonTitle(t1, 20), id: QR_PAYLOAD_SUMMARY },
          { type: 'QUICK_REPLY', title: clipWhatsAppButtonTitle(t2, 20), id: QR_PAYLOAD_UNDO_LAST },
        ],
      },
    },
  };
  let sid = await postTwilioContentTemplate(payload);
  if (!sid) {
    const m = await fetchContentFriendlyNameToSid();
    sid = m.get(CONTENT_FN_RECEIPT_QR) || '';
  }
  return sid;
}

async function createCategoryListTemplate() {
  const payload = {
    friendly_name: CONTENT_FN_CATEGORY_LIST,
    language: 'he',
    types: {
      'twilio/text': {
        body: '*בחר קטגוריה להחזר*\n\nאחת מהרשימה צריכה להתאים לקבלה.',
      },
      'twilio/list-picker': {
        body: '*בחר קטגוריה להחזר*\n\nלחץ על הכפתור ובחר מהרשימה.',
        button: clipWhatsAppButtonTitle('בחר קטגוריה', 20),
        items: categoryListPickerItems(),
      },
    },
  };
  let sid = await postTwilioContentTemplate(payload);
  if (!sid) {
    const m = await fetchContentFriendlyNameToSid();
    sid = m.get(CONTENT_FN_CATEGORY_LIST) || '';
  }
  return sid;
}

async function createCategoryConfirmTemplate() {
  const payload = {
    friendly_name: CONTENT_FN_CATEGORY_CONFIRM,
    language: 'he',
    variables: { 1: 'שאלה' },
    types: {
      'twilio/quick-reply': {
        body: '{{1}}',
        actions: [
          {
            type: 'QUICK_REPLY',
            title: clipWhatsAppButtonTitle('כן', 20),
            id: QR_PAYLOAD_CAT_YES,
          },
          {
            type: 'QUICK_REPLY',
            title: clipWhatsAppButtonTitle('לא, בחר מחדש', 20),
            id: QR_PAYLOAD_CAT_NO,
          },
        ],
      },
    },
  };
  let sid = await postTwilioContentTemplate(payload);
  if (!sid) {
    const m = await fetchContentFriendlyNameToSid();
    sid = m.get(CONTENT_FN_CATEGORY_CONFIRM) || '';
  }
  return sid;
}

async function initializeWhatsAppContentTemplates() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  try {
    const byName = await fetchContentFriendlyNameToSid();
    if (!contentSidReceiptQr) contentSidReceiptQr = byName.get(CONTENT_FN_RECEIPT_QR) || '';
    if (!contentSidReceiptQr) contentSidReceiptQr = await createReceiptQuickReplyTemplate();
    if (!contentSidCategoryList) contentSidCategoryList = byName.get(CONTENT_FN_CATEGORY_LIST) || '';
    if (!contentSidCategoryList) contentSidCategoryList = await createCategoryListTemplate();
    if (!contentSidCategoryConfirm) contentSidCategoryConfirm = byName.get(CONTENT_FN_CATEGORY_CONFIRM) || '';
    if (!contentSidCategoryConfirm) contentSidCategoryConfirm = await createCategoryConfirmTemplate();
    console.log(
      '[config] Twilio Content SIDs:',
      contentSidReceiptQr ? `${contentSidReceiptQr.slice(0, 8)}…` : '(receipt QR off)',
      '|',
      contentSidCategoryList ? `${contentSidCategoryList.slice(0, 8)}…` : '(category list off)',
      '|',
      contentSidCategoryConfirm ? `${contentSidCategoryConfirm.slice(0, 8)}…` : '(cat confirm off)'
    );
  } catch (e) {
    console.warn('[twilio-content] initialize:', e.message);
  }
}

async function ensureWhatsAppContentTemplates() {
  if (!contentTemplatesInitPromise) {
    contentTemplatesInitPromise = initializeWhatsAppContentTemplates();
  }
  await contentTemplatesInitPromise;
}

async function sendWhatsAppContentMessage(waNorm, contentSid, variablesObj) {
  if (!twilioClient || !FROM_WHATSAPP_NUMBER || !waNorm || !contentSid) return false;
  const to = waNorm.startsWith('whatsapp:') ? waNorm : fmtWA(waNorm);
  try {
    const payload = {
      from: fmtWA(FROM_WHATSAPP_NUMBER),
      to,
      contentSid,
    };
    if (variablesObj && Object.keys(variablesObj).length > 0) {
      payload.contentVariables = JSON.stringify(variablesObj);
    }
    await twilioClient.messages.create(payload);
    console.log('[whatsapp] content outbound:', contentSid.slice(0, 12), '…');
    return true;
  } catch (e) {
    console.error('[whatsapp] content message failed:', e.message);
    return false;
  }
}

async function sendReceiptSuccessQuickReply(waNorm, confirmationBody) {
  await ensureWhatsAppContentTemplates();
  if (!contentSidReceiptQr) {
    await replyWhatsAppToUser(
      waNorm,
      `${confirmationBody}\n\n*מה הלאה?*\n• *סיכום* — ריכוז החודש\n• *מחק* — ביטול הרישום האחרון`
    );
    return;
  }
  const ok = await sendWhatsAppContentMessage(waNorm, contentSidReceiptQr, { 1: confirmationBody });
  if (!ok) await replyWhatsAppToUser(waNorm, confirmationBody);
}

/** Inbound rich messages: ButtonPayload / ButtonText / InteractiveData list_reply */
function parseInboundInteractive(req) {
  const btnPayload = String(req.body.ButtonPayload || '').trim();
  const btnText = String(req.body.ButtonText || '').trim();
  let listId = String(req.body.ListId || req.body.ListReplyId || '').trim();
  try {
    const raw = req.body.InteractiveData;
    if (raw) {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (j?.list_reply?.id) listId = listId || String(j.list_reply.id).trim();
      if (j?.ListReply?.id) listId = listId || String(j.ListReply.id).trim();
    }
  } catch (_) {
    /* ignore */
  }
  const idKey = listId || btnPayload;
  let categoryPayload = '';
  if (idKey && LIST_ITEM_ID_TO_CATEGORY[idKey]) categoryPayload = LIST_ITEM_ID_TO_CATEGORY[idKey];
  return { btnPayload, btnText, listId, categoryPayload };
}

// ===================== Google Sheets =====================

const SHEET_HEADERS_PREFERRED = [
  'Date',
  'Amount',
  'Category',
  'Topic',
  'SubmissionContact',
  'Drive_Link',
  'Status',
  'Notes',
  'User',
];

async function ensureHeaders(sheet) {
  await sheet.loadHeaderRow(1);
  const h = sheet.headerValues || [];
  if (h.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(SHEET_HEADERS_PREFERRED);
    return;
  }
  if (!h.includes('User')) {
    console.warn(
      '[sheet] הוסף עמודת "User" בשורת כותרות לסינון רב־משתמשים.'
    );
  }
}

function sheetNotes(row) {
  return String(getCol(row, 'Notes') || getCol(row, 'Description') || '').trim();
}

function sheetDriveLink(row) {
  return String(getCol(row, 'Drive_Link') || getCol(row, 'ReceiptImage') || '').trim();
}

function sheetStatusIsRefunded(row) {
  const st = String(getCol(row, 'Status') || '').trim();
  if (st && /refunded|הוחזר/i.test(st)) return true;
  if (String(getCol(row, 'Submitted') || '').trim() === 'Yes') return true;
  return false;
}

function rowHasReceiptAttachment(row) {
  if (sheetDriveLink(row)) return true;
  return String(getCol(row, 'Receipt') || '').trim() === 'Yes';
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

async function appendExpenseRow(notes, amount, category, driveLink, userValue, meta = {}) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return null;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const { date, time } = formatNow();
  const dl = (driveLink || '').trim();
  const topic = (meta.topic != null ? meta.topic : category) || '';
  const submissionContact = (meta.submissionContact || '').trim();
  const full = {
    Date: date,
    Amount: amount,
    Category: category,
    Topic: topic,
    SubmissionContact: submissionContact,
    Drive_Link: dl,
    Status: 'Pending',
    Notes: notes || '',
    User: userValue || '',
    Description: notes || '',
    Receipt: dl ? 'Yes' : 'No',
    Submitted: 'No',
    Time: time,
    ReceiptImage: dl,
  };
  const rowObj = {};
  for (const [k, v] of Object.entries(full)) {
    if (headers.includes(k)) rowObj[k] = v;
  }
  if (Object.keys(rowObj).length === 0) {
    console.error('[sheets] אין כותרות תואמות בשורה 1 — בדוק את הגיליון');
    return null;
  }
  const row = await sheet.addRow(rowObj);
  console.log('[sheets] Sheet row added:', row ? `rowNumber=${row.rowNumber}` : '(null)');
  return row;
}

async function hasDuplicateExpenseSameDay(ownerWaNorm, dateStr, amount, category) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
  if (!data) return false;
  const t = parseFloat(amount);
  if (Number.isNaN(t)) return false;
  const cat = String(category || '').trim();
  return data.rows.some(
    (r) =>
      r.date === dateStr &&
      Math.abs(r.amt - t) < 0.009 &&
      String(r.cat || '').trim() === cat
  );
}

async function duplicateExpenseWarningLine(ownerWaNorm, amount, category) {
  const { date } = formatNow();
  const hit = await hasDuplicateExpenseSameDay(ownerWaNorm, date, amount, category);
  return hit
    ? '\n\n*שים לב:* כבר קיים רישום עם אותו *תאריך*, *סכום* ו-*קטגוריה*. וודא שאין כפילות.'
    : '';
}

/** עדכון קישור דרייב + שדות ישנים (Receipt / ReceiptImage) לפי כותרות קיימות */
async function updateRowDriveAndLegacy(rowIndex, ownerWaNorm, driveLink) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return false;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const dl = (driveLink || '').trim();
  const updates = {};
  if (headers.includes('Drive_Link')) updates.Drive_Link = dl;
  if (headers.includes('ReceiptImage')) updates.ReceiptImage = dl;
  if (headers.includes('Receipt')) updates.Receipt = dl ? 'Yes' : 'No';
  if (Object.keys(updates).length === 0) return false;
  return updateMultipleFieldsByIndexForOwner(rowIndex, updates, ownerWaNorm);
}

async function updateRowReceiptFlagOnly(rowIndex, ownerWaNorm, hasReceipt) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return false;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  const updates = {};
  if (headers.includes('Receipt')) updates.Receipt = hasReceipt ? 'Yes' : 'No';
  if (Object.keys(updates).length === 0) return false;
  return updateMultipleFieldsByIndexForOwner(rowIndex, updates, ownerWaNorm);
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

async function getRowByIndexIfOwned(rowIndex, ownerWaNorm) {
  const row = await getRowByIndex(rowIndex);
  if (!row) return null;
  const u = getCol(row, 'User');
  if (!userCellMatchesOwner(u, ownerWaNorm)) {
    console.warn('[sheets] row', rowIndex, 'not owned by', ownerWaNorm);
    return null;
  }
  return row;
}

async function updateRowByIndexForOwner(rowIndex, field, value, ownerWaNorm) {
  try {
    const target = await getRowByIndexIfOwned(rowIndex, ownerWaNorm);
    if (!target) return false;
    if (typeof target.set === 'function') target.set(field, value);
    else target[field] = value;
    await target.save();
    console.log(`[sheets] row ${rowIndex} → ${field}=... (owner ok)`);
    return true;
  } catch (e) {
    console.error(`[sheets] updateRowByIndexForOwner(${rowIndex}) failed:`, e.message);
    return false;
  }
}

async function updateMultipleFieldsByIndexForOwner(rowIndex, updates, ownerWaNorm) {
  try {
    const target = await getRowByIndexIfOwned(rowIndex, ownerWaNorm);
    if (!target) return false;
    for (const [field, val] of Object.entries(updates)) {
      if (typeof target.set === 'function') target.set(field, val);
      else target[field] = val;
    }
    await target.save();
    console.log(`[sheets] row ${rowIndex} → updated (owner ok)`);
    return true;
  } catch (e) {
    console.error(`[sheets] updateMultipleForOwner(${rowIndex}) failed:`, e.message);
    return false;
  }
}

async function deleteRowByIndexForOwner(rowIndex, ownerWaNorm) {
  try {
    const target = await getRowByIndexIfOwned(rowIndex, ownerWaNorm);
    if (!target) return false;
    await target.delete();
    return true;
  } catch (e) {
    console.error(`[sheets] deleteRowByIndexForOwner(${rowIndex}) failed:`, e.message);
    return false;
  }
}

async function saveToSheet(description, amount, category, userSheetValue) {
  if (!category) return null;
  return appendExpenseRow(
    description,
    parseFloat(amount) || 0,
    category,
    '',
    userSheetValue || ''
  );
}

async function getRowsForMonth(targetYear, targetMonth, includeRaw, ownerWaNorm) {
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
    const userCell = getCol(row, 'User');
    if (ownerWaNorm && !userCellMatchesOwner(userCell, ownerWaNorm)) continue;
    const entry = {
      amt,
      cat: getCol(row, 'Category') || '',
      topic: getCol(row, 'Topic') || '',
      submissionContact: getCol(row, 'SubmissionContact') || '',
      desc: sheetNotes(row),
      receipt: rowHasReceiptAttachment(row) ? 'Yes' : 'No',
      submitted: sheetStatusIsRefunded(row) ? 'Yes' : 'No',
      date: getCol(row, 'Date'),
      time: getCol(row, 'Time'),
      receiptImage: sheetDriveLink(row),
      user: userCell,
    };
    if (includeRaw) entry.row = row;
    rows.push(entry);
  }
  return rows;
}

async function getCurrentMonthRows(includeRaw, ownerWaNorm) {
  const now = new Date();
  const rows = await getRowsForMonth(now.getFullYear(), now.getMonth(), includeRaw, ownerWaNorm);
  return rows ? { rows, curYear: now.getFullYear(), curMonth: now.getMonth() } : null;
}

async function sumAmountColumn(ownerWaNorm) {
  const doc = await getSpreadsheetDoc();
  if (!doc) return 0;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  let total = 0;
  for (const row of await sheet.getRows()) {
    if (ownerWaNorm && !userCellMatchesOwner(getCol(row, 'User'), ownerWaNorm)) continue;
    const n = parseFloat(getCol(row, 'Amount'));
    if (!Number.isNaN(n)) total += n;
  }
  return total;
}

// ===================== Submission & Receipt Logic =====================

async function getUnsubmittedRows(ownerWaNorm) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
  if (!data) return [];
  return data.rows.filter((r) => r.submitted !== 'Yes');
}

async function markAllCurrentMonthSubmitted(ownerWaNorm) {
  const data = await getCurrentMonthRows(true, ownerWaNorm);
  if (!data) return 0;
  const doc = await getSpreadsheetDoc();
  if (!doc) return 0;
  const sheet = doc.sheetsByIndex[0];
  await ensureHeaders(sheet);
  await sheet.loadHeaderRow(1);
  const headers = sheet.headerValues || [];
  let count = 0;
  for (const entry of data.rows) {
    if (!entry.row || sheetStatusIsRefunded(entry.row)) continue;
    if (headers.includes('Status')) await updateRowField(entry.row, 'Status', 'Refunded');
    if (headers.includes('Submitted')) await updateRowField(entry.row, 'Submitted', 'Yes');
    count++;
  }
  return count;
}

async function getMissingReceiptRows(ownerWaNorm) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
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
    lines.push(`החודש רשמת *${Math.abs(diff)}%* ${direction} על ${cat} לעומת ${prevMonthName} — עין חדה 🕵️‍♂️`);
  }
  return lines.join('\n');
}

async function getPrevMonthData(ownerWaNorm) {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() - 1;
  if (m < 0) { m = 11; y--; }
  const rows = await getRowsForMonth(y, m, false, ownerWaNorm);
  return { totals: rows ? buildCategoryTotals(rows) : new Map(), monthName: HEB_MONTHS[m] };
}

// ===================== Summary & Stats =====================

const HEB_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

function formatShekelDisplay(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return '0';
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '');
}

function sumCategoryTotalsMap(totalsMap) {
  if (!totalsMap || typeof totalsMap.values !== 'function') return 0;
  let s = 0;
  for (const v of totalsMap.values()) s += v;
  return s;
}

/**
 * Last 2 calendar months: category totals + row counts (for comparisons).
 */
async function fetchTwoMonthCategoryAggregates(ownerWaNorm) {
  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth();
  let py = cy;
  let pm = cm - 1;
  if (pm < 0) {
    pm = 11;
    py -= 1;
  }
  const curRows = (await getRowsForMonth(cy, cm, false, ownerWaNorm)) || [];
  const prevRows = (await getRowsForMonth(py, pm, false, ownerWaNorm)) || [];
  return {
    prevMonthName: HEB_MONTHS[pm],
    curByCategory: buildCategoryTotals(curRows),
    prevByCategory: buildCategoryTotals(prevRows),
    curRows,
  };
}

/** השוואה חודשית — שורה אחת, בלי רעש */
function formatMoMTotalInsight(curTotal, prevTotal, prevMonthName) {
  if (prevTotal <= 0) {
    if (curTotal <= 0) return 'אין עדיין סכום מצטבר החודש.';
    return 'חודש ראשון עם סכום מסודר ברשומות.';
  }
  const pct = Math.round(((curTotal - prevTotal) / prevTotal) * 100);
  if (pct === 0) return `באותו סדר גודל כמו *${prevMonthName}*.`;
  if (pct > 0) return `*${pct}%* מעל *${prevMonthName}*.`;
  return `*${Math.abs(pct)}%* מתחת ל-*${prevMonthName}*.`;
}

/** שורת הקשר אחרי הדשבורד — קטגוריה מובילה */
function savvyDeepInsightTopCategory(topCategory, topAmount, grandTotal) {
  if (!topCategory || grandTotal <= 0) return '';
  const share = Math.max(1, Math.round((topAmount / grandTotal) * 100));
  return `הקטגוריה הבולטת: *${topCategory}* — כ-*${share}%* מסך ההחזרים החודש.`;
}

function buildSubmissionContactTotals(rows) {
  const m = new Map();
  for (const r of rows) {
    const key = (r.submissionContact || '').trim() || 'ללא איש קשר להגשה';
    m.set(key, (m.get(key) || 0) + r.amt);
  }
  return m;
}

function savvyDeepInsightTopContact(topLabel, topAmount, grandTotal) {
  if (!topLabel || grandTotal <= 0) return '';
  const share = Math.max(1, Math.round((topAmount / grandTotal) * 100));
  return `רוב הסכום מרוכז אצל *${topLabel}* — *${share}%* מהחודש.`;
}

/** סיכום חודשי מקובץ לפי איש קשר + הוצאות בפועל מול החזרים משוערים (לפי תקרות ב־kibbutzData) */
function formatMonthlySummaryBySubmissionContact(monthName, rows, footnoteLines = []) {
  let actualGrand = 0;
  let potentialGrand = 0;
  for (const r of rows) {
    actualGrand += r.amt;
    potentialGrand += potentialRefundForAmountAndTopic(r.amt, (r.topic || r.cat || '').trim());
  }

  const byContact = new Map();
  for (const r of rows) {
    const key = (r.submissionContact || '').trim() || 'ללא איש קשר להגשה';
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key).push(r);
  }
  const body = [];
  body.push(`*ריכוז החזרים - ${monthName}*`);
  body.push('');
  body.push(UI_DIV);
  body.push('');
  if (!rows.length) {
    body.push('אין רישומים החודש.');
  } else {
    const sortedKeys = [...byContact.keys()].sort((a, b) => {
      const sumA = byContact.get(a).reduce((s, x) => s + x.amt, 0);
      const sumB = byContact.get(b).reduce((s, x) => s + x.amt, 0);
      return sumB - sumA;
    });
    for (const key of sortedKeys) {
      const list = byContact.get(key);
      body.push(`*להגשה מול ${key}:*`);
      for (const r of list) {
        const label = ((r.topic || r.cat || r.desc || '(ללא תיאור)') + '').trim();
        body.push(`• ${label} — *${formatShekelDisplay(r.amt)}* ש״ח`);
      }
      body.push('');
    }
  }
  body.push(UI_DIV);
  body.push('');
  body.push(`*סה״כ הוצאות שנרשמו:* *${formatShekelDisplay(actualGrand)}* ש"ח`);
  body.push(`*סה״כ החזרים משוערים (לפי תקרות):* *${formatShekelDisplay(potentialGrand)}* ש"ח`);
  for (const line of footnoteLines) {
    if (line) {
      body.push('');
      body.push(line);
    }
  }
  return body.join('\n');
}

const QUICKCHART_BASE = 'https://quickchart.io/chart';

/** פלטת פסטל לעד 11 פרוסות */
const MONTHLY_DOUGHNUT_PASTELS = [
  '#FFB5C2', '#B5D8FF', '#C9F2C7', '#FFE4A8', '#D4C4F5', '#FFD4A3', '#A8E6E3', '#E8B5D1',
  '#C4E8F5', '#D9F0C4', '#F5E6B8',
];

function summaryChartCaptionShekels(totalDisplay) {
  return `פילוח לפי קטגוריה · סה״כ *${totalDisplay}* ש״ח`;
}

function summaryChartCaptionContacts(totalDisplay) {
  return `פילוח לפי איש קשר להגשה · סה״כ *${totalDisplay}* ש״ח`;
}

/** One-time PNG blobs for Twilio MediaUrl when PUBLIC_WEBHOOK_BASE is set */
const chartPngOneShot = new Map();

/**
 * QuickChart Chart.js v2 config as JavaScript source (not JSON) so datalabels formatter works.
 * Design: doughnut, bottom legend (Varela Round + Hebrew fallback), title, white % inside slices.
 */
function buildMonthlySummaryDoughnutChartJs(entries) {
  const labelsJson = entries.map(([c]) => JSON.stringify(c)).join(',');
  const dataStr = entries.map(([, a]) => a).join(',');
  const bgStr = entries
    .map((_, i) => JSON.stringify(MONTHLY_DOUGHNUT_PASTELS[i % MONTHLY_DOUGHNUT_PASTELS.length]))
    .join(',');
  const titleStr = JSON.stringify('ריכוז החזרים');
  return `{type:'doughnut',data:{labels:[${labelsJson}],datasets:[{data:[${dataStr}],backgroundColor:[${bgStr}],borderWidth:2,borderColor:'#ffffff'}]},options:{cutoutPercentage:62,legend:{position:'bottom',rtl:true,labels:{fontFamily:'Varela Round, Noto Sans Hebrew',fontColor:'#334155',fontSize:12,padding:14,usePointStyle:true,boxWidth:10}},title:{display:true,text:${titleStr},fontFamily:'Varela Round, Noto Sans Hebrew',fontSize:17,fontColor:'#0f172a',fontStyle:'bold',padding:18},plugins:{datalabels:{display:true,color:'#ffffff',font:{weight:'bold',size:15,family:'Varela Round, Noto Sans Hebrew, Arial'},textStrokeColor:'rgba(15,23,42,0.35)',textStrokeWidth:2,formatter:(value,ctx)=>{var arr=ctx.dataset.data,s=0,i;for(i=0;i<arr.length;i++)s+=arr[i];if(!s)return'';var p=Math.round((value/s)*100);return p<4?'':(p+'%');}}}}}`;
}

async function fetchQuickChartPngBuffer(chartJsString) {
  const r = await axios.post(
    QUICKCHART_BASE,
    {
      chart: chartJsString,
      width: 720,
      height: 720,
      backgroundColor: 'white',
      devicePixelRatio: 1,
      format: 'png',
      version: '2.9.4',
    },
    {
      responseType: 'arraybuffer',
      timeout: 35000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );
  if (r.status !== 200 || !r.data) {
    throw new Error(`QuickChart POST ${r.status}`);
  }
  const buf = Buffer.from(r.data);
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('QuickChart response is not PNG');
  }
  return buf;
}

function registerChartPngOneShotUrl(buffer) {
  if (!PUBLIC_WEBHOOK_BASE || !buffer?.length) return null;
  const token = crypto.randomBytes(20).toString('hex');
  chartPngOneShot.set(token, { buffer, created: Date.now() });
  setTimeout(() => chartPngOneShot.delete(token), 120000);
  return `${PUBLIC_WEBHOOK_BASE}/__media/chart/${token}`;
}

async function sendMonthlySummaryChartToWhatsApp(waNorm, categoryTotalsMap, totalShekels, captionOverride) {
  const map = categoryTotalsMap && typeof categoryTotalsMap.entries === 'function' ? categoryTotalsMap : new Map();
  const entries = [...map.entries()]
    .filter(([, amt]) => amt > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return;

  const chartJs = buildMonthlySummaryDoughnutChartJs(entries);
  const caption =
    captionOverride ||
    summaryChartCaptionShekels(formatShekelDisplay(totalShekels));

  try {
    const png = await fetchQuickChartPngBuffer(chartJs);
    const hosted = registerChartPngOneShotUrl(png);
    if (hosted) {
      const ok = await replyWhatsAppWithMedia(waNorm, [hosted], caption);
      if (ok) return;
    }
  } catch (e) {
    console.warn('[quickchart] POST chart failed:', e.message);
  }

  try {
    const getUrl = `${QUICKCHART_BASE}?c=${encodeURIComponent(chartJs)}&w=720&h=720&bkg=white&v=2.9.4&devicePixelRatio=1`;
    if (getUrl.length < 7900) {
      const ok = await replyWhatsAppWithMedia(waNorm, [getUrl], caption);
      if (ok) return;
    }
  } catch (e2) {
    console.warn('[quickchart] GET chart URL failed:', e2.message);
  }

  await replyWhatsAppToUser(
    waNorm,
    'הגרף לא נטען הפעם — הסכומים בהודעה הקודמת נשארים תקפים.'
  );
}

/**
 * First line: required headline + MoM + insight. Second message: chart (downloaded PNG path or QuickChart URL).
 */
function formatMonthlyDashboardBody(monthName, categoryTotalsMap, totalShekels, footnoteLines = []) {
  const sorted = [...categoryTotalsMap.entries()].sort((a, b) => b[1] - a[1]);
  const body = [];
  body.push(`*ריכוז החזרים - ${monthName}*`);
  body.push('');
  body.push(UI_DIV);
  body.push('');
  if (sorted.length === 0) {
    body.push('אין רישומים החודש.');
  } else {
    sorted.forEach(([cat, sum], i) => {
      body.push(`(${i + 1}) ${cat} — *${formatShekelDisplay(sum)}* ש״ח`);
    });
  }
  body.push('');
  body.push(UI_DIV);
  body.push('');
  body.push(`*סה״כ מחכה לך:* *${formatShekelDisplay(totalShekels)}* ש״ח`);
  for (const line of footnoteLines) {
    if (line) {
      body.push('');
      body.push(line);
    }
  }
  return body.join('\n');
}

async function buildVisualSummaryPackage(ownerWaNorm) {
  const agg = await fetchTwoMonthCategoryAggregates(ownerWaNorm);
  if (!agg) return null;

  const now = new Date();
  const monthName = HEB_MONTHS[now.getMonth()];
  const curTotal = sumCategoryTotalsMap(agg.curByCategory);
  const prevTotal = sumCategoryTotalsMap(agg.prevByCategory);
  const comparison = formatMoMTotalInsight(curTotal, prevTotal, agg.prevMonthName);

  const contactTotalsMap = buildSubmissionContactTotals(agg.curRows);

  if (agg.curRows.length === 0 || curTotal <= 0) {
    return {
      firstMessage: formatMonthlySummaryBySubmissionContact(monthName, [], [comparison]),
      chartUrl: null,
      categoryTotals: contactTotalsMap,
      chartCaption: summaryChartCaptionContacts(formatShekelDisplay(0)),
    };
  }

  const sortedC = [...contactTotalsMap.entries()].sort((a, b) => b[1] - a[1]);
  const [topContact, topCAmt] = sortedC[0] || ['', 0];
  const deep = savvyDeepInsightTopContact(topContact, topCAmt, curTotal);

  const firstMessage = formatMonthlySummaryBySubmissionContact(monthName, agg.curRows, [
    comparison,
    deep,
  ]);

  return {
    firstMessage,
    categoryTotals: contactTotalsMap,
    chartCaption: summaryChartCaptionContacts(formatShekelDisplay(curTotal)),
  };
}

async function sendVisualMonthlySummary(res, waNorm) {
  const pkg = await buildVisualSummaryPackage(waNorm);
  if (!pkg) {
    sendTwiML(res, 'אופס, לא הצלחתי לקרוא את השיטס. נסה שוב?');
    return;
  }
  sendTwiML(res, pkg.firstMessage);
  const totalsMap = pkg.categoryTotals && typeof pkg.categoryTotals.entries === 'function' ? pkg.categoryTotals : new Map();
  const chartTotal = sumCategoryTotalsMap(totalsMap);
  await sendMonthlySummaryChartToWhatsApp(waNorm, totalsMap, chartTotal, pkg.chartCaption);
}

const SUMMARY_FOOTERS = [
  'שמירת קבלות עוזרת לסגור החזרים בלי בלבול.',
  'רישום קבוע = פחות כסף ״תלוי באוויר״.',
  'יש ספק בקטגוריה? בוחרים מהרשימה — לא מנחשים.',
];

async function buildMonthlySummary(ownerWaNorm) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
  if (!data) return null;
  const { rows, curMonth } = data;
  const monthName = HEB_MONTHS[curMonth];

  let noReceipt = 0;
  let notSubmitted = 0;
  for (const r of rows) {
    if (r.receipt !== 'Yes') noReceipt++;
    if (r.submitted !== 'Yes') notSubmitted++;
  }

  const grandTotal = rows.reduce((s, r) => s + r.amt, 0);

  const footnotes = [];
  try {
    const prev = await getPrevMonthData(ownerWaNorm);
    const mom = momLine(buildCategoryTotals(rows), prev.totals, prev.monthName);
    if (mom) footnotes.push(mom);
  } catch (_) {}
  if (noReceipt > 0) footnotes.push(`*לתשומת לב:* ${noReceipt} רישומים בלי קבלה בדרייב.`);
  if (notSubmitted > 0) {
    footnotes.push(`*סטטוס:* ${notSubmitted} רישומים עדיין לא סומנו כהוגשו.`);
  }
  footnotes.push(SUMMARY_FOOTERS[Math.floor(Math.random() * SUMMARY_FOOTERS.length)]);

  if (rows.length === 0) {
    return (
      `*ריכוז החזרים - ${monthName}*\n\nאין עדיין רישומים החודש.\n\nשלח *סכום + תיאור* כדי להתחיל.`
    );
  }

  return formatMonthlySummaryBySubmissionContact(monthName, rows, footnotes);
}

async function buildMonthlyStats(ownerWaNorm) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
  if (!data) return null;
  const { rows, curMonth } = data;
  const monthName = HEB_MONTHS[curMonth];

  if (rows.length === 0) return 'אין עדיין מספיק רישומים לניתוח. הוסף עוד החזרים ונסה שוב.';

  const categoryTotals = buildCategoryTotals(rows);
  let grandTotal = 0;
  for (const v of categoryTotals.values()) grandTotal += v;

  const sorted = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
  const [topCat, topAmt] = sorted[0];
  const topPct = grandTotal > 0 ? Math.round((topAmt / grandTotal) * 100) : 0;

  const lines = [];
  lines.push(`*ניתוח החזרים - ${monthName}*`);
  lines.push(UI_DIV);
  lines.push(`הקטגוריה הבולטת: *${topCat}* — *${formatShekelDisplay(topAmt)}* ש״ח (${topPct}% מהחודש).`);
  lines.push('');
  lines.push(`*${rows.length}* רישומים · סה״כ *${formatShekelDisplay(grandTotal)}* ש״ח`);

  if (sorted.length > 1) {
    lines.push('');
    lines.push('*פירוט לפי קטגוריה:*');
    for (const [cat, amt] of sorted) {
      const pct = Math.round((amt / grandTotal) * 100);
      const bar = '█'.repeat(Math.max(1, Math.round(pct / 5)));
      lines.push(`${bar} ${cat}: ${formatShekelDisplay(amt)} ש״ח (${pct}%)`);
    }
  }

  try {
    const prev = await getPrevMonthData(ownerWaNorm);
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
const DELETE_FLOW_TTL_MS = 2 * 60 * 1000;
const DAILY_PROMPT_TTL_MS = 4 * 60 * 60 * 1000;
const MANAGEMENT_TTL_MS = 10 * 60 * 1000;

const MANAGEMENT_STATES = new Set([
  'MANAGEMENT_SELECTING',
  'MANAGEMENT_EDIT_MENU',
  'MANAGEMENT_AWAITING_NEW_AMOUNT',
  'MANAGEMENT_AWAITING_NEW_DESC',
  'MANAGEMENT_AWAITING_RECEIPT_EDIT',
]);

const DELETE_FLOW_STATES = new Set(['AWAITING_DELETE_SELECTION', 'AWAITING_DELETE_CONFIRM']);

/** מצבים שבהם לא פותחים זרימת מחיקה מלאה מתוך הודעת "מחק"/"טעות" */
const EXPENSE_INTERACTIVE_STATES = new Set([
  'AWAITING_DESCRIPTION',
  'AWAITING_AMOUNT',
  'AWAITING_HIGH_CONFIRM',
  'AWAITING_RECEIPT_IMAGE',
  'AWAITING_EXPENSE_DETAILS',
  'AWAITING_CATEGORY_CLARIFICATION',
  'AWAITING_CATEGORY_CONFIRM',
  'AWAITING_KIBBUTZ_DISAMBIG',
  'AWAITING_DAILY_REPLY',
]);

/**
 * States:
 *   IDLE, AWAITING_DESCRIPTION, AWAITING_AMOUNT, AWAITING_HIGH_CONFIRM,
 *   AWAITING_RECEIPT_IMAGE  — text-first: waiting for image or כן/לא (5 min)
 *   AWAITING_EXPENSE_DETAILS — image-first: waiting for text (amount+desc)
 *   AWAITING_CATEGORY_CLARIFICATION — רשימת 11 קטגוריות
 *   AWAITING_CATEGORY_CONFIRM — אישור קטגוריה אחרי זיהוי אוטומטי
 *   AWAITING_DAILY_REPLY
 *   AWAITING_DELETE_SELECTION / AWAITING_DELETE_CONFIRM — guided delete (2 min TTL)
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
  if (DELETE_FLOW_STATES.has(session.state)) return Date.now() - session.ts > DELETE_FLOW_TTL_MS;
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

function clearDeleteFlow(phone) {
  const us = userState[phone];
  if (!us) return;
  delete us.deleteCandidates;
  delete us.pendingDelete;
  delete us.pendingDeleteIndex;
  delete us.status;
  delete us.deleteFlowTs;
}

/** Last N expense rows of current month (newest first). Requires includeRaw rows. */
async function getRecentMonthEntriesForDelete(limit = 10, ownerWaNorm) {
  const data = await getCurrentMonthRows(true, ownerWaNorm);
  if (!data || data.rows.length === 0) return [];
  const take = Math.min(Math.min(limit, 10), data.rows.length);
  const slice = data.rows.slice(-take).reverse();
  const out = [];
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    const sheetRowNumber = r.row ? r.row.rowNumber : null;
    if (!sheetRowNumber) continue;
    out.push({
      displayIndex: i + 1,
      sheetRowNumber,
      desc: r.desc || '',
      amt: r.amt,
      receiptImage: (r.receiptImage || '').trim(),
      date: r.date || '',
    });
  }
  return out;
}

async function startDeleteSelectionFlow(res, phone, waNorm) {
  const items = await getRecentMonthEntriesForDelete(10, waNorm);
  const us = getUserState(phone);
  if (items.length === 0) {
    clearDeleteFlow(phone);
    console.log('[delete] no rows to delete for', phone);
    sendTwiML(res, 'אין רישומים למחיקה החודש.');
    return;
  }
  console.log('[delete] selection list shown', phone, 'count=', items.length);
  us.deleteCandidates = items;
  us.status = 'AWAITING_DELETE_SELECTION';
  us.deleteFlowTs = Date.now();
  const s = getSession(phone);
  s.state = 'AWAITING_DELETE_SELECTION';
  s.ts = Date.now();
  const lines = [
    `*מחיקה*\n\nעד *${items.length}* רישומים אחרונים — שלח *מספר שורה* למחיקה:`,
    '',
  ];
  for (const it of items) {
    lines.push(`${it.displayIndex}. ${it.desc} — *${it.amt} ₪*`);
  }
  lines.push('', '*(תוקף 2 דק׳)* שלח *ביטול* לביטול.');
  sendTwiML(res, lines.join('\n'));
}

function formatEditRowDetails(entry) {
  return `${entry.date} | ${entry.desc} | *${entry.amt} ₪*`;
}

function editMenuPrompt(entry) {
  return `בחרת ב: ${formatEditRowDetails(entry)}.\nמה תרצה לעשות?\n(מחק / סכום חדש / תיאור חדש / שלח קבלה / ביטול)`;
}

async function refreshManagementEditSnapshot(phone, waNorm) {
  const us = getUserState(phone);
  const rowNum = us.managementEditRow?.sheetRowNumber;
  if (!rowNum) return null;
  const row = await getRowByIndexIfOwned(rowNum, waNorm);
  if (!row) return null;
  const entry = {
    sheetRowNumber: rowNum,
    date: getCol(row, 'Date'),
    desc: sheetNotes(row),
    amt: parseFloat(getCol(row, 'Amount')) || 0,
    receiptImage: sheetDriveLink(row),
  };
  us.managementEditRow = entry;
  return entry;
}

async function buildAndSendManagementList(res, phone, waNorm) {
  const data = await getCurrentMonthRows(true, waNorm);
  if (!data || data.rows.length === 0) {
    sendTwiML(res, 'אין רישומים לחודש הזה. שלח *סכום + תיאור* כדי להתחיל.');
    return;
  }

  const items = [];
  const header = `*ניהול החזרים — ${HEB_MONTHS[data.curMonth]}*\n\nשלח מספר שורה לעריכה (תוקף 10 דק׳):\n`;

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

async function saveFullRow(phone, userSheetValue, amount, desc, category, driveLink, meta = {}) {
  const row = await appendExpenseRow(
    desc,
    amount,
    category,
    (driveLink || '').trim(),
    userSheetValue,
    meta
  );
  const rowIndex = row ? row.rowNumber : null;
  console.log(`[sheets] saved row ${rowIndex} for ${phone}`);
  const us = getUserState(phone);
  us.lastRowIndex = rowIndex;
  us.lastRowTs = Date.now();
  return rowIndex;
}

async function beginCategoryConfirmFlow(res, waNorm, phone, userSheetValue, pick, suggestedCategory, opts = {}) {
  const useOutboundApi = !!opts.useOutboundApi;
  const s = getSession(phone);
  s.state = 'AWAITING_CATEGORY_CONFIRM';
  s.pendingCategoryPick = { ...pick, userSheetValue };
  s.pendingSuggestedCategory = suggestedCategory;
  s.ts = Date.now();
  await ensureWhatsAppContentTemplates();
  const line = `לשייך ל-*${suggestedCategory}*?`;
  if (contentSidCategoryConfirm && waNorm) {
    const ok = await sendWhatsAppContentMessage(waNorm, contentSidCategoryConfirm, { 1: line });
    if (ok) {
      if (!useOutboundApi && res && !res.headersSent) emptyTwiMLResponse(res);
      return;
    }
  }
  const fallback = `${line}\n\n*כן* / *לא*, או הכפתורים למטה.`;
  if (useOutboundApi && waNorm) await replyWhatsAppToUser(waNorm, fallback);
  else if (res && !res.headersSent) sendTwiML(res, fallback);
}

/** כמה נושאים אפשריים — בוחרים במספר או בשם */
async function startKibbutzDisambiguation(
  res,
  phone,
  waNorm,
  userSheetValue,
  pick,
  lower,
  matches,
  mode,
  opts = {}
) {
  const useOutboundApi = !!opts.useOutboundApi;
  const twimlAlreadyEmpty = !!opts.twimlAlreadyEmpty;
  void userSheetValue;
  void lower;
  resetSession(phone);
  const s = getSession(phone);
  s.state = 'AWAITING_KIBBUTZ_DISAMBIG';
  s.kibbutzDisambig = {
    mode,
    pendingPick: pick,
    matches: matches.map((e) => serializeDisambigEntry(e)),
  };
  s.ts = Date.now();
  const lines = ['*מצאתי כמה נושאים רלוונטיים:*', ''];
  matches.forEach((e, i) => lines.push(`(${i + 1}) *${e.topic}*`));
  lines.push(
    '',
    `במה מעניין אותך? שלח *מספר* (1–${matches.length}) או חלק מ*שם הנושא*.`,
    '',
    '*ביטול* ליציאה.'
  );
  const msg = lines.join('\n');
  if (useOutboundApi && waNorm) {
    if (!twimlAlreadyEmpty && res && !res.headersSent) emptyTwiMLResponse(res);
    await replyWhatsAppToUser(waNorm, msg);
  } else if (res && !res.headersSent) {
    sendTwiML(res, msg);
  }
  return true;
}

/** שמירה + תשובה אחרי זיהוי נושא יחיד מ־kibbutzData */
async function completeSmartExpenseFromKibbutzEntry(res, phone, waNorm, userSheetValue, pick, entry, opts = {}) {
  const useOutboundApi = !!opts.useOutboundApi;
  const twimlAlreadyEmpty = !!opts.twimlAlreadyEmpty;
  const amount = pick.amount;
  const desc = (pick.desc || '').trim();
  const topic = entry.topic;
  const contact =
    (entry.contact && String(entry.contact).trim()) || extractSubmissionContacts(entry.answer || '');
  const lim = Number(entry.limit);
  const refund = estimatedRefund(amount, lim);
  const refundDisp = formatShekelDisplay(refund);
  const limitDisp = Number.isFinite(lim) && lim > 0 ? formatShekelDisplay(lim) : '—';
  const capNote = capNoteFromEntry(amount, entry);
  const dupLine = await duplicateExpenseWarningLine(waNorm, amount, topic);
  const receiptImage = (pick.receiptImage || '').trim();

  if (amount > HIGH_AMOUNT_THRESHOLD) {
    resetSession(phone);
    const s = getSession(phone);
    s.state = 'AWAITING_HIGH_CONFIRM';
    s.pendingAmount = amount;
    s.pendingDesc = desc;
    s.pendingCategory = topic;
    s.pendingDriveLink = receiptImage;
    s.pendingKibbutzSmartSnapshot = JSON.stringify({
      topic: entry.topic,
      limit: entry.limit,
      contact,
      answer: entry.answer || '',
    });
    s.ts = Date.now();
    const msg = `*אישור סכום*\n\nהסכום *${formatShekelDisplay(amount)}* ש״ח גבוה מהרגיל.\n\n*נכון?* השב *כן* או *לא*.`;
    if (useOutboundApi && waNorm) await replyWhatsAppToUser(waNorm, msg);
    else if (res && !res.headersSent) sendTwiML(res, msg);
    return true;
  }

  try {
    const rowIdx = await saveFullRow(phone, userSheetValue, amount, desc, topic, receiptImage, {
      topic,
      submissionContact: contact,
    });
    resetSession(phone);
    const builtReply = buildSmartLogReply({
      amountDisplay: formatShekelDisplay(amount),
      limitDisplay: limitDisp,
      refundDisplay: refundDisp,
      topic,
      contact,
      capNote,
      dupSuffix: dupLine,
    });
    let reply =
      opts.overrideReply != null && String(opts.overrideReply).trim()
        ? String(opts.overrideReply).trim()
        : builtReply;
    if (opts.overrideReply != null && String(opts.overrideReply).trim() && dupLine) {
      reply += dupLine;
    }
    if (receiptImage) {
      if (!twimlAlreadyEmpty && res && !res.headersSent) emptyTwiMLResponse(res);
      await sendReceiptSuccessQuickReply(waNorm, reply);
      return true;
    }
    if (useOutboundApi && waNorm) await replyWhatsAppToUser(waNorm, reply);
    else if (res && !res.headersSent) sendTwiML(res, reply);
    const ns = getSession(phone);
    ns.state = 'AWAITING_RECEIPT_IMAGE';
    ns.receiptRowIndex = rowIdx;
    ns.ts = Date.now();
    return true;
  } catch (e) {
    console.error('[smart-kibbutz] append failed:', e.message);
    if (useOutboundApi && waNorm) await replyWhatsAppToUser(waNorm, 'שגיאה בשמירה, נסה שוב');
    else if (res && !res.headersSent) sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
    return true;
  }
}

/** תשובת Gemini (עברית) + רישום הוצאה לגיליון כש־log_expense */
async function applyGeminiWhatsAppResult(res, phone, waNorm, userSheetValue, g, userTrimmed) {
  const fallbackClarify =
    'הממ… לא הבנתי לגמרי 😅 תוכל לכתוב שוב בקצרה? (סכום + על מה, או שאלה על החזר)';
  const replySafe =
    g && typeof g.reply === 'string' && g.reply.trim() ? g.reply.trim() : fallbackClarify;

  if (!g || !g.log_expense) {
    sendTwiML(res, replySafe);
    return;
  }

  const amount = Number(g.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    sendTwiML(res, replySafe);
    return;
  }

  const desc = (g.expense_description || userTrimmed || '').trim() || '(ללא תיאור)';
  const hayLower = `${desc} ${userTrimmed}`.toLowerCase();
  const matches = findKibbutzMatches(desc.toLowerCase(), hayLower);

  let entry = null;
  if (g.topic && String(g.topic).trim()) {
    entry = kibbutzData.find((e) => e.topic === String(g.topic).trim()) || null;
  }
  if (!entry && matches.length === 1) entry = matches[0];
  if (!entry && matches.length > 1) {
    const pick = {
      amount,
      desc,
      userSheetValue,
      receipt: 'No',
      receiptImage: '',
    };
    await startKibbutzDisambiguation(res, phone, waNorm, userSheetValue, pick, hayLower, matches, 'expense', {});
    return;
  }

  if (entry) {
    await completeSmartExpenseFromKibbutzEntry(
      res,
      phone,
      waNorm,
      userSheetValue,
      { amount, desc, userSheetValue, receipt: 'No', receiptImage: '' },
      entry,
      { overrideReply: replySafe }
    );
    return;
  }

  const cat = matchCategory(desc) || (g.topic && String(g.topic).trim()) || 'שונות';
  const contact = (g.submission_contact && String(g.submission_contact).trim()) || '';

  const dupLine = await duplicateExpenseWarningLine(waNorm, amount, cat);

  if (amount > HIGH_AMOUNT_THRESHOLD) {
    resetSession(phone);
    const s = getSession(phone);
    s.state = 'AWAITING_HIGH_CONFIRM';
    s.pendingAmount = amount;
    s.pendingDesc = desc;
    s.pendingCategory = cat;
    s.pendingDriveLink = '';
    s.pendingKibbutzSmartSnapshot = '';
    s.ts = Date.now();
    sendTwiML(
      res,
      `${replySafe}\n\n*אישור סכום*\n\nהסכום *${formatShekelDisplay(amount)}* ש״ח גבוה מהרגיל.\n\n*נכון?* השב *כן* או *לא*.`
    );
    return;
  }

  try {
    const rowIdx = await saveFullRow(phone, userSheetValue, amount, desc, cat, '', {
      topic: (g.topic && String(g.topic).trim()) || cat,
      submissionContact: contact,
    });
    resetSession(phone);
    sendTwiML(res, `${replySafe}${dupLine}`);
    const ns = getSession(phone);
    ns.state = 'AWAITING_RECEIPT_IMAGE';
    ns.receiptRowIndex = rowIdx;
    ns.ts = Date.now();
  } catch (e) {
    console.error('[gemini] save failed:', e.message);
    sendTwiML(res, 'אופס, משהו נתקע בשמירה 🙏 נסה שוב בעוד רגע?');
  }
}

/** שאילתת מידע בלי סכום — תשובה מלאה או בירור */
async function tryHandleKibbutzInquiry(res, phone, waNorm, userSheetValue, lower) {
  const matches = findKibbutzMatches('', lower);
  if (matches.length === 0) return false;
  if (matches.length === 1) {
    sendTwiML(res, formatKibbutzKnowledgeAnswer(matches[0].answer));
    return true;
  }
  return startKibbutzDisambiguation(
    res,
    phone,
    waNorm,
    userSheetValue,
    null,
    lower,
    matches,
    'inquiry',
    {}
  );
}

/** רישום מיידי לפי kibbutzData — דילוג על אישור קטגוריה */
async function tryProceedSmartKibbutzExpense(res, phone, waNorm, userSheetValue, pick, lower, opts = {}) {
  const desc = (pick.desc || '').trim();
  const matches = findKibbutzMatches(desc.toLowerCase(), lower);
  if (matches.length === 0) return false;
  if (matches.length > 1) {
    return startKibbutzDisambiguation(
      res,
      phone,
      waNorm,
      userSheetValue,
      pick,
      lower,
      matches,
      'expense',
      opts
    );
  }
  return completeSmartExpenseFromKibbutzEntry(res, phone, waNorm, userSheetValue, pick, matches[0], opts);
}

async function proceedAfterCategoryConfirmed(res, phone, waNorm, userSheetValue, pick, category) {
  const amount = pick.amount;
  const desc = pick.desc;
  const receiptImage = (pick.receiptImage || '').trim();
  const dupLine = await duplicateExpenseWarningLine(waNorm, amount, category);

  if (amount > HIGH_AMOUNT_THRESHOLD) {
    resetSession(phone);
    const s = getSession(phone);
    s.state = 'AWAITING_HIGH_CONFIRM';
    s.pendingAmount = amount;
    s.pendingDesc = desc;
    s.pendingCategory = category;
    s.pendingDriveLink = receiptImage;
    s.ts = Date.now();
    sendTwiML(
      res,
      `*אישור סכום*\n\nהסכום *${formatShekelDisplay(amount)}* ש״ח גבוה מהרגיל.\n\n*נכון?* השב *כן* או *לא*.`
    );
    return;
  }

  try {
    const rowIdx = await saveFullRow(phone, userSheetValue, amount, desc, category, receiptImage);
    const { date } = formatNow();
    const card = buildSuccessRecordCard(amount, category, date, {
      duplicateAppend: dupLine,
      awaitingReceipt: !receiptImage,
    });
    resetSession(phone);
    if (receiptImage) {
      emptyTwiMLResponse(res);
      await sendReceiptSuccessQuickReply(waNorm, card);
      return;
    }
    sendTwiML(res, card);
    const ns = getSession(phone);
    ns.state = 'AWAITING_RECEIPT_IMAGE';
    ns.receiptRowIndex = rowIdx;
    ns.ts = Date.now();
  } catch (e) {
    console.error('[sheets] append failed:', e.message);
    sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
  }
}

const QUICK_UNDO_TTL_MS = 15 * 60 * 1000;

async function handleUndoLastReceiptQuickAction(res, phone, waNorm) {
  const us = getUserState(phone);
  const idx = us.lastRowIndex;
  const ts = us.lastRowTs || 0;
  if (!idx) {
    sendTwiML(
      res,
      `*ביטול מהיר*\n\nאין רישום אחרון לביטול.\n\nהשתמש ב-*מחק* לבחירה מהרשימה.`
    );
    return;
  }
  if (Date.now() - ts > QUICK_UNDO_TTL_MS) {
    us.lastRowIndex = null;
    us.lastRowTs = null;
    sendTwiML(res, `*ביטול מהיר*\n\nפג התוקף.\n\nהשתמש ב-*מחק*.`);
    return;
  }
  const row = await getRowByIndexIfOwned(idx, waNorm);
  if (!row) {
    us.lastRowIndex = null;
    us.lastRowTs = null;
    sendTwiML(res, `*ביטול מהיר*\n\nהשורה לא נמצאה.\n\nנסה *ניהול*.`);
    return;
  }
  const rowDesc = sheetNotes(row) || '(ללא תיאור)';
  const rowAmt = parseFloat(getCol(row, 'Amount')) || 0;
  const img = sheetDriveLink(row);
  if (img) await deleteDriveFileByUrl(img);
  const ok = await deleteRowByIndexForOwner(idx, waNorm);
  us.lastRowIndex = null;
  us.lastRowTs = null;
  resetSession(phone);
  sendTwiML(
    res,
    ok ? buildDeletionFeedbackCard(rowDesc, rowAmt) : `*שגיאה*\n\nלא הצלחתי לבטל.\n\nנסה *ניהול*.`
  );
}

/** אחרי בחירה מהרשימה — בלי אישור כפול */
async function completeExpenseAfterCategoryClarification(res, phone, waNorm, userSheetValue, category, pick) {
  await proceedAfterCategoryConfirmed(res, phone, waNorm, userSheetValue, pick, category);
}

// ===================== Response Templates =====================

function buildCategoriesList() {
  const lines = ['*11 קטגוריות רשמיות להחזר מהקיבוץ:*', ''];
  for (const c of CANONICAL_CATEGORIES) lines.push(c);
  lines.push('');
  lines.push('לא בטוחים? אשלח רשימה לבחירה — בוחרים מהרשימה, לא מנחשים.');
  return lines.join('\n');
}

function buildGreeting() {
  return (
    `*היי*\n\n` +
    `אני כאן ל-*החזרי קיבוץ*: רישום קבלות וסכומים לגיליון.\n\n` +
    `*איך רושמים*\n\n` +
    `• *סכום + תיאור* (למשל *45 אוטובוס*)\n` +
    `• *תמונת קבלה* עם טקסט — נשמר בדרייב ובגיליון\n` +
    `• *תמונה בלבד* — אבקש אחר כך סכום ותיאור\n\n` +
    `*פקודות*\n\n` +
    `• *סיכום* — ריכוז החודש\n` +
    `• *עזרה* — מדריך קצר\n` +
    `• *מחק* — ביטול רישום\n` +
    `• *ניהול* — רשימת החודש\n` +
    `• *מה לא הוגש* / *הגשתי* — סטטוס`
  );
}

function buildHelpGuide() {
  return (
    `*עזרה קצרה*\n\n` +
    `*רישום:* סכום + תיאור, או קבלה (עם או בלי טקסט).\n\n` +
    `*סיכום:* כתוב *סיכום* — מקבלים ריכוז וגרף.\n\n` +
    `*טעות:* *מחק* — בוחרים שורה ומאשרים.\n\n` +
    `*ניהול:* עריכת רישומי החודש.\n\n` +
    `*קטגוריות:* *קטגוריות* — הרשימה המלאה.\n\n` +
    `*הגשה:* *מה לא הוגש* / *הגשתי*.\n\n` +
    `נתקעת? שלח *שלום* ומתחילים מחדש.`
  );
}

// ===================== Config Log =====================

function logConfigOnce() {
  console.log('[config] TWILIO_ACCOUNT_SID:', TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}…` : '(missing)');
  console.log('[config] TWILIO_AUTH_TOKEN:', TWILIO_AUTH_TOKEN ? '(set)' : '(missing)');
  console.log('[config] FROM_WHATSAPP_NUMBER:', FROM_WHATSAPP_NUMBER || '(missing)');
  console.log('[config] TO_WHATSAPP_NUMBER:', TO_WHATSAPP_NUMBER || '(missing)');
  console.log('[config] GOOGLE_SHEET_ID:', GOOGLE_SHEET_ID || '(missing)');
  console.log('[config] GOOGLE_DRIVE_FOLDER_ID:', GOOGLE_DRIVE_FOLDER_ID || '(not set — Drive receipt uploads disabled)');
  console.log('[config] Google SA:', serviceAccountCreds ? 'loaded' : '(missing)');
  console.log('[config] Drive client:', getDriveClient() ? 'ready' : '(disabled)');
  console.log('[config] Twilio client:', twilioClient ? 'ready' : '(disabled)');
  console.log(
    '[config] ALLOWED users:',
    MERGED_ALLOWED_USERS.length === 0
      ? 'none (all senders allowed — set ALLOWED_USERS / ALLOWED_WHATSAPP_NUMBERS for production)'
      : `${MERGED_ALLOWED_USERS.length} configured`
  );
  console.log(
    '[config] PUBLIC_WEBHOOK_BASE:',
    PUBLIC_WEBHOOK_BASE || '(not set — monthly chart may use direct QuickChart URL only)'
  );
  console.log('[config] GEMINI_API_KEY:', GEMINI_API_KEY ? '(set)' : '(not set — Gemini assistant disabled)');
}
logConfigOnce();

// ===================== Routes =====================

const TWILIO_FROM_TEST = 'whatsapp:+15551234567';

app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

/** Short-lived PNG for Twilio WhatsApp media (requires PUBLIC_WEBHOOK_BASE). */
app.get('/__media/chart/:token', (req, res) => {
  const rec = chartPngOneShot.get(req.params.token);
  if (!rec?.buffer) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  res.type('image/png');
  res.set('Cache-Control', 'no-store');
  res.send(rec.buffer);
});

app.post('/whatsapp', async (req, res) => {
  try {
  const ctx = buildWhatsAppContext(req);
  const bodyRaw = req.body.Body ?? '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  let trimmed = String(bodyRaw).trim();
  const phone = ctx.sessionKey;
  const waNorm = ctx.waNorm;
  const userSheetValue = ctx.userSheetValue;
  const receiptFileBase = `${ctx.fileSlug}_Receipt`;
  const hasMedia = numMedia > 0;

  if (!waNorm) {
    sendTwiML(res, 'לא זוהה מספר שולח. נסה שוב.');
    return;
  }

  if (!isAllowedWaFrom(waNorm)) {
    sendTwiML(res, 'מצטער, אין לך הרשאה להשתמש במערכת זו.');
    return;
  }

  const inboundMessageSid = String(req.body.MessageSid || req.body.SmsSid || '').trim();
  void sendWhatsAppTypingIndicator(inboundMessageSid);

  const session = getSession(phone);

  // ─── EXPIRY ───
  if (session.state !== 'IDLE' && isSessionExpired(session)) {
    if (session.state === 'AWAITING_RECEIPT_IMAGE' && session.receiptRowIndex) {
      try {
        await updateRowReceiptFlagOnly(session.receiptRowIndex, waNorm, false);
      } catch (_) {}
    }
    if (MANAGEMENT_STATES.has(session.state)) clearManagement(phone);
    if (DELETE_FLOW_STATES.has(session.state)) clearDeleteFlow(phone);
    resetSession(phone);
  }

  const ib = parseInboundInteractive(req);
  if (
    (session.state === 'AWAITING_CATEGORY_CLARIFICATION' || session.state === 'AWAITING_CATEGORY_CONFIRM') &&
    ib.categoryPayload
  ) {
    trimmed = ib.categoryPayload;
  } else if (!trimmed && ib.categoryPayload) {
    trimmed = ib.categoryPayload;
  }
  const lower = trimmed.toLowerCase();

  console.log('[whatsapp] Message received', {
    from: waNorm || '(missing)',
    profile: (ctx.profileName || '').slice(0, 40),
    bodyPreview: trimmed.slice(0, 80),
    buttonPayload: ib.btnPayload || undefined,
    listPick: ib.listId || undefined,
    hasMedia,
    numMedia,
  });

  const MGMT_OK = '*בוצע*\n\nהגיליון עודכן.';

  const summaryQuick =
    ib.btnPayload === QR_PAYLOAD_SUMMARY ||
    (!ib.btnPayload && ib.btnText && /סיכום\s*(?:החזרים|חודשי)/i.test(ib.btnText));
  const undoQuick =
    ib.btnPayload === QR_PAYLOAD_UNDO_LAST ||
    (!ib.btnPayload &&
      ib.btnText &&
      /ביטול\s*פעולה\s*אחרונה|מחיקת\s*אחרון|^מחיקה/i.test(ib.btnText.trim()));

  if (summaryQuick) {
    try {
      await sendVisualMonthlySummary(res, waNorm);
    } catch (e) {
      console.error('[whatsapp] summary (quick-reply):', e.message);
      sendTwiML(res, 'אופס, לא הצלחתי למשוך את הסיכום. נסה שוב בעוד רגע?');
    }
    return;
  }
  if (undoQuick) {
    await handleUndoLastReceiptQuickAction(res, phone, waNorm);
    return;
  }

  if (session.state === 'IDLE' && !hasMedia && (lower === 'ביטול' || lower === 'בטל')) {
    sendTwiML(res, 'סבבה — כשתרצה ממשיכים.');
    return;
  }

  if (
    session.state === 'IDLE' &&
    !hasMedia &&
    /^(כן|לא|yes|no|אש|סגור|עזוב|לא\s+עכשיו)\s*$/i.test(trimmed)
  ) {
    sendTwiML(
      res,
      'אין כרגע משהו לאשר.\n\nשלח *סכום + תיאור* או *סיכום* לריכוז החודש.'
    );
    return;
  }

  // ─── ידע סטטי (kibbutzData): רק טקסט בלי רישום הוצאה, מצב IDLE (בלי Gemini) ───
  if (
    !GEMINI_API_KEY &&
    session.state === 'IDLE' &&
    !hasMedia &&
    trimmed &&
    !ib.btnPayload &&
    !ib.categoryPayload
  ) {
    const expenseProbe = parseExpenseMessage(trimmed);
    const looksLikeExpenseReport =
      typeof expenseProbe.amount === 'number' &&
      !Number.isNaN(expenseProbe.amount) &&
      expenseProbe.amount > 0;
    if (!looksLikeExpenseReport) {
      if (await tryHandleKibbutzInquiry(res, phone, waNorm, userSheetValue, lower)) {
        return;
      }
    }
  }

  // ─── AWAITING_CATEGORY_CONFIRM (אחרי זיהוי אוטומטי) ───
  if (session.state === 'AWAITING_CATEGORY_CONFIRM') {
    const pick = session.pendingCategoryPick;
    const suggested = session.pendingSuggestedCategory;
    if (!pick || suggested == null || typeof pick.amount !== 'number' || Number.isNaN(pick.amount)) {
      resetSession(phone);
      sendTwiML(res, 'פג תוקף — שלח שוב *סכום + תיאור*.');
      return;
    }
    if (ib.categoryPayload && CANONICAL_CATEGORIES.includes(ib.categoryPayload)) {
      await proceedAfterCategoryConfirmed(res, phone, waNorm, userSheetValue, pick, ib.categoryPayload);
      return;
    }
    if (ib.btnPayload === QR_PAYLOAD_CAT_YES) {
      await proceedAfterCategoryConfirmed(res, phone, waNorm, userSheetValue, pick, suggested);
      return;
    }
    if (ib.btnPayload === QR_PAYLOAD_CAT_NO) {
      await startCategoryClarification(res, phone, pick, { waNorm });
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      await proceedAfterCategoryConfirmed(res, phone, waNorm, userSheetValue, pick, suggested);
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) {
      await startCategoryClarification(res, phone, pick, { waNorm });
      return;
    }
    sendTwiML(res, 'עדיין מחכה לאישור הקטגוריה — כפתור או *כן* / *לא*.');
    return;
  }

  // ─── AWAITING_KIBBUTZ_DISAMBIG (כמה נושאים מ־kibbutzData) ───
  if (session.state === 'AWAITING_KIBBUTZ_DISAMBIG') {
    const kd = session.kibbutzDisambig;
    if (!kd || !Array.isArray(kd.matches) || kd.matches.length === 0) {
      resetSession(phone);
      sendTwiML(res, 'פג תוקף — נסה שוב.');
      return;
    }
    if (lower === 'ביטול' || lower === 'בטל') {
      resetSession(phone);
      sendTwiML(res, 'בוטל.');
      return;
    }
    const idx = resolveKibbutzDisambigIndex(trimmed, kd.matches);
    if (idx < 0) {
      sendTwiML(res, 'לא הבנתי. שלח *מספר* מהרשימה או *ביטול*.');
      return;
    }
    const entry = kd.matches[idx];
    if (kd.mode === 'inquiry') {
      resetSession(phone);
      sendTwiML(res, formatKibbutzKnowledgeAnswer(entry.answer));
      return;
    }
    const pick = kd.pendingPick;
    if (!pick || typeof pick.amount !== 'number' || Number.isNaN(pick.amount)) {
      resetSession(phone);
      sendTwiML(res, 'חסרים נתוני רישום — שלח שוב *סכום + תיאור*.');
      return;
    }
    resetSession(phone);
    await completeSmartExpenseFromKibbutzEntry(res, phone, waNorm, userSheetValue, pick, entry, {});
    return;
  }

  // ─── AWAITING_CATEGORY_CLARIFICATION ───
  if (session.state === 'AWAITING_CATEGORY_CLARIFICATION') {
    const pick = session.pendingCategoryPick;
    if (!pick || typeof pick.amount !== 'number' || Number.isNaN(pick.amount)) {
      resetSession(phone);
      sendTwiML(res, 'פג תוקף או חסרים נתונים — שלח שוב *סכום + תיאור*.');
      return;
    }
    if (detectDeleteIntent(lower, trimmed) && !hasMedia) {
      resetSession(phone);
      sendTwiML(res, 'בסדר, ביטלנו. כשתרצה שלח שוב 💰');
      return;
    }
    const cat = resolveCategoryFromReply(trimmed);
    if (!cat) {
      await startCategoryClarification(res, phone, pick, { waNorm });
      return;
    }
    await completeExpenseAfterCategoryClarification(res, phone, waNorm, userSheetValue, cat, pick);
    return;
  }

  // ─── FULL-MONTH MANAGEMENT & EDIT ───
  if (MANAGEMENT_STATES.has(session.state)) {
    const us = getUserState(phone);
    const touchMgmt = () => { session.ts = Date.now(); };

    if (matchesAny(lower, INTENT_MANAGEMENT) && !hasMedia) {
      try {
        await buildAndSendManagementList(res, phone, waNorm);
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
        emptyTwiMLResponse(res);
        void (async () => {
          try {
            await replyWhatsAppToUser(waNorm, MEDIA_PROCESSING_ACK_MSG);
            const oldLink = us.managementEditRow?.receiptImage || '';
            const driveLink = await handleMediaUpload(req, receiptFileBase);
            if (driveLink && oldLink) await deleteDriveFileByUrl(oldLink);
            await updateRowDriveAndLegacy(rowNum, waNorm, driveLink || oldLink || '');
            await refreshManagementEditSnapshot(phone, waNorm);
            session.state = 'MANAGEMENT_EDIT_MENU';
            touchMgmt();
            const warn = !driveLink ? `\n\n${DRIVE_UPLOAD_FAIL_USER_MSG}` : '';
            await replyWhatsAppToUser(waNorm, `${MGMT_OK}${warn}\n\n${editMenuPrompt(us.managementEditRow)}`);
          } catch (e) {
            console.error('[whatsapp] mgmt receipt upload:', e.message);
            await replyWhatsAppToUser(waNorm, DRIVE_UPLOAD_FAIL_USER_MSG);
          }
        })();
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
      await updateRowByIndexForOwner(rowNum, 'Amount', newAmt, waNorm);
      await refreshManagementEditSnapshot(phone, waNorm);
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
      const docM = await getSpreadsheetDoc();
      const sheetM = docM ? docM.sheetsByIndex[0] : null;
      if (sheetM) await ensureHeaders(sheetM);
      if (sheetM) await sheetM.loadHeaderRow(1);
      const hdr = sheetM ? sheetM.headerValues || [] : [];
      const updates = {};
      if (hdr.includes('Notes')) updates.Notes = newDesc;
      if (hdr.includes('Description')) updates.Description = newDesc;
      if (cat) updates.Category = cat;
      await updateMultipleFieldsByIndexForOwner(rowNum, updates, waNorm);
      await refreshManagementEditSnapshot(phone, waNorm);
      session.state = 'MANAGEMENT_EDIT_MENU';
      touchMgmt();
      const catNote = cat
        ? ''
        : '\n(הקטגוריה נשארה — תוסיף מילה ברורה: מונית, אוטובוס, פנגו, גן…)';
      sendTwiML(res, `${MGMT_OK}${catNote}\n\n${editMenuPrompt(us.managementEditRow)}`);
      return;
    }

    if (session.state === 'MANAGEMENT_EDIT_MENU') {
      const rowNum = us.managementEditRow?.sheetRowNumber;
      if (!rowNum) { clearManagement(phone); resetSession(phone); sendTwiML(res, 'פג תוקף הניהול. שלח *ניהול* מחדש.'); return; }

      if (hasMedia) {
        emptyTwiMLResponse(res);
        void (async () => {
          try {
            await replyWhatsAppToUser(waNorm, MEDIA_PROCESSING_ACK_MSG);
            const oldLink = us.managementEditRow?.receiptImage || '';
            const driveLink = await handleMediaUpload(req, receiptFileBase);
            if (oldLink && driveLink) await deleteDriveFileByUrl(oldLink);
            const finalImg = driveLink || oldLink;
            await updateRowDriveAndLegacy(rowNum, waNorm, finalImg || '');
            await refreshManagementEditSnapshot(phone, waNorm);
            touchMgmt();
            const warn =
              !driveLink && !oldLink
                ? `\n\n${DRIVE_UPLOAD_FAIL_USER_MSG}`
                : !driveLink
                  ? `\n\n${DRIVE_UPLOAD_FAIL_USER_MSG}\n(נשמר הקישור הקודם אם היה.)`
                  : '';
            await replyWhatsAppToUser(waNorm, `${MGMT_OK}${warn}\n\n${editMenuPrompt(us.managementEditRow)}`);
          } catch (e) {
            console.error('[whatsapp] mgmt menu receipt upload:', e.message);
            await replyWhatsAppToUser(waNorm, DRIVE_UPLOAD_FAIL_USER_MSG);
          }
        })();
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
        const edSnapshot = us.managementEditRow
          ? { desc: us.managementEditRow.desc, amt: us.managementEditRow.amt }
          : null;
        const oldLink = us.managementEditRow?.receiptImage || '';
        if (oldLink) await deleteDriveFileByUrl(oldLink);
        const delOk = await deleteRowByIndexForOwner(rowNum, waNorm);
        clearManagement(phone);
        resetSession(phone);
        sendTwiML(
          res,
          delOk
            ? `${buildDeletionFeedbackCard(edSnapshot?.desc || '(ללא תיאור)', edSnapshot?.amt || 0)}\n\nשלח *ניהול* לרשימה מעודכנת.`
            : 'לא הצלחתי למחוק (אין הרשאה או השורה לא נמצאה).'
        );
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
        sendTwiML(res, 'שלח *תמונת קבלה* (הקובץ הישן בדרייב יוחלף).');
        return;
      }

      sendTwiML(res, `לא הבנתי.\n\n${editMenuPrompt(us.managementEditRow)}`);
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
        const row = await getRowByIndexIfOwned(item.sheetRowNumber, waNorm);
        if (!row) {
          sendTwiML(res, 'השורה לא נמצאה או אינה שלך. שלח *ניהול* מחדש.');
          return;
        }
        us.managementEditRow = {
          sheetRowNumber: item.sheetRowNumber,
          date: getCol(row, 'Date'),
          desc: sheetNotes(row),
          amt: parseFloat(getCol(row, 'Amount')) || 0,
          receiptImage: sheetDriveLink(row),
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

  // ─── MANAGEMENT LIST INTENT (רק מ-IDLE או מתוך מצבי ניהול — לא באמצע רישום החזר) ───
  const canOpenManagement =
    session.state === 'IDLE' || MANAGEMENT_STATES.has(session.state);
  if (matchesAny(lower, INTENT_MANAGEMENT) && !hasMedia && canOpenManagement) {
    try {
      await buildAndSendManagementList(res, phone, waNorm);
    } catch (e) {
      console.error('[mgmt] list failed:', e.message);
      sendTwiML(res, 'לא הצלחתי לטעון את הרשימה, נסה שוב.');
    }
    return;
  }

  // ─── GUIDED DELETE: אישור מחיקה (תוקף 2 דק׳) ───
  if (session.state === 'AWAITING_DELETE_CONFIRM') {
    const us = getUserState(phone);
    const pd = us.pendingDelete;
    if (!pd || !pd.sheetRowNumber) {
      clearDeleteFlow(phone);
      resetSession(phone);
      sendTwiML(res, 'פג תוקף או אין בחירה — שלח שוב *מחק* או *טעות* כדי להתחיל מחדש.');
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      const img = (pd.receiptImage || '').trim();
      if (img) {
        const delOk = await deleteDriveFileByUrl(img);
        if (!delOk) console.error('[delete] Drive file delete failed for row', pd.sheetRowNumber);
      }
      const ok = await deleteRowByIndexForOwner(pd.sheetRowNumber, waNorm);
      const u2 = getUserState(phone);
      if (u2.lastRowIndex === pd.sheetRowNumber) {
        u2.lastRowIndex = null;
        u2.lastRowTs = null;
      }
      clearDeleteFlow(phone);
      resetSession(phone);
      sendTwiML(
        res,
        ok
          ? buildDeletionFeedbackCard(pd.desc || '(ללא תיאור)', pd.amt || 0)
          : 'לא הצלחתי למחוק את השורה, נסה שוב או השתמש ב-*ניהול*.'
      );
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_NO) || lower === 'ביטול' || lower === 'בטל') {
      clearDeleteFlow(phone);
      resetSession(phone);
      sendTwiML(res, 'סבבה, לא נגעתי בכלום. אם תרצה — שלח שוב *מחק* או *טעות*.');
      return;
    }
    sendTwiML(
      res,
      `*אישור מחיקה*\n\nלמחוק את *${pd.desc}* — *${formatShekelDisplay(pd.amt)}* ש״ח?\n\n*כן* / *לא*`
    );
    return;
  }

  // ─── GUIDED DELETE: בחירה מרשימה (תוקף 2 דק׳) ───
  if (session.state === 'AWAITING_DELETE_SELECTION') {
    const us = getUserState(phone);
    const items = us.deleteCandidates;
    if (!items || items.length === 0) {
      clearDeleteFlow(phone);
      resetSession(phone);
      sendTwiML(res, 'הרשימה פגה — שלח שוב *מחק* או *טעות*.');
      return;
    }
    if (lower === 'ביטול' || lower === 'בטל') {
      clearDeleteFlow(phone);
      resetSession(phone);
      sendTwiML(res, 'בסדר, יצאנו ממצב מחיקה. יש עוד משהו? 😊');
      return;
    }
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      const picked = items.find((x) => x.displayIndex === n);
      if (!picked) {
        sendTwiML(res, `מספר *${n}* לא מופיע ברשימה. נסה שוב או *ביטול*.`);
        return;
      }
      us.pendingDeleteIndex = n;
      us.pendingDelete = {
        sheetRowNumber: picked.sheetRowNumber,
        desc: picked.desc,
        amt: picked.amt,
        receiptImage: picked.receiptImage,
        displayIndex: n,
      };
      us.status = 'AWAITING_DELETE_CONFIRM';
      session.state = 'AWAITING_DELETE_CONFIRM';
      session.ts = Date.now();
      sendTwiML(
        res,
        `סימנתי: *${picked.desc}* — *${picked.amt} ₪*.\n` +
          `האם אתה בטוח שברצונך למחוק את *${picked.desc}* בסך *${picked.amt} ₪*?\n` +
          '(ענה *כן* או *לא*)'
      );
      return;
    }
    sendTwiML(res, 'שלח *מספר* מהרשימה למעלה, או *ביטול* ליציאה.');
    return;
  }

  // ─── AWAITING_RECEIPT_IMAGE: image sent → update Col E + H ───
  if (session.state === 'AWAITING_RECEIPT_IMAGE') {
    const rowIdx = session.receiptRowIndex;
    if (detectDeleteIntent(lower, trimmed) && !hasMedia) {
      if (rowIdx) {
        try { await updateRowReceiptFlagOnly(rowIdx, waNorm, false); } catch (_) {}
      }
      resetSession(phone);
      await startDeleteSelectionFlow(res, phone, waNorm);
      return;
    }
    if (hasMedia) {
      emptyTwiMLResponse(res);
      void (async () => {
        try {
          await replyWhatsAppToUser(waNorm, MEDIA_PROCESSING_ACK_MSG);
          const driveLink = await handleMediaUpload(req, receiptFileBase);
          if (rowIdx) await updateRowDriveAndLegacy(rowIdx, waNorm, driveLink || '');
          resetSession(phone);
          if (driveLink && rowIdx) {
            const row = await getRowByIndexIfOwned(rowIdx, waNorm);
            if (row) {
              const amt = parseFloat(getCol(row, 'Amount')) || 0;
              const d = sheetNotes(row) || '';
              const cat = getCol(row, 'Category') || '';
              const dupLine = await duplicateExpenseWarningLine(waNorm, amt, cat);
              const dateDisp = String(getCol(row, 'Date') || formatNow().date);
              const card = buildSuccessRecordCard(amt, cat, dateDisp, {
                duplicateAppend: dupLine,
                awaitingReceipt: false,
              });
              await sendReceiptSuccessQuickReply(waNorm, card);
            } else {
              await replyWhatsAppToUser(
                waNorm,
                `*הקבלה נשמרה*\n\nהקישור עודכן בגיליון.\n\nלביטול — *מחק*.`
              );
            }
          } else {
            await replyWhatsAppToUser(
              waNorm,
              `${DRIVE_UPLOAD_FAIL_USER_MSG}\n\n(הרישום נשמר בלי קובץ בדרייב. לביטול — *מחק*)`
            );
          }
        } catch (e) {
          console.error('[whatsapp] receipt image pipeline:', e.message);
          await replyWhatsAppToUser(waNorm, DRIVE_UPLOAD_FAIL_USER_MSG);
        }
      })();
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      if (rowIdx) await updateRowReceiptFlagOnly(rowIdx, waNorm, true);
      resetSession(phone);
      sendTwiML(
        res,
        `*קבלה מאושרת*\n\nרישמת שיש קבלה.\n\nיש עוד החזר? שלח *סכום + תיאור*.`
      );
      return;
    }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) {
      if (rowIdx) await updateRowReceiptFlagOnly(rowIdx, waNorm, false);
      resetSession(phone);
      sendTwiML(
        res,
        `*בלי קבלה בדרייב*\n\nהרישום נשאר בגיליון.\n\nיש עוד? שלח *סכום + תיאור* כשתוכל.`
      );
      return;
    }
    sendTwiML(
      res,
      `*ממתין לקבלה*\n\nשלח *תמונה*, או השב *כן* / *לא*.\n\nלביטול הרישום — *מחק*.`
    );
    return;
  }

  // ─── AWAITING_EXPENSE_DETAILS: image-first, now expecting text ───
  if (session.state === 'AWAITING_EXPENSE_DETAILS') {
    const pendingDriveLink = session.pendingDriveLink || '';
    const { amount, description } = parseExpenseMessage(trimmed);
    if (amount) {
      const desc = description || '(ללא תיאור)';
      const pickEd = {
        amount,
        desc,
        userSheetValue,
        receipt: pendingDriveLink ? 'Yes' : 'No',
        receiptImage: pendingDriveLink || '',
      };
      if (await tryProceedSmartKibbutzExpense(res, phone, waNorm, userSheetValue, pickEd, lower, {})) {
        return;
      }
      const category = matchCategory(desc);
      if (!category) {
        await startCategoryClarification(
          res,
          phone,
          {
            amount,
            desc,
            userSheetValue,
            receipt: pendingDriveLink ? 'Yes' : 'No',
            receiptImage: pendingDriveLink || '',
          },
          { waNorm }
        );
        return;
      }
      resetSession(phone);
      const pick = {
        amount,
        desc,
        userSheetValue,
        receipt: pendingDriveLink ? 'Yes' : 'No',
        receiptImage: pendingDriveLink || '',
      };
      await beginCategoryConfirmFlow(res, waNorm, phone, userSheetValue, pick, category, {});
      return;
    }
    sendTwiML(res, 'לא קלטתי סכום.\n\nשלח *סכום + תיאור* (למשל *50 אוטובוס*).');
    return;
  }

  // ─── SCENARIO A: Image + Caption with expense data ───
  if (hasMedia) {
    const { amount, description } = parseExpenseMessage(trimmed);

    if (amount) {
      const desc = description || '(ללא תיאור)';
      emptyTwiMLResponse(res);
      void (async () => {
        try {
          await replyWhatsAppToUser(waNorm, MEDIA_PROCESSING_ACK_MSG);
          const driveLink = await handleMediaUpload(req, receiptFileBase);
          const msgLower = `${String(trimmed || '').toLowerCase()} ${desc.toLowerCase()}`;
          const pickSmartA = {
            amount,
            desc,
            userSheetValue,
            receipt: driveLink ? 'Yes' : 'No',
            receiptImage: driveLink || '',
          };
          if (
            await tryProceedSmartKibbutzExpense(null, phone, waNorm, userSheetValue, pickSmartA, msgLower, {
              useOutboundApi: true,
              twimlAlreadyEmpty: true,
            })
          ) {
            return;
          }
          const category = matchCategory(desc);
          if (!category) {
            await startCategoryClarification(
              null,
              phone,
              {
                amount,
                desc,
                userSheetValue,
                receipt: driveLink ? 'Yes' : 'No',
                receiptImage: driveLink || '',
              },
              { useOutboundApi: true, waNorm }
            );
            return;
          }

          resetSession(phone);
          const pickA = {
            amount,
            desc,
            userSheetValue,
            receipt: driveLink ? 'Yes' : 'No',
            receiptImage: driveLink || '',
          };
          await beginCategoryConfirmFlow(null, waNorm, phone, userSheetValue, pickA, category, {
            useOutboundApi: true,
          });
        } catch (e) {
          console.error('[whatsapp] scenario A:', e.message);
          await replyWhatsAppToUser(waNorm, DRIVE_UPLOAD_FAIL_USER_MSG);
        }
      })();
      return;
    }

    // ─── SCENARIO B: Image without expense text ───
    emptyTwiMLResponse(res);
    void (async () => {
      try {
        await replyWhatsAppToUser(waNorm, MEDIA_PROCESSING_ACK_MSG);
        const driveLink = await handleMediaUpload(req, receiptFileBase);
        const s0 = getSession(phone);
        s0.state = 'AWAITING_EXPENSE_DETAILS';
        s0.pendingDriveLink = driveLink || '';
        s0.ts = Date.now();
        if (driveLink) {
          await replyWhatsAppToUser(
            waNorm,
            '*קבלה התקבלה*\n\nעל איזה החזר וכמה זה?\n\n(למשל *50 פנגו* / *120 מונית*)'
          );
        } else {
          await replyWhatsAppToUser(
            waNorm,
            `${DRIVE_UPLOAD_FAIL_USER_MSG}\n\nשלח שוב *תמונת קבלה*, ואז *סכום + תיאור*.`
          );
        }
      } catch (e) {
        console.error('[whatsapp] scenario B:', e.message);
        await replyWhatsAppToUser(waNorm, DRIVE_UPLOAD_FAIL_USER_MSG);
      }
    })();
    return;
  }

  // ─── HELP (שפה טבעית) ───
  if (detectHelpIntent(lower, trimmed) && !hasMedia) {
    sendTwiML(res, buildHelpGuide());
    return;
  }

  // ─── SUMMARY — כולל "תראה לי", "כמה הוצאתי", "סטטיסטיקה" וכו׳ ───
  if (detectSummaryIntent(lower, trimmed) && !hasMedia) {
    try {
      await sendVisualMonthlySummary(res, waNorm);
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
      sendTwiML(res, 'אופס, לא הצלחתי למשוך את הסיכום. נסה שוב בעוד רגע?');
    }
    return;
  }

  // ─── Analytics-style report (מילות מפתח נפרדות מסיכום פיננסי) ───
  if (!hasMedia && /ניתוח|הכי\s+יקרה|\bstats\b|פירוט\s+לפי\s+קטגוריה/i.test(trimmed)) {
    try {
      sendTwiML(res, (await buildMonthlyStats(waNorm)) || 'אין עדיין מספיק רישומים לניתוח.');
    } catch (e) {
      console.error('[sheets] stats failed:', e.message);
      sendTwiML(res, 'אופס, משהו נתקשה בניתוח. נסה שוב?');
    }
    return;
  }

  // ─── NOT SUBMITTED ───
  if (matchesAny(lower, INTENT_NOT_SUBMITTED)) {
    try {
      const open = await getUnsubmittedRows(waNorm);
      if (open.length === 0) {
        sendTwiML(res, '*סטטוס הגשה*\n\nלחודש הזה אין רישומים שממתינים להגשה.');
      } else {
        const total = open.reduce((s, r) => s + r.amt, 0);
        const lines = [
          `*לא הוגשו (${open.length})*\n\nסה״כ *${formatShekelDisplay(total)}* ש״ח ממתינים:`,
          '',
        ];
        for (const r of open) {
          const rcpt = r.receipt === 'Yes' ? 'יש קבלה' : 'אין קבלה';
          lines.push(`• ${r.desc} — *${formatShekelDisplay(r.amt)}* ש״ח (${r.cat}) · ${rcpt}`);
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
      const count = await markAllCurrentMonthSubmitted(waNorm);
      sendTwiML(
        res,
        count === 0
          ? '*סטטוס*\n\nהכול כבר מסומן כהוגש לחודש הזה.'
          : `*עודכן*\n\n*${count}* רישומים סומנו כהוגשו.`
      );
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
      const data = await getCurrentMonthRows(false, waNorm);
      if (data && data.rows.length > 0) {
        const total = data.rows.reduce((s, r) => s + r.amt, 0);
        sendTwiML(res, `${savvySummaryTotalLine(total)}\n(${data.rows.length} רישומים)\n\nשלח *סיכום* או *תראה לי* לפירוט מלא 🕵️‍♂️`);
      } else {
        sendTwiML(res, 'עדיין אין החזרים החודש. רשום אחד — אל תפספס כסף שמגיע לך 💰');
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
    sendTwiML(
      res,
      'יש עוד החזר לרשום?\n\nשלח *סכום + תיאור* או *תמונת קבלה*.'
    );
    return;
  }

  // ─── SESSION STATES ───

  if (getSession(phone).state === 'AWAITING_DAILY_REPLY') {
    resetSession(phone);
    if (matchesAny(lower, INTENT_CONFIRM_YES)) { sendTwiML(res, 'מעולה! שלח את ההחזרים וארשום — לא מפספסים 📝'); return; }
    if (matchesAny(lower, INTENT_CONFIRM_NO)) { sendTwiML(res, 'יופי, ערב טוב! 🌙'); return; }
  }

  if (getSession(phone).state === 'AWAITING_DESCRIPTION') {
    const s = getSession(phone);
    const pendingAmount = s.pendingAmount;
    const parsed = parseExpenseMessage(trimmed);

    if (parsed.amount && parsed.description) {
      const pickD0 = {
        amount: parsed.amount,
        desc: parsed.description,
        userSheetValue,
        receipt: 'No',
        receiptImage: '',
      };
      if (await tryProceedSmartKibbutzExpense(res, phone, waNorm, userSheetValue, pickD0, lower, {})) {
        return;
      }
      const category = matchCategory(parsed.description);
      if (!category) {
        await startCategoryClarification(
          res,
          phone,
          {
            amount: parsed.amount,
            desc: parsed.description,
            userSheetValue,
            receipt: 'No',
            receiptImage: '',
          },
          { waNorm }
        );
        return;
      }
      resetSession(phone);
      const pickD1 = {
        amount: parsed.amount,
        desc: parsed.description,
        userSheetValue,
        receipt: 'No',
        receiptImage: '',
      };
      await beginCategoryConfirmFlow(res, waNorm, phone, userSheetValue, pickD1, category, {});
      return;
    }

    const desc = sanitizeDescription(trimmed) || '(ללא תיאור)';
    const pickD0b = {
      amount: pendingAmount,
      desc,
      userSheetValue,
      receipt: 'No',
      receiptImage: '',
    };
    if (await tryProceedSmartKibbutzExpense(res, phone, waNorm, userSheetValue, pickD0b, lower, {})) {
      return;
    }
    const category = matchCategory(desc);
    if (!category) {
      await startCategoryClarification(
        res,
        phone,
        {
          amount: pendingAmount,
          desc,
          userSheetValue,
          receipt: 'No',
          receiptImage: '',
        },
        { waNorm }
      );
      return;
    }
    resetSession(phone);
    const pickD2 = {
      amount: pendingAmount,
      desc,
      userSheetValue,
      receipt: 'No',
      receiptImage: '',
    };
    await beginCategoryConfirmFlow(res, waNorm, phone, userSheetValue, pickD2, category, {});
    return;
  }

  if (getSession(phone).state === 'AWAITING_AMOUNT') {
    if (CURRENCY_RE.test(trimmed)) {
      resetSession(phone);
      sendTwiML(
        res,
        '*מטבע*\n\nרושמים ב-*ש״ח* בלבד, בלי סימני מטבע זר.\n\nשלח שוב.'
      );
      return;
    }
    const s = getSession(phone);
    const parsed = parseExpenseMessage(trimmed);
    if (parsed.amount) {
      const { pendingDesc, pendingCategory } = s;
      const pickAm0 = {
        amount: parsed.amount,
        desc: pendingDesc,
        userSheetValue,
        receipt: 'No',
        receiptImage: '',
      };
      if (await tryProceedSmartKibbutzExpense(res, phone, waNorm, userSheetValue, pickAm0, lower, {})) {
        return;
      }
      const resolved = pendingCategory || matchCategory(pendingDesc);
      if (!resolved) {
        await startCategoryClarification(
          res,
          phone,
          {
            amount: parsed.amount,
            desc: pendingDesc,
            userSheetValue,
            receipt: 'No',
            receiptImage: '',
          },
          { waNorm }
        );
        return;
      }
      resetSession(phone);
      const pickAm = {
        amount: parsed.amount,
        desc: pendingDesc,
        userSheetValue,
        receipt: 'No',
        receiptImage: '',
      };
      await beginCategoryConfirmFlow(res, waNorm, phone, userSheetValue, pickAm, resolved, {});
      return;
    }
    resetSession(phone);
    sendTwiML(res, 'לא הצלחתי לזהות סכום. נסה שוב עם מספר (למשל: *50*)');
    return;
  }

  if (getSession(phone).state === 'AWAITING_HIGH_CONFIRM') {
    const s = getSession(phone);
    const {
      pendingAmount,
      pendingDesc,
      pendingCategory,
      pendingDriveLink,
      pendingKibbutzSmartSnapshot,
    } = s;
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      if (!pendingCategory) {
        resetSession(phone);
        sendTwiML(res, 'חסרה קטגוריה — שלח שוב *סכום + תיאור* (עם מילה מהרשימה) או ענה על השאלה על הקטגוריה.');
        return;
      }
      resetSession(phone);
      try {
        const hasImage = !!pendingDriveLink;
        const dupLine = await duplicateExpenseWarningLine(waNorm, pendingAmount, pendingCategory);
        if (pendingKibbutzSmartSnapshot) {
          let snap = null;
          try {
            snap = JSON.parse(pendingKibbutzSmartSnapshot);
          } catch (_) {
            snap = null;
          }
          const contact =
            (snap && snap.contact) || extractSubmissionContacts((snap && snap.answer) || '');
          const lim = snap != null ? Number(snap.limit) : NaN;
          const refund = estimatedRefund(pendingAmount, lim);
          const refundDisp = formatShekelDisplay(refund);
          const limitDisp = Number.isFinite(lim) && lim > 0 ? formatShekelDisplay(lim) : '—';
          const capNote = capNoteFromEntry(pendingAmount, { limit: lim });
          const rowIdx = await saveFullRow(
            phone,
            userSheetValue,
            pendingAmount,
            pendingDesc,
            pendingCategory,
            pendingDriveLink || '',
            { topic: pendingCategory, submissionContact: contact }
          );
          const reply = buildSmartLogReply({
            amountDisplay: formatShekelDisplay(pendingAmount),
            limitDisplay: limitDisp,
            refundDisplay: refundDisp,
            topic: pendingCategory,
            contact,
            capNote,
            dupSuffix: dupLine,
          });
          if (hasImage) {
            emptyTwiMLResponse(res);
            await sendReceiptSuccessQuickReply(waNorm, reply);
          } else {
            const ns = getSession(phone);
            ns.state = 'AWAITING_RECEIPT_IMAGE';
            ns.receiptRowIndex = rowIdx;
            ns.ts = Date.now();
            sendTwiML(res, reply);
          }
        } else {
          const rowIdx = await saveFullRow(
            phone,
            userSheetValue,
            pendingAmount,
            pendingDesc,
            pendingCategory,
            pendingDriveLink || ''
          );
          const { date } = formatNow();
          const card = buildSuccessRecordCard(pendingAmount, pendingCategory, date, {
            duplicateAppend: dupLine,
            awaitingReceipt: !hasImage,
          });
          if (hasImage) {
            emptyTwiMLResponse(res);
            await sendReceiptSuccessQuickReply(waNorm, card);
          } else {
            const ns = getSession(phone);
            ns.state = 'AWAITING_RECEIPT_IMAGE';
            ns.receiptRowIndex = rowIdx;
            ns.ts = Date.now();
            sendTwiML(res, card);
          }
        }
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }
    if (
      matchesAny(lower, INTENT_CONFIRM_NO) ||
      lower === 'ביטול' ||
      lower === 'בטל' ||
      lower === 'טעות'
    ) {
      resetSession(phone);
      sendTwiML(res, '*בוטל*\n\nלא נשמר כלום.\n\nכשתהיה מוכן — שלח שוב *סכום + תיאור*.');
      return;
    }
    sendTwiML(
      res,
      `עדיין ממתינים לאישור: *${pendingAmount} ₪* עבור *${pendingDesc}*.\nשלח *כן* לאישור או *לא* לביטול.`
    );
    return;
  }

  // ─── DELETE INTENT — רשימה + אישור (לא בזמן רישום פעיל או ניהול) ───
  if (
    detectDeleteIntent(lower, trimmed) &&
    !MANAGEMENT_STATES.has(session.state) &&
    !DELETE_FLOW_STATES.has(session.state) &&
    !EXPENSE_INTERACTIVE_STATES.has(session.state) &&
    !hasMedia
  ) {
    await startDeleteSelectionFlow(res, phone, waNorm);
    return;
  }

  // ─── CURRENCY ALERT ───
  if (CURRENCY_RE.test(trimmed)) {
    sendTwiML(
      res,
      '*מטבע*\n\nרושמים ב-*ש״ח* בלבד.\n\nאם הסכום בש״ח — שלח בלי סימן מטבע זר.'
    );
    return;
  }

  // ─── Gemini: כל הודעת טקסט ב־IDLE (אחרי פקודות/כוונות שכבר טופלו למעלה) ───
  if (
    GEMINI_API_KEY &&
    session.state === 'IDLE' &&
    !hasMedia &&
    trimmed &&
    !ib.btnPayload &&
    !ib.categoryPayload
  ) {
    try {
      const geminiOut = await runGeminiKibbutzTurn(GEMINI_API_KEY, trimmed, { hasMedia: false });
      await applyGeminiWhatsAppResult(res, phone, waNorm, userSheetValue, geminiOut, trimmed);
    } catch (e) {
      console.error('[gemini]', e && e.message ? e.message : e);
      sendTwiML(
        res,
        'הממ… לא הצלחתי לעבד את זה עכשיו 🤔 תוכל לנסות שוב בעוד רגע, או לכתוב *סכום + תיאור* בקצרה?'
      );
    }
    return;
  }

  const bridgeMsg = tryBridgingSmallTalk(lower, trimmed);
  if (bridgeMsg && session.state === 'IDLE' && !hasMedia) {
    sendTwiML(res, bridgeMsg);
    return;
  }

  // ─── SCENARIO C: NORMAL TEXT EXPENSE ───
  const { amount, description } = parseExpenseMessage(trimmed);

  if (amount && description) {
    const pickSmartC = {
      amount,
      desc: description,
      userSheetValue,
      receipt: 'No',
      receiptImage: '',
    };
    if (await tryProceedSmartKibbutzExpense(res, phone, waNorm, userSheetValue, pickSmartC, lower, {})) {
      return;
    }
    const category = matchCategory(description);
    if (!category) {
      await startCategoryClarification(
        res,
        phone,
        {
          amount,
          desc: description,
          userSheetValue,
          receipt: 'No',
          receiptImage: '',
        },
        { waNorm }
      );
      return;
    }
    resetSession(phone);
    const pickC = {
      amount,
      desc: description,
      userSheetValue,
      receipt: 'No',
      receiptImage: '',
    };
    await beginCategoryConfirmFlow(res, waNorm, phone, userSheetValue, pickC, category, {});
    return;
  }

  if (amount && !description) {
    const s = getSession(phone);
    s.state = 'AWAITING_DESCRIPTION';
    s.pendingAmount = amount;
    s.ts = Date.now();
    sendTwiML(
      res,
      `קיבלתי *${formatShekelDisplay(amount)}* ש״ח.\n\nעל איזה החזר? (למשל *פנגו* / *מונית*)`
    );
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
    sendTwiML(res, `קלטתי שזה החזר על ${description} ${emoji}. כמה ש"ח מגיעים לך פה?`);
    return;
  }

  sendTwiML(
    res,
    'לא הבנתי.\n\nשלח *סכום + תיאור* או *תמונת קבלה*.\n\n*שלום* — עזרה.'
  );
  } catch (err) {
    console.error('[whatsapp] unhandled error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      try {
        sendTwiML(res, 'מצטערים, נפלה שגיאה בשרת. נסה שוב בעוד רגע.');
      } catch (_) { /* response already ended */ }
    }
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const ctx = buildWhatsAppContext(req);
    if (!ctx.waNorm || !isAllowedWaFrom(ctx.waNorm)) {
      sendTwiML(res, 'מצטער, אין לך הרשאה להשתמש במערכת זו.');
      return;
    }
    const message = req.body.Body || '';
    const { amount, description } = parseExpenseMessage(message);
    if (amount) {
      const desc = description || '(ללא תיאור)';
      const category = matchCategory(desc);
      if (!category) {
        await startCategoryClarification(
          res,
          ctx.sessionKey,
          {
            amount,
            desc,
            userSheetValue: ctx.userSheetValue,
            receipt: 'No',
            receiptImage: '',
          },
          { waNorm: ctx.waNorm }
        );
        return;
      }
      try {
        await saveToSheet(desc, amount, category, ctx.userSheetValue);
      } catch (e) { console.error('[webhook] sheets:', e.message); }
      const { date } = formatNow();
      sendTwiML(res, buildSuccessRecordCard(amount, category, date, { awaitingReceipt: false }));
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
  const cronOwnerWaNorm = normalizeWaFrom(fmtWA(TO_WHATSAPP_NUMBER));

  cron.schedule('0 20 * * *', async () => {
    const s = getSession(cronOwnerWaNorm);
    s.state = 'AWAITING_DAILY_REPLY';
    s.ts = Date.now();
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, '*תזכורת יומית*\n\nהיו היום החזרים לרשום?\n\n*כן* / *לא*');
  }, { timezone: CRON_TZ });

  cron.schedule('0 10 * * 0', async () => {
    try {
      const missing = await getMissingReceiptRows(cronOwnerWaNorm);
      if (missing.length === 0) return;
      const lines = [`*קבלות חסרות (${missing.length})*\n\nאישרת שיש קבלה לכולם?`, ''];
      for (const r of missing.slice(0, 10)) lines.push(`• ${r.desc} — *${formatShekelDisplay(r.amt)}* ש״ח`);
      if (missing.length > 10) lines.push(`...ועוד ${missing.length - 10}`);
      await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, lines.join('\n'));
    } catch (e) { console.error('[cron] Missing receipts failed:', e.message); }
  }, { timezone: CRON_TZ });

  cron.schedule('0 20 25 * *', async () => {
    try {
      const open = await getUnsubmittedRows(cronOwnerWaNorm);
      if (open.length === 0) return;
      const total = open.reduce((s, r) => s + r.amt, 0);
      await sendWhatsAppMessage(
        TO_WHATSAPP_NUMBER,
        `*תזכורת הגשה*\n\nיש *${open.length}* רישומים פתוחים, סה״כ *${formatShekelDisplay(total)}* ש״ח.\n\nשלח *הגשתי* לסמן הכול.`
      );
    } catch (e) { console.error('[cron] Deadline alert failed:', e.message); }
  }, { timezone: CRON_TZ });

  cron.schedule('0 20 29 * *', async () => {
    await sendWhatsAppMessage(
      TO_WHATSAPP_NUMBER,
      '*תזכורת חודשית*\n\nזמן לסגור החזרים — שלח *סיכום* לריכוז.'
    );
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
  const ks = require('./kibbutzSmart');
  const hairEntry = ks.findKibbutzEntryForText('תספורת', '400 תספורת');
  t('kibbutz smart topic תספורת', hairEntry?.topic === 'תספורת וקוסמטיקה');
  t('kibbutz cap note over limit', !!(hairEntry && ks.capNoteFromEntry(400, hairEntry)));
  const a = parseExpenseMessage('150 דלק');
  t('parse "150 דלק"', a.amount === 150 && a.description === 'דלק');
  const b = parseExpenseMessage('הוצאתי 50 שקל על דלק');
  t('parse sanitize', b.amount === 50 && b.description === 'דלק');
  const c = parseExpenseMessage('בסך 45 חניה');
  t('parse בסך + החניה', c.amount === 45 && (c.description.includes('חניה') || c.description === 'חניה'));
  t('category פנגו → חנייה', matchCategory('בחנייה') === CAT.parking);
  t('category מונית', matchCategory('למונית') === CAT.taxi);
  t('category אוטובוס', matchCategory('45 אוטובוס') === CAT.transit);
  t('resolve פנגו', resolveCategoryFromReply('פנגו') === CAT.parking);
  t('resolve list id CAT_K_TAXI', resolveCategoryFromReply('CAT_K_TAXI') === CAT.taxi);
  t('intent "הסיכום"', matchesAny('הסיכום', INTENT_SUMMARY));
  t('detect summary "תראה לי"', detectSummaryIntent('תראה לי מה יש', 'תראה לי מה יש'));
  t('detect summary סטטיסטיקה', detectSummaryIntent('סטטיסטיקה', 'סטטיסטיקה'));
  t('detect help', detectHelpIntent('איך להשתמש', 'איך להשתמש בבוט'));
  t('detect delete מחק', detectDeleteIntent('מחק', 'מחק'));
  t('detect delete excludes מחק שורה', !detectDeleteIntent('מחק שורה', 'מחק שורה'));
  t('intent "מה לא הוגש"', matchesAny('מה לא הוגש', INTENT_NOT_SUBMITTED));
  t('intent "הגשתי"', matchesAny('הגשתי', INTENT_MARK_SUBMITTED));
  t('intent "ניהול"', matchesAny('ניהול', INTENT_MANAGEMENT));
  t('intent "מחק שורה"', matchesAny('מחק שורה', INTENT_MANAGEMENT));
  t('MoM total insight up', formatMoMTotalInsight(120, 100, 'ינואר').includes('20%'));
  t('QuickChart doughnut JS config', (() => {
    const js = buildMonthlySummaryDoughnutChartJs([
      [CAT.parking, 40],
      [CAT.taxi, 60],
    ]);
    return (
      js.includes('doughnut') &&
      js.includes('datalabels') &&
      js.includes('ריכוז החזרים') &&
      js.includes('Varela Round') &&
      js.includes('#FFB5C2')
    );
  })());
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
    { name: '150 מונית → אישור קטגוריה', fields: { Body: '150 מונית', From: F } },
    { name: 'כן → קבלה', fields: { Body: 'כן', From: F } },
    { name: 'לא → בלי קבלה', fields: { Body: 'לא', From: F } },
    { name: '80 סלולר → אישור קטגוריה', fields: { Body: '80 סלולר', From: F } },
    { name: 'אש → המשך', fields: { Body: 'אש', From: F } },
    { name: 'מחק → delete flow', fields: { Body: 'מחק', From: F } },
    { name: '42 → ask desc', fields: { Body: '42', From: F } },
    { name: 'פנגו → אישור קטגוריה', fields: { Body: 'פנגו', From: F } },
    { name: 'סגור → קבלה', fields: { Body: 'סגור', From: F } },
    { name: 'img-only → ask details', fields: { Body: '', From: F, NumMedia: '1', MediaUrl0: 'https://example.com/img.jpg', MediaContentType0: 'image/jpeg' } },
    { name: '55 מונית → אישור', fields: { Body: '55 מונית', From: F } },
    { name: 'כן אישור קטגוריה 55', fields: { Body: 'כן', From: F } },
    { name: 'לא בלי קבלה 55', fields: { Body: 'לא', From: F } },
    { name: '3000 מונית → אישור קטגוריה', fields: { Body: '3000 מונית', From: F } },
    { name: 'כן קטגוריה גבוהה', fields: { Body: 'כן', From: F } },
    { name: 'כן סכום גבוה', fields: { Body: 'כן', From: F } },
    { name: 'לא קבלה אחרי גבוה', fields: { Body: 'לא', From: F } },
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

const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';

if (process.env.SMOKE_TEST === '1' && process.env.NODE_ENV === 'production') {
  console.warn('[smoke] SMOKE_TEST=1 ignored in production — starting normal server');
}

if (process.env.SMOKE_TEST === '1' && process.env.NODE_ENV !== 'production') {
  runLocalUnitChecks();
  const server = app.listen(PORT, LISTEN_HOST, async () => {
    console.log(`[smoke] Temp server on ${LISTEN_HOST}:${PORT}`);
    try { await runHttpSmokeTests(PORT); }
    finally { server.close(() => process.exit(0)); }
  });
} else {
  app.listen(PORT, LISTEN_HOST, () => {
    console.log(`Listening on http://${LISTEN_HOST}:${PORT}`);
    console.log('GET /health  |  POST /whatsapp  |  POST /webhook');
  });
}
