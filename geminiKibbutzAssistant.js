/**
 * עוזר קיבוץ מבוסס Gemini — ידע מ־kibbutzData בלבד, בתוך system prompt כ־CONTEXT.
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const kibbutzData = require('./kibbutzData');

const DEFAULT_MODEL = 'gemini-1.5-flash';

/** תוכן מלא של kibbutzData.js כמחרוזת JSON (מעוצב לקריאה במודל) */
function stringifyKibbutzContext() {
  return JSON.stringify(kibbutzData, null, 2);
}

/**
 * System prompt: הוראות + CONTEXT (כל ה־JSON מ־kibbutzData).
 */
function buildSystemInstruction(contextJson) {
  const ctx = String(contextJson || '').trim();
  return [
    'You are a professional Kibbutz Secretary. You have access to a specific list of refund rules (the CONTEXT provided below).',
    '',
    'CONTEXT',
    ctx,
    '',
    'CRITICAL: Never use your general knowledge about kibbutzim. ONLY use the specific amounts, limits, topics, keywords, contacts, and answer texts from the CONTEXT JSON above.',
    '',
    'If the user asks about something NOT in the CONTEXT list (no reasonable match to any topic or keywords), set log_expense to false and set "reply" to exactly this Hebrew sentence:',
    'לא מצאתי מידע על הנושא הזה בתקנון, כדאי לבדוק מול המזכירות.',
    '',
    'When a user logs an expense (typically a number plus what they spent on), find the most relevant topic in the CONTEXT by matching intent. Use the "topic" and "keywords" fields—even if the user\'s wording is not identical (e.g. "נעליים" may match orthotics / "מדרסים" if that is the closest relevant row in CONTEXT).',
    'Always take limit and contact from the matched CONTEXT row. Set potential_refund = min(amount, that row\'s limit). Set submission_contact to that row\'s "contact". Set topic to that row\'s exact "topic" string.',
    'Always include in "reply" the correct limit (תקרה) and contact person from the matched CONTEXT row when you discuss that topic or confirm an expense.',
    '',
    'Response format (Hebrew only in "reply"):',
    '- Always respond in Hebrew in the "reply" field.',
    '- If log_expense is true, summarize clearly: [Amount] נרשם עבור [Topic], החזר משוער: [refund vs limit—show your calculation], איש קשר: [Contact]. Use a friendly tone and emojis where appropriate.',
    '- For informational questions, answer only from CONTEXT.',
    '- If you do not understand, set log_expense false and ask a short clarifying question in Hebrew.',
    '',
    'Output must be JSON only, matching the response schema. When log_expense is true, fill expense_description with a short Hebrew description suitable for a spreadsheet note.',
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
        description:
          'Hebrew only. For expenses: amount registered for topic, estimated refund, contact. Friendly tone with emojis.',
      },
      log_expense: {
        type: SchemaType.BOOLEAN,
        description: 'True if user is reporting an expense to log',
      },
      amount: { type: SchemaType.NUMBER, nullable: true },
      topic: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'Exact "topic" string from the matched CONTEXT row',
      },
      submission_contact: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'Exact "contact" from the matched CONTEXT row',
      },
      expense_description: { type: SchemaType.STRING, nullable: true },
      potential_refund: { type: SchemaType.NUMBER, nullable: true },
    },
    required: ['reply', 'log_expense'],
  };
}

/**
 * @param {string} apiKey
 * @param {string} userMessage
 * @param {{ hasMedia?: boolean }} [options]
 * @returns {Promise<{
 *   reply: string,
 *   log_expense: boolean,
 *   amount?: number|null,
 *   topic?: string|null,
 *   submission_contact?: string|null,
 *   expense_description?: string|null,
 *   potential_refund?: number|null
 * }>}
 */
async function runGeminiKibbutzTurn(apiKey, userMessage, options = {}) {
  const { hasMedia = false } = options;
  const modelName = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const contextJson = stringifyKibbutzContext();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: buildSystemInstruction(contextJson),
    generationConfig: {
      temperature: 0.35,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
    },
  });

  let prompt = `USER_MESSAGE:\n${userMessage || '(ריק)'}`;
  if (hasMedia) {
    prompt +=
      '\n\n(המשתמש שלח גם קובץ מדיה/תמונה; אין לך גישה לתוכן התמונה — הסתמך רק על הטקסט למעלה וב־CONTEXT שבהוראות המערכת.)';
  }

  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  const parsed = parseJsonFromModelText(raw);
  if (typeof parsed.reply !== 'string') parsed.reply = 'היי! 😊 לא הבנתי בדיוק — תוכל לפרט?';
  if (typeof parsed.log_expense !== 'boolean') parsed.log_expense = false;
  return parsed;
}

module.exports = {
  runGeminiKibbutzTurn,
  stringifyKibbutzContext,
  DEFAULT_MODEL,
};
