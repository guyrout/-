/**
 * Gemini — Google AI, REST v1. תשובה טקסטual בלבד (ללא responseMimeType / JSON schema).
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const kibbutzData = require('./kibbutzData');

const GEMINI_API_VERSION = 'v1';
const MODEL_NAME = 'gemini-1.5-flash';

function buildSystemInstruction() {
  const contextJson = JSON.stringify(kibbutzData, null, 2);
  return [
    'You are a professional Kibbutz Assistant for refund questions and expense help.',
    '',
    '=== REFUND RULES (CONTEXT) — use ONLY this data ===',
    contextJson,
    '',
    'Rules:',
    '- Answer from CONTEXT only: topic, keywords, limit, contact, answer.',
    '- For questions, use CONTEXT. If the topic is not there, say you do not have that information.',
    '',
    'Return your answer as a plain text string in Hebrew. If you detect an expense, include the amount and category clearly.',
  ].join('\n');
}

/**
 * @returns {{ reply: string, log_expense: false }} — טקסט בלבד; אין פענוח JSON מהמודל (שמירה לגיליון תתבסס על נתיבים אחרים או פענוח ידני בעתיד).
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
  const model = genAI.getGenerativeModel(
    {
      model: MODEL_NAME,
      systemInstruction: buildSystemInstruction(),
    },
    { apiVersion: GEMINI_API_VERSION }
  );

  let prompt = `USER_MESSAGE:\n${userMessage || '(ריק)'}`;
  if (hasMedia) {
    prompt += '\n\n(נשלחה גם מדיה — אין גישה לתוכן התמונה, רק הטקסט למעלה.)';
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

module.exports = {
  runGeminiKibbutzTurn,
  isGeminiApiKeyConfigured,
  MODEL_NAME,
  GEMINI_API_VERSION,
};
