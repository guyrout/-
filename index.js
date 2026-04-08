/**
 * בוט WhatsApp — "החבר החכם" (The Savvy Friend): מעקב החזרים, לא לפספס כסף.
 * Twilio + Google Sheets + Google Drive לתמונות קבלה.
 * Columns: A–H as before | I User (ProfileName + E.164, used for multi-user filtering)
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
const MessagingResponse = twilio.twiml.MessagingResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));

// ===================== Persona: The Savvy Friend (החבר החכם להחזרים) =====================

/** Exact copy when Drive upload fails — do not paraphrase */
const DRIVE_UPLOAD_FAIL_USER_MSG =
  'שמע, הגוגל דרייב עושה קצת בעיות... אל תיתן לכסף הזה ללכת לאיבוד, תנסה לשלוח לי את הקבלה שוב? או שבנתיים תשמור אותה אצלך שלא תלך לאיבוד.';

function savvySuccessDriveAndSheets(amount) {
  return `יש, קלטתי! העליתי לדרייב ורשמתי בשיטס. עוד ${amount} ש"ח שנכנסו לרשימת ה-מגיע לי שלך. 💰`;
}

function savvySummaryTotalLine(total) {
  return `עשיתי בדיקה זריזה... הצטברו לך ${total} ש"ח שמחכים להחזר. כסף על הרצפה! 📈`;
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

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/** WhatsApp Content API (quick-reply / list-picker); optional env overrides */
let contentSidReceiptQr = (process.env.TWILIO_CONTENT_SID_RECEIPT_QR || '').trim();
let contentSidCategoryList = (process.env.TWILIO_CONTENT_SID_CATEGORY_LIST || '').trim();
/** v2: quick-reply titles סיכום חודשי 📊 / מחיקה 🗑️; bump if Twilio copy changes */
const CONTENT_FN_RECEIPT_QR = 'expense_bot_receipt_success_qr_v2';
const CONTENT_FN_CATEGORY_LIST = 'expense_bot_category_list_he_v2';
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
const INTENT_CONFIRM_YES = ['כן', 'yes', 'כ', 'בטוח', 'נכון'];
const INTENT_CONFIRM_NO = ['לא', 'no', 'ל'];
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

// ===================== Category mapping (Sheet = exactly these 5) =====================

const CANONICAL_CATEGORIES = ['חניה', 'נסיעות', 'אגרות', 'תקשורת', 'ציוד משרדי'];

/** Multi-word phrases first so "כביש 6" wins over loose tokens */
const CATEGORY_MAP = [
  {
    category: 'חניה',
    keywords: ['סלופארק', 'slopark', 'פנגו', 'pango', 'חניון', 'חנייה', 'חניה'],
  },
  {
    category: 'נסיעות',
    keywords: ['נסיעות', 'נסיעה', 'יאנגו', 'yango', 'גט', 'gett', 'מונית', 'אוטובוס', 'רכבת', 'דלק', 'טאקסי', 'taxi'],
  },
  {
    category: 'אגרות',
    keywords: ['אגרות', 'הנתיב המהיר', 'חוצה צפון', 'כביש 6', 'כביש6', 'אגרה'],
  },
  {
    category: 'תקשורת',
    keywords: ['תקשורת', 'חבילת גלישה', 'סים', 'sim', 'סלולר', 'אינטרנט'],
  },
  {
    category: 'ציוד משרדי',
    keywords: ['ציוד משרדי', 'מקלדת', 'עכבר', 'נייר', 'דיו', 'משרד', 'ציוד'],
  },
];

const CLARIFY_CATEGORY_MSG =
  '*בחר קטגוריה*\nשמע, הקבלה אצלי אבל לא נתפסתי לאן לשייך — כתוב מילה אחת: *חניה*, *נסיעות*, *אגרות*, *תקשורת* או *ציוד משרדי*. לא נותנים לכסף לברוח 🕵️‍♂️';

/** List-picker / payload id → Sheet category (must match CANONICAL_CATEGORIES) */
const LIST_ITEM_ID_TO_CATEGORY = {
  CAT_PARKING: 'חניה',
  CAT_TRAVEL: 'נסיעות',
  CAT_TOLLS: 'אגרות',
  CAT_COMMS: 'תקשורת',
  CAT_OFFICE: 'ציוד משרדי',
};

/** Quick-reply button payloads (inbound ButtonPayload) */
const QR_PAYLOAD_SUMMARY = 'btn_summary';
const QR_PAYLOAD_UNDO_LAST = 'btn_undo_last';

const CATEGORY_RETRY_MSG =
  'לא נתפסתי… נסה מילה אחת: *חניה*, *נסיעות*, *אגרות*, *תקשורת* או *ציוד משרדי* 🍺';

const CATEGORY_EMOJI = {
  חניה: '🅿️',
  נסיעות: '🚗',
  אגרות: '🛣️',
  תקשורת: '📱',
  'ציוד משרדי': '🖊️',
};

function normalizeCategoryText(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[״"']/g, '')
    .toLowerCase();
}

/** Levenshtein for fuzzy match (ASCII + Hebrew safe as string ops) */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prevDiag = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const above = row[j] + 1;
      const left = row[j - 1] + 1;
      const diag = prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1);
      prevDiag = row[j];
      row[j] = Math.min(above, left, diag);
    }
  }
  return row[n];
}

