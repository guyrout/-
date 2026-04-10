/**
 * עוזר קיבוץ מבוסס Gemini — CONTEXT מ־kibbutzData בהוראות מערכת.
 * מפתח: תמיד מ־process.env.GEMINI_API_KEY (לא מועבר מחרוזת ריקה מבחוץ).
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const kibbutzData = require('./kibbutzData');

function buildSystemInstruction() {
  const contextLine = `CONTEXT: ${JSON.stringify(kibbutzData)}`;
  return [
    contextLine,
    '',
    'You are a professional Kibbutz Assistant. You MUST use the provided CONTEXT to answer users. If a user logs an expense (number + item), extract the amount and topic. If they ask a question, answer based ONLY on the context. If the topic is missing from context, say you don\'t know.',
    '',
    'Always put the user-visible text in the JSON field "reply" (Hebrew). For a logged expense set log_expense to true and fill structured fields from CONTEXT where possible.',
    'Output must be JSON only, matching the response schema.',
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

  // Key from env at request time (.trim() avoids newline from secret managers → 403 unregistered caller)
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: buildSystemInstruction(),
    generationConfig: {
      temperature: 0.35,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
    },
  });

  let prompt = `USER_MESSAGE:\n${userMessage || '(ריק)'}`;
  if (hasMedia) {
    prompt += '\n\n(נשלחה גם מדיה — אין גישה לתוכן התמונה, רק הטקסט למעלה.)';
  }

  const result = await model.generateContent(prompt);
  const raw = result.response.text();
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
};
