/**
 * Gemini דרך Google AI — קריאות ל־**v1** (לא v1beta) דרך RequestOptions.apiVersion.
 * מפתח: process.env.GEMINI_API_KEY
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const kibbutzData = require('./kibbutzData');

/** API REST יציב; ברירת המחדל של הספרייה היא v1beta */
const GEMINI_API_VERSION = 'v1';

const MODEL_NAME = 'gemini-1.5-flash';

/**
 * הוראות מערכת: כללי החזרים מ־kibbutzData (topic, keywords, limit, contact, answer).
 */
function buildSystemInstruction() {
  const contextJson = JSON.stringify(kibbutzData, null, 2);
  return [
    'You are a professional Kibbutz Assistant for refund logging and questions.',
    '',
    '=== REFUND RULES (CONTEXT) — use ONLY this data for amounts, limits, contacts, and policy text ===',
    contextJson,
    '',
    'Rules:',
    '- You MUST use the CONTEXT JSON above for refund rules. Each row has: topic, keywords, limit (ILS cap), contact (submission person), answer (policy summary).',
    '- If the user logs an expense (number + what they bought), extract amount and match the best topic from CONTEXT using keywords and intent.',
    '- If they ask a question, answer ONLY from CONTEXT. If the topic is not in CONTEXT, say you do not have that information.',
    '- Put the user-visible message in Hebrew in the JSON field "reply". For expenses set log_expense true and fill structured fields from CONTEXT when applicable.',
    '- Output must be JSON only matching the response schema.',
  ].join('\n');
}

function parseJsonFromModelText(raw) {
  const s = String(raw || '').trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        /* fall through */
      }
    }
  }
  throw new Error('gemini: could not parse JSON response');
}

function responseSchema() {
  return {
    type: SchemaType.OBJECT,
    properties: {
      reply: {
        type: SchemaType.STRING,
        description: 'Final Hebrew message to the user',
      },
      log_expense: {
        type: SchemaType.BOOLEAN,
        description: 'True if user is reporting an expense to log',
      },
      amount: { type: SchemaType.NUMBER, nullable: true },
      topic: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'Topic from CONTEXT when matched',
      },
      submission_contact: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'Contact from CONTEXT when matched',
      },
      expense_description: { type: SchemaType.STRING, nullable: true },
      potential_refund: { type: SchemaType.NUMBER, nullable: true },
    },
    required: ['reply', 'log_expense'],
  };
}

/**
 * @param {string} userMessage
 * @param {{ hasMedia?: boolean }} [options]
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
      generationConfig: {
        temperature: 0.35,
        responseMimeType: 'application/json',
        responseSchema: responseSchema(),
      },
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
  if (raw == null || !String(raw).trim()) {
    throw new Error('gemini: empty model output');
  }
  const parsed = parseJsonFromModelText(raw);
  if (typeof parsed.reply !== 'string') parsed.reply = 'היי! 😊 לא הבנתי בדיוק — תוכל לפרט?';
  if (typeof parsed.log_expense !== 'boolean') parsed.log_expense = false;
  return parsed;
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