function textIncludesPhrase(hayNorm, phraseNorm) {
  if (!phraseNorm) return false;
  return hayNorm.includes(phraseNorm);
}

function fuzzyTokenMatch(tokenNorm, keywordNorm) {
  if (!tokenNorm || !keywordNorm) return false;
  if (tokenNorm === keywordNorm) return true;
  if (keywordNorm.length <= 2) return false;
  const maxDist = keywordNorm.length <= 4 ? 1 : 2;
  return levenshtein(tokenNorm, keywordNorm) <= maxDist;
}

/**
 * Match description to one of CANONICAL_CATEGORIES, or null if unknown.
 * Uses substring (phrases), keyword tokens, Hebrew prefix strip, and light fuzzy match.
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

  for (const { category, keywords } of CATEGORY_MAP) {
    for (const kw of keywords) {
      const kn = normalizeCategoryText(kw);
      if (kn.includes(' ')) {
        if (textIncludesPhrase(hayNorm, kn)) return category;
        continue;
      }
      if (hayNorm.includes(kn)) return category;
    }
  }

  const tokens = hayNorm.split(/\s+/).filter(Boolean);
  for (const { category, keywords } of CATEGORY_MAP) {
    for (const kw of keywords) {
      const kn = normalizeCategoryText(kw);
      if (kn.includes(' ')) continue;
      for (const tok of tokens) {
        if (fuzzyTokenMatch(tok, kn)) return category;
      }
    }
  }

  return null;
}

/**
 * Resolve user's one-word (or short) reply to a canonical category name for the Sheet.
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
    const cn = normalizeCategoryText(canon);
    if (
      blobNorm === cn ||
      trimmed === canon ||
      trimmed.includes(canon) ||
      blobNorm.includes(cn)
    ) {
      return canon;
    }
  }
  if (/ציוד|משרד|דיו|נייר|עכבר|מקלדת/i.test(trimmed)) return 'ציוד משרדי';
  if (/תקשורת|סלולר|אינטרנט|סים|sim|גלישה/i.test(trimmed)) return 'תקשורת';
  if (/אגר|כביש|נתיב|חוצה/i.test(trimmed)) return 'אגרות';
  if (/נסיע|מונית|דלק|רכבת|אוטובוס|גט|gett|yango|יאנגו|טאקסי/i.test(trimmed)) return 'נסיעות';
  if (/חניה|חנייה|חניון|פנגו|pango|סלופארק|slopark/i.test(trimmed)) return 'חניה';

  const single = normalizeCategoryText(trimmed.split(/\s+/)[0] || trimmed);
  for (const { category, keywords } of CATEGORY_MAP) {
    for (const kw of keywords) {
      const kn = normalizeCategoryText(kw);
      if (kn.includes(' ')) continue;
      if (fuzzyTokenMatch(single, kn)) return category;
    }
  }

  for (const canon of CANONICAL_CATEGORIES) {
    const cn = normalizeCategoryText(canon);
    if (fuzzyTokenMatch(single, cn)) return canon;
  }

  return null;
}

function categoryEmoji(description) {
  const cat = matchCategory(description);
  if (!cat) return '💰';
  return CATEGORY_EMOJI[cat] || '💰';
}

function confirmCategorySavedExact(category) {
  return `סגור, רשמתי תחת ${category}. תודה!`;
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

const MEDIA_PROCESSING_ACK_MSG =
  'קיבלתי! רגע, אני מעלה את זה לדרייב ורושם לך הכל שלא ילך לאיבוד... 🕵️‍♂️';

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
    חניה: 'חנייה, פנגו, חניון',
    נסיעות: 'מונית, דלק, תחבורה',
    אגרות: 'כביש, נתיב, חוצה ישראל',
    תקשורת: 'סלולר, אינטרנט',
    'ציוד משרדי': 'משרד, ציוד',
  };
  const idByCat = {
    חניה: 'CAT_PARKING',
    נסיעות: 'CAT_TRAVEL',
    אגרות: 'CAT_TOLLS',
    תקשורת: 'CAT_COMMS',
    'ציוד משרדי': 'CAT_OFFICE',
  };
  return CANONICAL_CATEGORIES.map((cat) => ({
    item: clipWhatsAppListField(cat, 24),
    description: clipWhatsAppListField(meta[cat] || cat, 72),
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
  const t1 = 'סיכום חודשי 📊';
  const t2 = 'מחיקה 🗑️';
  const payload = {
    friendly_name: CONTENT_FN_RECEIPT_QR,
    language: 'he',
    variables: { 1: 'אישור רישום' },
    types: {
      'twilio/text': {
        body: '{{1}}\n\n*מה הלאה?* סיכום חודשי או מחיקה — אפשר גם *סיכום* / *מחק*. החבר החכם כאן 🍺',
      },
      'twilio/quick-reply': {
        body: '{{1}}\n\n*מה עושים עכשיו?* שתי הקשות למטה — או במילים, בלי בושה 🕵️‍♂️',
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
        body: '*בחר קטגוריה*\nשמע, לא נתפסתי לאן לשייך — בוחרים מהרשימה ואני סוגר לך את הפינה 🍺',
      },
      'twilio/list-picker': {
        body: '*בחר קטגוריה*\nלא בטוח איפה זה יושב? לוחצים על הכפתור — והכסף לא הולך לאיבוד 💰',
        button: 'בחר קטגוריה',
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

async function initializeWhatsAppContentTemplates() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  try {
    const byName = await fetchContentFriendlyNameToSid();
    if (!contentSidReceiptQr) contentSidReceiptQr = byName.get(CONTENT_FN_RECEIPT_QR) || '';
    if (!contentSidReceiptQr) contentSidReceiptQr = await createReceiptQuickReplyTemplate();
    if (!contentSidCategoryList) contentSidCategoryList = byName.get(CONTENT_FN_CATEGORY_LIST) || '';
    if (!contentSidCategoryList) contentSidCategoryList = await createCategoryListTemplate();
    console.log(
      '[config] Twilio Content SIDs:',
      contentSidReceiptQr ? `${contentSidReceiptQr.slice(0, 8)}…` : '(receipt QR off)',
      '|',
      contentSidCategoryList ? `${contentSidCategoryList.slice(0, 8)}…` : '(category list off)'
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
      `${confirmationBody}\n\n*מה הלאה?*\n• *סיכום חודשי* — כתוב *סיכום*\n• *מחיקה* — כתוב *מחק* (או כפתור כשמופיע)\nהחבר החכם לא שופט, רק שומר על הכיס 🕵️‍♂️`
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

const SHEET_HEADERS = [
  'Date', 'Description', 'Amount', 'Category', 'Receipt', 'Submitted', 'Time', 'ReceiptImage', 'User',
];

async function ensureHeaders(sheet) {
  await sheet.loadHeaderRow(1);
  const h = sheet.headerValues || [];
  if (h.filter(Boolean).length === 0) {
    await sheet.setHeaderRow(SHEET_HEADERS);
    return;
  }
  if (!h.includes('User')) {
    console.warn(
      '[sheet] Add a "User" header in column I (or extend row 1) so multi-user rows can be stored and filtered.'
    );
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

async function appendExpenseRow(description, amount, category, receipt, receiptImage, userValue) {
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
    User: userValue || '',
  });
  console.log('[sheets] Sheet row added:', row ? `rowNumber=${row.rowNumber}` : '(null)');
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
      amt, cat: getCol(row, 'Category') || '',
      desc: getCol(row, 'Description'), receipt: getCol(row, 'Receipt'),
      submitted: getCol(row, 'Submitted'), date: getCol(row, 'Date'),
      time: getCol(row, 'Time'), receiptImage: getCol(row, 'ReceiptImage'),
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
  let count = 0;
  for (const entry of data.rows) {
    if (entry.submitted !== 'Yes' && entry.row) {
      await updateRowField(entry.row, 'Submitted', 'Yes');
      count++;
    }
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

const SUMMARY_FOOTERS = [
  'אל תהיה פראייר — שמור קבלות, אל תפספס החזרים! 📑',
  'הכסף הזה אמור לחזור אליך — לא נותנים לו לברוח 💰',
  'סדר בשיטס = פחות כסף על הרצפה 🍺',
];

async function buildMonthlySummary(ownerWaNorm) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
  if (!data) return null;
  const { rows, curMonth } = data;
  const monthName = HEB_MONTHS[curMonth];

  if (rows.length === 0) {
    return 'עדיין אין לך החזרים רשומים לחודש הזה. אל תפספס — שלח רישום ונעקוב אחרי הכסף? 🍺';
  }

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
  for (const [, t] of categoryTotals) grandTotal += t;

  const lines = [];
  lines.push(savvySummaryTotalLine(grandTotal));
  lines.push('');
  lines.push(`📊 *סיכום החזרים חודשי - ${monthName}* 🕵️‍♂️`);
  lines.push('─────────────────────');

  for (const [cat, total] of [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])) {
    const emoji = CATEGORY_EMOJI[cat] || cat.match(/\p{Emoji_Presentation}/u)?.[0] || '•';
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

  try {
    const prev = await getPrevMonthData(ownerWaNorm);
    const mom = momLine(categoryTotals, prev.totals, prev.monthName);
    if (mom) { lines.push(''); lines.push(mom); }
  } catch (_) {}

  lines.push('');
  if (noReceipt > 0) lines.push(`⚠️ ${noReceipt} רישומי החזר בלי קבלה — אל תפספס`);
  if (notSubmitted > 0) lines.push(`📝 ${notSubmitted} החזרים עדיין לא סומנו כהוגשו`);
  lines.push('');
  lines.push(SUMMARY_FOOTERS[Math.floor(Math.random() * SUMMARY_FOOTERS.length)]);
  return lines.join('\n');
}

async function buildMonthlyStats(ownerWaNorm) {
  const data = await getCurrentMonthRows(false, ownerWaNorm);
  if (!data) return null;
  const { rows, curMonth } = data;
  const monthName = HEB_MONTHS[curMonth];

  if (rows.length === 0) return 'עדיין אין מספיק נתונים לניתוח. רשום עוד החזרים ונסה שוב! 📈';

  const categoryTotals = buildCategoryTotals(rows);
  let grandTotal = 0;
  for (const v of categoryTotals.values()) grandTotal += v;

  const sorted = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
  const [topCat, topAmt] = sorted[0];
  const topPct = grandTotal > 0 ? Math.round((topAmt / grandTotal) * 100) : 0;

  const lines = [];
  lines.push(`📊 *ניתוח החזרים חודשי - ${monthName}* 🕵️‍♂️`);
  lines.push('─────────────────────');
  lines.push(`הקטגוריה הכי בולטת אצלך היא *${topCat}* עם *${topAmt} ₪* שמחכים להחזר.`);
  lines.push(`זה *${topPct}%* מכלל הכסף שרשמנו החודש 💰`);
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
  'AWAITING_DAILY_REPLY',
]);

/**
 * States:
 *   IDLE, AWAITING_DESCRIPTION, AWAITING_AMOUNT, AWAITING_HIGH_CONFIRM,
 *   AWAITING_RECEIPT_IMAGE  — text-first: waiting for image or כן/לא (5 min)
 *   AWAITING_EXPENSE_DETAILS — image-first: waiting for text (amount+desc)
 *   AWAITING_CATEGORY_CLARIFICATION — תיאור בלי מילת מפתח לקטגוריה (5 קטגוריות)
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
    sendTwiML(res, 'אין רישומי החזר החודש למחיקה. רוצה להוסיף אחד שלא ילך לאיבוד? 🍺');
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
    'טעות? קורה. בוא נתקן בלי לאבד כסף 🍺',
    `הנה עד *${items.length}* הרישומים האחרונים של החודש — שלח *מספר* למחיקה:`,
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
    desc: getCol(row, 'Description'),
    amt: parseFloat(getCol(row, 'Amount')) || 0,
    receiptImage: getCol(row, 'ReceiptImage'),
  };
  us.managementEditRow = entry;
  return entry;
}

async function buildAndSendManagementList(res, phone, waNorm) {
  const data = await getCurrentMonthRows(true, waNorm);
  if (!data || data.rows.length === 0) {
    sendTwiML(res, 'אין רישומי החזר לחודש הזה. שלח אחד ונשמור על הכסף 💰');
    return;
  }

  const items = [];
  const header = `📋 *ניהול החזרים — ${HEB_MONTHS[data.curMonth]}* 🕵️‍♂️\nשלח מספר שורה לעריכה (תוקף 10 דק׳):\n`;

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

function confirmWithImageMsg(amount, desc, category) {
  return (
    `*סגרנו — הקבלה בפנים* ✅\n` +
    `${savvySuccessDriveAndSheets(amount)}\n` +
    `*קטגוריה:* ${category} 🍺\n` +
    `טעות? *מחק* או *טעות* — נעשה סדר, לא נותנים לכסף לברוח 🕵️‍♂️`
  );
}

function confirmTextFirstMsg(amount, desc, category) {
  return (
    `*נרשם — עוד כסף ברשימה* 💰\n` +
    `קלטתי *${amount} ₪* על *${desc}*, תחת *${category}*.\n\n` +
    `יש קבלה? שלח תמונה או ענה *כן* / *לא* — אל תפספס החזר 📸\n` +
    `משהו לא מדויק? *מחק* או *טעות*. החבר החכם כאן 🕵️‍♂️`
  );
}

async function saveFullRow(phone, userSheetValue, amount, desc, category, receipt, receiptImage) {
  const row = await appendExpenseRow(desc, amount, category, receipt, receiptImage, userSheetValue);
  const rowIndex = row ? row.rowNumber : null;
  console.log(`[sheets] saved row ${rowIndex} for ${phone}`);
  const us = getUserState(phone);
  us.lastRowIndex = rowIndex;
  us.lastRowTs = Date.now();
  return rowIndex;
}

const QUICK_UNDO_TTL_MS = 15 * 60 * 1000;

async function handleUndoLastReceiptQuickAction(res, phone, waNorm) {
  const us = getUserState(phone);
  const idx = us.lastRowIndex;
  const ts = us.lastRowTs || 0;
  if (!idx) {
    sendTwiML(res, '*אין מה למחוק מהר*\nלא נשמר אצלי רישום אחרון — שלח *מחק* לבחירה מהרשימה. 🍺');
    return;
  }
  if (Date.now() - ts > QUICK_UNDO_TTL_MS) {
    us.lastRowIndex = null;
    us.lastRowTs = null;
    sendTwiML(res, '*פג הזמן למחיקה מהירה*\nעבר יותר מדי זמן — שלח *מחק* ונבחר ידנית מה לנקות 🕵️‍♂️');
    return;
  }
  const row = await getRowByIndexIfOwned(idx, waNorm);
  if (!row) {
    us.lastRowIndex = null;
    us.lastRowTs = null;
    sendTwiML(res, '*לא מצאתי את השורה*\nאולי כבר נמחקה או שזה לא שלך — נסה *ניהול*.');
    return;
  }
  const img = (getCol(row, 'ReceiptImage') || '').trim();
  if (img) await deleteDriveFileByUrl(img);
  const ok = await deleteRowByIndexForOwner(idx, waNorm);
  us.lastRowIndex = null;
  us.lastRowTs = null;
  resetSession(phone);
  sendTwiML(
    res,
    ok
      ? '*נקיון בעסק* ✨\nמחקתי את הרישום האחרון מהשיטס (ובדרייב אם הייתה קבלה). סדר 💰'
      : '*אופס*\nמשהו נתקע במחיקה — נסה *ניהול*, לא נותנים לכסף לברוח 🍺'
  );
}

/** After user picks category in AWAITING_CATEGORY_CLARIFICATION (exact confirm copy per product spec). */
async function completeExpenseAfterCategoryClarification(res, phone, userSheetValue, category, pick) {
  const amount = pick.amount;
  const desc = pick.desc;
  const receipt = pick.receipt || 'No';
  const receiptImage = pick.receiptImage || '';

  if (amount > HIGH_AMOUNT_THRESHOLD) {
    resetSession(phone);
    const s = getSession(phone);
    s.state = 'AWAITING_HIGH_CONFIRM';
    s.pendingAmount = amount;
    s.pendingDesc = desc;
    s.pendingCategory = category;
    s.pendingDriveLink = receiptImage || '';
    s.ts = Date.now();
    sendTwiML(res, `זה סכום גבוה מהרגיל (*${amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`);
    return;
  }

  try {
    const rowIdx = await saveFullRow(phone, userSheetValue, amount, desc, category, receipt, receiptImage);
    resetSession(phone);
    if (receipt === 'Yes' && receiptImage) {
      emptyTwiMLResponse(res);
      await sendReceiptSuccessQuickReply(phone, confirmWithImageMsg(amount, desc, category));
      return;
    }
    sendTwiMLMulti(res, [
      confirmCategorySavedExact(category),
      'יש קבלה לצרף? שלח תמונה או כן / לא 💰',
    ]);
    const ns = getSession(phone);
    ns.state = 'AWAITING_RECEIPT_IMAGE';
    ns.receiptRowIndex = rowIdx;
    ns.ts = Date.now();
  } catch (e) {
    console.error('[sheets] append failed:', e.message);
    sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
  }
}

