/**
 * Gemini — ללא systemInstruction (תואם v1); כל ההקשר בפרומפט המשתמש.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const kibbutzData = require('./kibbutzData');

const MODEL_NAME = 'gemini-1.5-flash';

const GEMINI_API_VERSION = (process.env.GEMINI_API_VERSION || 'v1beta').trim() || 'v1beta';

/**
 * @returns {{ reply: string, log_expense: false }}
 */
async function runGeminiKibbutzTurn(userMessage, options = {}) {
  const { hasMedia = false } = options;
  if (
    process.env.GEMINI_API_KEY == null ||
    typeof process.env.GEMINI_API_KEY !== 'string' ||
    !process.env.GEMINI_API_KEY.trim()
  ) {
    throw new Error('gemini: GEMINI_API_KEY is missing or empty in process.env');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
  const model = genAI.getGenerativeModel({ model: MODEL_NAME }, { apiVersion: GEMINI_API_VERSION });

  const q = userMessage || '(ריק)';
  let prompt = `
Here are the Kibbutz rules: ${JSON.stringify(kibbutzData)}

User Question: ${q}

Answer in Hebrew based ONLY on the rules above.
`.trim();

  if (hasMedia) {
    prompt += '\n\n(Note: the user also sent media; you only have this text, not the image.)';
  }

  const result = await model.generateContent(prompt);
  let raw;
  try {
    raw = result.response.text();
  } catch (e) {
    const block = result.response?.promptFeedback?.blockReason;
    const msg = block ? `blocked (${block})` : e && e.message ? e.message : String(e);
    throw new Error(`gemini: no text in response — ${msg}`);
  }
  const reply = raw == null ? '' : String(raw).trim();
  if (!reply) {
    throw new Error('gemini: empty model output');
  }

  return {
    reply,
    log_expense: false,
  };
}

function isGeminiApiKeyConfigured() {
  const v = process.env.GEMINI_API_KEY;
  return typeof v === 'string' && v.trim().length > 0;
}

/** הודעת WhatsApp בעברית לפי שגיאת API */
function getGeminiUserFacingError(err) {
  const m = String(err && err.message != null ? err.message : err || '');
  if (/GEMINI_API_KEY|missing|empty in process\.env/i.test(m)) {
    return 'חסר מפתח API לעוזר (*GEMINI_API_KEY*). הגדר אותו במשתני הסביבה של השרת ופרוס מחדש.';
  }
  if (/404|not found|NotFound|is not found/i.test(m)) {
    return (
      '*Gemini — לא נמצא המודל (404).*\n\n' +
      'בדוק את *GEMINI_API_KEY*. אם השתמשת ב־*GEMINI_API_VERSION=v1*, נסה להסיר אותו (ברירת המחדל v1beta) או לעדכן מודל.'
    );
  }
  if (/403|PERMISSION|permission denied|unregistered caller/i.test(m)) {
    return '*Gemini — הגישה נדחתה (403).*\n\nבדוק שהמפתח תקף ב-Google AI Studio ושה-API מופעל לפרויקט.';
  }
  if (/429|rate|quota/i.test(m)) {
    return '*Gemini — יותר מדי בקשות (quota).* נסה שוב בעוד רגע.';
  }
  const short = m.replace(/\s+/g, ' ').trim().slice(0, 180);
  return `*שגיאה בחיבור לעוזר (Gemini)*\n\n${short || 'שגיאה לא ידועה'}\n\nנסה שוב או שלח *סכום + תיאור* בלי העוזר.`;
}

module.exports = {
  runGeminiKibbutzTurn,
  isGeminiApiKeyConfigured,
  getGeminiUserFacingError,
  MODEL_NAME,
  GEMINI_API_VERSION,
};
