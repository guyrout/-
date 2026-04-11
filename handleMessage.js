/**
 * ליבת יציבות לטיפול בהודעות: Gemini (ללא systemInstruction / JSON schema),
 * ובדיקות סביבה לדרייב. המכונה המלאה (מצבים, גיליון, מדיה) נשארת ב-index.js
 * בפונקציה handleMessage — שם נשמרים כל תרחישי הרישום.
 */

'use strict';

const {
  runGeminiKibbutzTurn,
  isGeminiApiKeyConfigured,
} = require('./geminiKibbutzAssistant');

/** מקביל ל-USER_FACING_TECH_ERROR_HE ב-index (עדכן את שני המקומות יחד) */
const TECH_ERROR_HE =
  'משהו נתקע אצלי רגע 😔 נסה שוב בעוד רגע.\n\nאם זה חוזר — שלח *סכום + תיאור* (בלי שאלות לעוזר).';

/**
 * Gemini 1.5 Flash: כל חוקי הקיבוץ ב-user prompt בלבד (מוגדר ב-geminiKibbutzAssistant).
 * ללא systemInstruction וללא responseMimeType.
 *
 * @returns {{ ok: true, reply: string } | { ok: false, reason: string }}
 */
async function runGeminiWithKibbutzContext(userText, { hasMedia = false } = {}) {
  try {
    if (!isGeminiApiKeyConfigured()) {
      return { ok: false, reason: 'no_gemini_key' };
    }
    const out = await runGeminiKibbutzTurn(userText || '', { hasMedia });
    const reply = out && typeof out.reply === 'string' ? out.reply.trim() : '';
    if (!reply) {
      return { ok: false, reason: 'empty_reply' };
    }
    return { ok: true, reply };
  } catch (e) {
    console.error('[handleMessage] Gemini:', e && e.message ? e.message : e);
    return { ok: false, reason: 'gemini_error' };
  }
}

function isGeminiReady() {
  return isGeminiApiKeyConfigured();
}

/** תיקיית יעד לקבלות (חובה להעלאות מוצלחות) */
function isDriveFolderConfigured() {
  const id = process.env.GOOGLE_DRIVE_FOLDER_ID;
  return typeof id === 'string' && id.trim().length > 0;
}

/** בדיקה מהירה ללוג בעלייה: האם יש חשבון שירות (אחרי טעינה ב-index) */
function describeGoogleEnvHints() {
  return {
    driveFolderSet: isDriveFolderConfigured(),
    geminiKeySet: isGeminiReady(),
  };
}

module.exports = {
  TECH_ERROR_HE,
  runGeminiWithKibbutzContext,
  isGeminiReady,
  isDriveFolderConfigured,
  describeGoogleEnvHints,
};