// ===================== Response Templates =====================

function buildCategoriesList() {
  const lines = ['📋 *רק הקטגוריות האלה בשיטס:*', ''];
  for (const { keywords, category } of CATEGORY_MAP) lines.push(`• *${category}* — ${keywords.join(', ')}`);
  lines.push('');
  lines.push('מילה מהרשימה = אני משייך אוטומטית. לא בטוח? אשאל אותך 🕵️‍♂️');
  return lines.join('\n');
}

function buildGreeting() {
  return (
    'היי! אני החבר החכם שלך למעקב החזרים — *אל תהיה פראייר, אל תפספס החזרים*. 💰\n\n' +
    '*רישום החזר:*\n' +
    '• *סכום + תיאור* (למשל: *150 דלק*)\n' +
    '• *תמונת קבלה* עם כיתוב — דרייב + שיטס בבת אחת\n' +
    '• *תמונה בלבד* — אבקש ממך פרטים\n\n' +
    '*מה עוד יש:*\n' +
    '• *"סיכום"* / *"תראה לי"* / *"כמה הוצאתי"* — כמה כסף מחכה להחזר\n' +
    '• *"עזרה"* — המדריך\n' +
    '• *"מחק"* / *"טעות"* — תיקון עם אישור\n' +
    '• *"ניהול"* — כל רישומי החזר החודש בשורות\n\n' +
    '*הגשות:*\n' +
    '• *"מה לא הוגש"* • *"הגשתי"*\n\n' +
    'יאללה, לא מפספסים החזרים 🕵️‍♂️'
  );
}

