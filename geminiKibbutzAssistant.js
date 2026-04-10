/**
 * עוזר קיבוץ מבוסס Gemini — ידע מ־kibbutzData, פלט JSON מובנה.
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const kibbutzData = require('./kibbutzData');

const DEFAULT_MODEL = 'gemini-1.5-flash';

function buildSystemInstruction() {
  return [
    'You are a helpful Kibbutz Assistant. Use the provided context (KIBBUTZ_KNOWLEDGE_JSON) to identify user intent.',
    'If the user provides a number + item, it is an expense. Extract the amount (ILS), topic (match the closest row in the knowledge JSON), and calculate potential_refund as min(amount, limit) using that row\'s limit. Set submission_contact from the matched row\'s contact field.',
    'If the user asks a question, answer accurately based only on the knowledge data. If the intent is unclear, set log_expense to false and ask a short clarifying question in Hebrew in "reply".',
    'When log_expense is true, fill expense_description with a short Hebrew description suitable for a spreadsheet note.',
    'The "reply" field must always be natural, friendly Hebrew with appropriate emojis.',
    'Never invent policies or limits that are not in KIBBUTZ_KNOWLEDGE_JSON.',
    'If you do not understand the message, set log_expense to false and politely ask what they meant in Hebrew.',
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
        description: 'User-facing message in Hebrew with emojis',
      },
      log_expense: {
        type: SchemaType.BOOLEAN,
        description: 'True if user is reporting an expense to log',
      },
      amount: { type: SchemaType.NUMBER, nullable: true },
      topic: {
        type: SchemaType.STRING,
        nullable: true,
        description: 'Topic string matching a row in kibbutz knowledge when possible',
      },
      submission_contact: { type: SchemaType.STRING, nullable: true },
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
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: buildSystemInstruction(),
    generationConfig: {
      temperature: 0.35,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
    },
  });

  const knowledge = JSON.stringify(kibbutzData, null, 0);
  let prompt = `KIBBUTZ_KNOWLEDGE_JSON:\n${knowledge}\n\nUSER_MESSAGE:\n${userMessage || '(ריק)'}`;
  if (hasMedia) {
    prompt += '\n\n(המשתמש שלח גם קובץ מדיה/תמונה; אין לך גישה לתוכן התמונה — הסתמך רק על הטקסט למעלה.)';
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
  DEFAULT_MODEL,
};