function buildHelpGuide() {
  return (
    'היי! החבר החכם פה 🍺\n\n' +
    '*רישום החזר:* סכום + תיאור, או תמונת קבלה (עם או בלי טקסט).\n' +
    '*סיכום:* *"סיכום"*, *"תראה לי"* או *"כמה הוצאתי"* — רואים כמה ש"ח מחכים להחזר.\n' +
    '*טעות:* *"מחק"* / *"טעות"* — רשימה קצרה ואישור כן/לא.\n' +
    '*ניהול:* *"ניהול"* — כל ההחזרים שרשמת החודש.\n' +
    '*קטגוריות / הגשה:* *"קטגוריות"*, *"מה לא הוגש"*, *"הגשתי"*.\n\n' +
    'נתקעת? *"שלום"* ומתחילים מחדש. אל תהיה פראייר עם כסף על הרצפה 💰'
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
}
logConfigOnce();

// ===================== Routes =====================

const TWILIO_FROM_TEST = 'whatsapp:+15551234567';

app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
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
        await updateRowByIndexForOwner(session.receiptRowIndex, 'Receipt', 'No', waNorm);
      } catch (_) {}
    }
    if (MANAGEMENT_STATES.has(session.state)) clearManagement(phone);
    if (DELETE_FLOW_STATES.has(session.state)) clearDeleteFlow(phone);
    resetSession(phone);
  }

  const ib = parseInboundInteractive(req);
  if (session.state === 'AWAITING_CATEGORY_CLARIFICATION' && ib.categoryPayload) {
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

  const MGMT_OK = 'בוצע! עדכנתי בשיטס — עוקבים אחרי הכסף שמגיע לך 💰';

  const summaryQuick =
    ib.btnPayload === QR_PAYLOAD_SUMMARY ||
    (!ib.btnPayload && ib.btnText && /סיכום\s*חודשי/i.test(ib.btnText));
  const undoQuick =
    ib.btnPayload === QR_PAYLOAD_UNDO_LAST ||
    (!ib.btnPayload && ib.btnText && /^מחיקה/i.test(ib.btnText.trim()));

  if (summaryQuick) {
    try {
      const txt = await buildMonthlySummary(waNorm);
      sendTwiML(res, txt || savvySummaryTotalLine(await sumAmountColumn(waNorm)));
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

  // ─── AWAITING_CATEGORY_CLARIFICATION ───
  if (session.state === 'AWAITING_CATEGORY_CLARIFICATION') {
    const pick = session.pendingCategoryPick;
    if (!pick || typeof pick.amount !== 'number' || Number.isNaN(pick.amount)) {
      resetSession(phone);
      sendTwiML(res, 'פג תוקף או חסרים נתונים — שלח שוב *סכום + תיאור*. 🍺');
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
    await completeExpenseAfterCategoryClarification(res, phone, userSheetValue, cat, pick);
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
            await updateMultipleFieldsByIndexForOwner(rowNum, {
              Receipt: (driveLink || oldLink) ? 'Yes' : 'No',
              ReceiptImage: driveLink || oldLink || '',
            }, waNorm);
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
      const updates = { Description: newDesc };
      if (cat) updates.Category = cat;
      await updateMultipleFieldsByIndexForOwner(rowNum, updates, waNorm);
      await refreshManagementEditSnapshot(phone, waNorm);
      session.state = 'MANAGEMENT_EDIT_MENU';
      touchMgmt();
      const catNote = cat
        ? ''
        : '\n(הקטגוריה בגיליון נשארה כמו שהייתה — הוסף מילה מפתח: חניה, נסיעות, אגרות…)';
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
            await updateMultipleFieldsByIndexForOwner(rowNum, {
              Receipt: finalImg ? 'Yes' : 'No',
              ReceiptImage: finalImg || '',
            }, waNorm);
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
        const oldLink = us.managementEditRow?.receiptImage || '';
        if (oldLink) await deleteDriveFileByUrl(oldLink);
        const delOk = await deleteRowByIndexForOwner(rowNum, waNorm);
        clearManagement(phone);
        resetSession(phone);
        sendTwiML(
          res,
          delOk
            ? 'בוצע! השורה נמחקה מהשיטס. ✨\nשלח *ניהול* לרשימה מעודכנת.'
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
        const row = await getRowByIndexIfOwned(item.sheetRowNumber, waNorm);
        if (!row) {
          sendTwiML(res, 'השורה לא נמצאה או אינה שלך. שלח *ניהול* מחדש.');
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
          ? 'מחקתי את הרישום מהשיטס. אם הייתה קבלה בדרייב — ניסיתי לנקות גם שם. סדר 💰'
          : 'לא הצלחתי למחוק את השורה, נסה שוב או השתמש ב*ניהול*.'
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
      `מחכה ל*כן* או *לא*: האם למחוק את *${pd.desc}* בסך *${pd.amt} ₪*?`
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
        try { await updateRowByIndexForOwner(rowIdx, 'Receipt', 'No', waNorm); } catch (_) {}
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
          if (rowIdx) {
            const updates = {
              Receipt: driveLink ? 'Yes' : 'No',
              ReceiptImage: driveLink || '',
            };
            await updateMultipleFieldsByIndexForOwner(rowIdx, updates, waNorm);
          }
          resetSession(phone);
          if (driveLink && rowIdx) {
            const row = await getRowByIndexIfOwned(rowIdx, waNorm);
            if (row) {
              const amt = parseFloat(getCol(row, 'Amount')) || 0;
              const d = getCol(row, 'Description') || '';
              const cat = getCol(row, 'Category') || '';
              await sendReceiptSuccessQuickReply(waNorm, confirmWithImageMsg(amt, d, cat));
            } else {
              await replyWhatsAppToUser(
                waNorm,
                '📸 יש! קבלה בדרייב ובשיטס 💰\nלביטול הרישום — *מחק*'
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
    if (lower === 'כן' || lower === 'yes') {
      if (rowIdx) await updateRowByIndexForOwner(rowIdx, 'Receipt', 'Yes', waNorm);
      resetSession(phone);
      sendTwiML(res, '✅ סבבה, קבלה מאושרת — לא מפספסים 🍺\nלביטול — *מחק*');
      return;
    }
    if (lower === 'לא' || lower === 'no') {
      if (rowIdx) await updateRowByIndexForOwner(rowIdx, 'Receipt', 'No', waNorm);
      resetSession(phone);
      sendTwiML(res, '📌 תשמור את הקבלה — זה הכסף שלך, לא של מישהו אחר 💰\nלביטול — *מחק*');
      return;
    }
    sendTwiML(
      res,
      'לא הבנתי 🤔 עדיין מחכה ל*תמונת קבלה* או ל*כן* / *לא*.\n' +
        'רוצה לתקן? שלח *מחק* או *טעות* — אעזור לבחור מה למחוק.'
    );
    return;
  }

  // ─── AWAITING_EXPENSE_DETAILS: image-first, now expecting text ───
  if (session.state === 'AWAITING_EXPENSE_DETAILS') {
    const pendingDriveLink = session.pendingDriveLink || '';
    const { amount, description } = parseExpenseMessage(trimmed);
    if (amount) {
      const desc = description || '(ללא תיאור)';
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
        const receipt = pendingDriveLink ? 'Yes' : 'No';
        const rowIdx = await saveFullRow(phone, userSheetValue, amount, desc, category, receipt, pendingDriveLink || '');
        if (pendingDriveLink) {
          emptyTwiMLResponse(res);
          await sendReceiptSuccessQuickReply(waNorm, confirmWithImageMsg(amount, desc, category));
        } else {
          const ns = getSession(phone);
          ns.state = 'AWAITING_RECEIPT_IMAGE';
          ns.receiptRowIndex = rowIdx;
          ns.ts = Date.now();
          sendTwiML(
            res,
            `קלטתי 🙂 *${amount} ₪* על *${desc}*, תחת ${category}.\n\n${DRIVE_UPLOAD_FAIL_USER_MSG}\n\nהרישום בשיטס — שלח *תמונה שוב* או *כן* / *לא*.`
          );
        }
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }
    sendTwiML(res, 'לא קלטתי סכום. *סכום + תיאור* (למשל: *50 חניה*) — אל תפספס החזר 🍺');
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

          if (amount > HIGH_AMOUNT_THRESHOLD) {
            const s = getSession(phone);
            s.state = 'AWAITING_HIGH_CONFIRM';
            s.pendingAmount = amount;
            s.pendingDesc = desc;
            s.pendingCategory = category;
            s.pendingDriveLink = driveLink || '';
            s.ts = Date.now();
            await replyWhatsAppToUser(
              waNorm,
              `זה סכום גבוה מהרגיל (*${amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`
            );
            return;
          }

          try {
            const receipt = driveLink ? 'Yes' : 'No';
            const rowIdx = await saveFullRow(phone, userSheetValue, amount, desc, category, receipt, driveLink || '');
            if (driveLink) {
              await sendReceiptSuccessQuickReply(waNorm, confirmWithImageMsg(amount, desc, category));
            } else {
              const ns = getSession(phone);
              ns.state = 'AWAITING_RECEIPT_IMAGE';
              ns.receiptRowIndex = rowIdx;
              ns.ts = Date.now();
              await replyWhatsAppToUser(
                waNorm,
                `קלטתי 🙂 *${amount} ₪* על *${desc}*, תחת ${category}.\n\n${DRIVE_UPLOAD_FAIL_USER_MSG}\n\nהרישום בשיטס — שלח *תמונה שוב* או *כן* / *לא*. לביטול — *מחק*`
              );
            }
          } catch (se) {
            console.error('[sheets] append failed:', se.message);
            await replyWhatsAppToUser(waNorm, 'שגיאה בשמירה, נסה שוב');
          }
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
            'קלטתי את הקבלה! 📸\nעל איזה החזר מדובר וכמה זה? (למשל: *50 חניה*) 🍺'
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
      const txt = await buildMonthlySummary(waNorm);
      sendTwiML(res, txt || savvySummaryTotalLine(await sumAmountColumn(waNorm)));
    } catch (e) {
      console.error('[sheets] summary failed:', e.message);
      sendTwiML(res, 'אופס, לא הצלחתי למשוך את הסיכום. נסה שוב בעוד רגע?');
    }
    return;
  }

  // ─── Analytics-style report (מילות מפתח נפרדות מסיכום פיננסי) ───
  if (!hasMedia && /ניתוח|הכי\s+יקרה|\bstats\b|פירוט\s+לפי\s+קטגוריה/i.test(trimmed)) {
    try {
      sendTwiML(res, (await buildMonthlyStats(waNorm)) || 'עדיין דל — רשום עוד החזרים ונריץ ניתוח 🕵️‍♂️');
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
        sendTwiML(res, '✅ לחודש הזה אין החזרים שממתינים להגשה — הכול דחוס ויפה 💰');
      } else {
        const total = open.reduce((s, r) => s + r.amt, 0);
        const lines = [`📝 *${open.length} החזרים עדיין לא הוגשו (${total} ₪ שמחכים):*`, ''];
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
      const count = await markAllCurrentMonthSubmitted(waNorm);
      sendTwiML(res, count === 0
        ? '✅ הכול כבר מסומן כהוגש — לא מפספסים שקל 🍺'
        : `יש! *${count}* החזרים סומנו כהוגשו. עוד צעד לקראת הכסף בכיס 💰`);
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
    sendTwiML(res, 'בשמחה! רוצה *סיכום* או *תראה לי* — נראה כמה ש"ח מחכים להחזר? 💰');
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
      if (parsed.amount > HIGH_AMOUNT_THRESHOLD) {
        const ns = getSession(phone);
        ns.state = 'AWAITING_HIGH_CONFIRM';
        ns.pendingAmount = parsed.amount;
        ns.pendingDesc = parsed.description;
        ns.pendingCategory = category;
        ns.pendingDriveLink = '';
        ns.ts = Date.now();
        sendTwiML(res, `זה סכום גבוה מהרגיל (*${parsed.amount} ₪*), אתה בטוח שזה נכון? (כן / לא)`);
        return;
      }
      try {
        const rowIdx = await saveFullRow(phone, userSheetValue, parsed.amount, parsed.description, category, 'No', '');
        const ns = getSession(phone);
        ns.state = 'AWAITING_RECEIPT_IMAGE';
        ns.receiptRowIndex = rowIdx;
        ns.ts = Date.now();
        sendTwiML(res, confirmTextFirstMsg(parsed.amount, parsed.description, category));
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
        sendTwiML(res, 'שגיאה בשמירה, נסה שוב');
      }
      return;
    }

    const desc = sanitizeDescription(trimmed) || '(ללא תיאור)';
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
    try {
      const rowIdx = await saveFullRow(phone, userSheetValue, pendingAmount, desc, category, 'No', '');
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

  if (getSession(phone).state === 'AWAITING_AMOUNT') {
    const s = getSession(phone);
    const parsed = parseExpenseMessage(trimmed);
    if (parsed.amount) {
      const { pendingDesc, pendingCategory } = s;
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
      try {
        const rowIdx = await saveFullRow(phone, userSheetValue, parsed.amount, pendingDesc, resolved, 'No', '');
        const ns = getSession(phone);
        ns.state = 'AWAITING_RECEIPT_IMAGE';
        ns.receiptRowIndex = rowIdx;
        ns.ts = Date.now();
        sendTwiML(res, confirmTextFirstMsg(parsed.amount, pendingDesc, resolved));
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
    if (matchesAny(lower, INTENT_CONFIRM_YES)) {
      if (!pendingCategory) {
        resetSession(phone);
        sendTwiML(res, 'חסרה קטגוריה — שלח שוב *סכום + תיאור* (עם מילה מהרשימה) או ענה על השאלה על הקטגוריה.');
        return;
      }
      resetSession(phone);
      try {
        const hasImage = !!pendingDriveLink;
        const receipt = hasImage ? 'Yes' : 'No';
        const rowIdx = await saveFullRow(phone, userSheetValue, pendingAmount, pendingDesc, pendingCategory, receipt, pendingDriveLink || '');
        if (hasImage) {
          emptyTwiMLResponse(res);
          await sendReceiptSuccessQuickReply(phone, confirmWithImageMsg(pendingAmount, pendingDesc, pendingCategory));
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
    if (
      matchesAny(lower, INTENT_CONFIRM_NO) ||
      lower === 'ביטול' ||
      lower === 'בטל' ||
      lower === 'טעות'
    ) {
      resetSession(phone);
      sendTwiML(res, 'בסדר, ביטלתי — כלום לא נשמר. כשתהיה מוכן, נרשום מחדש בלי לאבד כסף 🍺');
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
    sendTwiML(res, '⚠️ רושמים החזרים ב-₪ בלבד.\nאם זה בש"ח — שלח בלי סימן מטבע זר, שלא יבלבל 🕵️‍♂️');
    return;
  }

  // ─── SCENARIO C: NORMAL TEXT EXPENSE ───
  const { amount, description } = parseExpenseMessage(trimmed);

  if (amount && description) {
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
      const rowIdx = await saveFullRow(phone, userSheetValue, amount, description, category, 'No', '');
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
    sendTwiML(res, `קיבלתי *${amount} ₪*. על איזה החזר? (למשל: חניה) 🍺`);
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

  sendTwiML(res, 'לא הבנתי 🤔\n*סכום + תיאור* (למשל: *150 דלק*) — או *תמונת קבלה* 📸\n*"שלום"* לעזרה. אל תהיה פראייר עם כסף על הרצפה 💰');
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
      sendTwiML(res, `קלטתי 🙂 *${amount} ₪* על *${desc}* — תחת ${category}. עוד כסף ברשימת המגיע לי 💰`);
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
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, 'היי! 👋 היו היום החזרים לרשום? אל תפספס — כן / לא 🍺');
  }, { timezone: CRON_TZ });

  cron.schedule('0 10 * * 0', async () => {
    try {
      const missing = await getMissingReceiptRows(cronOwnerWaNorm);
      if (missing.length === 0) return;
      const lines = [`היי, יש *${missing.length}* החזרים בלי אישור קבלה. הכל שמור אצלך? אל תפספס 📑`, ''];
      for (const r of missing.slice(0, 10)) lines.push(`• ${r.desc} — *${r.amt} ₪*`);
      if (missing.length > 10) lines.push(`...ועוד ${missing.length - 10}`);
      await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, lines.join('\n'));
    } catch (e) { console.error('[cron] Missing receipts failed:', e.message); }
  }, { timezone: CRON_TZ });

  cron.schedule('0 20 25 * *', async () => {
    try {
      const open = await getUnsubmittedRows(cronOwnerWaNorm);
      if (open.length === 0) return;
      const total = open.reduce((s, r) => s + r.amt, 0);
      await sendWhatsAppMessage(TO_WHATSAPP_NUMBER,
        `🚨 יום הגשת החזרים מתקרב!\nיש *${open.length}* רישומים פתוחים, *${total} ₪* שמחכים — לא נותנים לזה ללכת לאיבוד.\n\nשלח *"הגשתי"* לסמן הכל 💰`);
    } catch (e) { console.error('[cron] Deadline alert failed:', e.message); }
  }, { timezone: CRON_TZ });

  cron.schedule('0 20 29 * *', async () => {
    await sendWhatsAppMessage(TO_WHATSAPP_NUMBER, 'תזכורת חודשית 📋 זמן להגיש — שלח *"סיכום"* ונראה כמה ש"ח מחכים להחזר. כסף על הרצפה! 📈');
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
  const c = parseExpenseMessage('בסך 45 חניה');
  t('parse בסך + החניה', c.amount === 45 && (c.description.includes('חניה') || c.description === 'חניה'));
  t('category "בחנייה"', matchCategory('בחנייה') === 'חניה');
  t('category "למונית"', matchCategory('למונית') === 'נסיעות');
  t('category דלק', matchCategory('150 דלק') === 'נסיעות');
  t('resolve "פנגו"', resolveCategoryFromReply('פנגו') === 'חניה');
  t('resolve list id CAT_PARKING', resolveCategoryFromReply('CAT_PARKING') === 'חניה');
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
    { name: '80 סלולר → save', fields: { Body: '80 סלולר', From: F } },
    { name: 'לא → no receipt', fields: { Body: 'לא', From: F } },
    { name: 'מחק → delete flow', fields: { Body: 'מחק', From: F } },
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
