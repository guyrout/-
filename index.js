/**
 * WhatsApp expense & receipt tracker (Twilio + Express + Tesseract OCR).
 * Multi-user: each receipt is keyed by the sender's WhatsApp number.
 */

const express = require('express');
const cron = require('node-cron');
const twilio = require('twilio');
const Tesseract = require('tesseract.js');
const fs = require('fs').promises;
const path = require('path');

const RECEIPTS_PATH = path.join(__dirname, 'receipts.json');
const REMINDER_STATE_PATH = path.join(__dirname, 'reminder-state.json');

// Serialize writes to avoid corrupting JSON under concurrent webhook load.
let fileWriteChain = Promise.resolve();

// Twilio credentials — trim whitespace (common copy/paste issue on Render / .env).
// Sandbox: use the WhatsApp sandbox "From" number from the Twilio console (e.g. whatsapp:+14155238886).
const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const fromWhatsApp = normalizeWhatsAppAddress(
  (process.env.FROM_WHATSAPP_NUMBER || '').trim()
);

function logTwilioEnvStatus() {
  const sidOk = Boolean(accountSid);
  const tokenOk = Boolean(authToken);
  const fromOk = Boolean(fromWhatsApp);
  console.log(
    '[config] TWILIO_ACCOUNT_SID:',
    sidOk ? `${accountSid.slice(0, 6)}… (${accountSid.length} chars)` : '(missing or empty)'
  );
  console.log(
    '[config] TWILIO_AUTH_TOKEN:',
    tokenOk ? '(set)' : '(missing or empty)'
  );
  console.log(
    '[config] FROM_WHATSAPP_NUMBER:',
    fromOk ? fromWhatsApp : '(missing or empty)'
  );
  if (!sidOk || !tokenOk || !fromOk) {
    console.warn(
      '[config] Outbound WhatsApp (Sandbox or production) will fail until all three are set in the environment.'
    );
  }
}
logTwilioEnvStatus();

const twilioClient =
  accountSid && authToken ? twilio(accountSid, authToken) : null;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers: phone & WhatsApp formatting
// ---------------------------------------------------------------------------

function normalizeWhatsAppAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  const t = addr.trim();
  if (!t) return '';
  return t.toLowerCase().startsWith('whatsapp:') ? t : `whatsapp:${t}`;
}

/**
 * Download receipt image from Twilio MediaUrl (requires HTTP Basic auth).
 */
async function fetchMediaBuffer(mediaUrl) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

/**
 * Extract a plausible monetary amount from free text / OCR (bonus).
 * Prefers lines with TOTAL, Amount, Due, etc., then falls back to largest $-style number.
 */
function extractAmount(text) {
  if (!text || typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  const candidates = [];

  const labeled = [
    ...flat.matchAll(
      /(?:total|amount\s+due|balance\s+due|subtotal|grand\s*total|amount)\s*[:\s]*\$?\s*([\d,]+\.?\d{0,2})\b/gi
    ),
  ];
  for (const m of labeled) {
    const n = parseMoney(m[1]);
    if (n != null) candidates.push(n);
  }

  const dollarish = [...flat.matchAll(/\$\s*([\d,]+\.?\d{0,2})/g)];
  for (const m of dollarish) {
    const n = parseMoney(m[1]);
    if (n != null) candidates.push(n);
  }

  const decimals = [
    ...flat.matchAll(
      /\b([\d]{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})\b/g
    ),
  ];
  for (const m of decimals) {
    const n = parseMoney(m[1]);
    if (n != null && n > 0.01 && n < 1e8) candidates.push(n);
  }

  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function parseMoney(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Persistence: receipts (array) + reminder state
// ---------------------------------------------------------------------------

async function readReceipts() {
  try {
    const raw = await fs.readFile(RECEIPTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error('[storage] readReceipts:', e.message);
    return [];
  }
}

async function writeReceipts(receipts) {
  fileWriteChain = fileWriteChain.then(async () => {
    await fs.writeFile(RECEIPTS_PATH, JSON.stringify(receipts, null, 2), 'utf8');
  });
  return fileWriteChain;
}

async function readReminderState() {
  try {
    const raw = await fs.readFile(REMINDER_STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && data.users ? data : { users: {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { users: {} };
    console.error('[storage] readReminderState:', e.message);
    return { users: {} };
  }
}

async function writeReminderState(state) {
  fileWriteChain = fileWriteChain.then(async () => {
    await fs.writeFile(
      REMINDER_STATE_PATH,
      JSON.stringify(state, null, 2),
      'utf8'
    );
  });
  return fileWriteChain;
}

function newReceiptId() {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function isInCurrentMonth(iso) {
  const t = new Date(iso);
  const now = new Date();
  return (
    t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()
  );
}

function receiptsForUserMonth(receipts, userPhone) {
  return receipts.filter(
    (r) => r.userPhone === userPhone && isInCurrentMonth(r.date)
  );
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

async function addReceiptEntry({
  userPhone,
  originalText,
  amount,
  status = 'pending',
}) {
  const receipts = await readReceipts();
  const entry = {
    id: newReceiptId(),
    userPhone,
    originalText: originalText || '',
    amount: amount != null ? amount : null,
    date: new Date().toISOString(),
    status,
  };
  receipts.push(entry);
  await writeReceipts(receipts);
  return entry;
}

async function handleSummary(userPhone) {
  const receipts = await readReceipts();
  const month = receiptsForUserMonth(receipts, userPhone);
  const total = month.reduce(
    (s, r) => s + (typeof r.amount === 'number' ? r.amount : 0),
    0
  );
  const withAmount = month.filter((r) => typeof r.amount === 'number');
  const lines = [
    `Summary (${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })})`,
    `Receipts this month: ${month.length}`,
    `Total (known amounts): ${total.toFixed(2)}`,
  ];
  if (withAmount.length < month.length) {
    lines.push(
      `Note: ${month.length - withAmount.length} receipt(s) have no parsed amount.`
    );
  }
  return lines.join('\n');
}

async function handleList(userPhone) {
  const receipts = await readReceipts();
  const mine = receipts
    .filter((r) => r.userPhone === userPhone)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);
  if (!mine.length) {
    return 'No receipts yet. Send a message or photo of a receipt.';
  }
  return mine
    .map((r, i) => {
      const amt =
        typeof r.amount === 'number' ? `$${r.amount.toFixed(2)}` : 'amount ?';
      const preview = (r.originalText || '').slice(0, 80);
      return `${i + 1}. ${amt} | ${r.status} | ${new Date(r.date).toLocaleString()}\n   ${preview}`;
    })
    .join('\n\n');
}

async function markCurrentMonthSubmitted(userPhone) {
  const receipts = await readReceipts();
  let n = 0;
  for (const r of receipts) {
    if (r.userPhone === userPhone && isInCurrentMonth(r.date)) {
      r.status = 'submitted';
      n++;
    }
  }
  await writeReceipts(receipts);

  const state = await readReminderState();
  if (state.users[userPhone]) {
    state.users[userPhone].awaitingMonthlyConfirmation = false;
    state.users[userPhone].lastReminderSentAt = null;
    await writeReminderState(state);
  }
  return n;
}

async function handlePending(userPhone) {
  const receipts = await readReceipts();
  const pending = receiptsForUserMonth(receipts, userPhone).filter(
    (r) => r.status === 'pending'
  );
  return `Pending receipts (this month): ${pending.length}`;
}

async function uniqueUserPhonesFromReceipts() {
  const receipts = await readReceipts();
  return [...new Set(receipts.map((r) => r.userPhone).filter(Boolean))];
}

async function ensureReminderUser(userPhone) {
  const state = await readReminderState();
  if (!state.users[userPhone]) {
    state.users[userPhone] = {
      awaitingMonthlyConfirmation: false,
      lastReminderSentAt: null,
    };
    await writeReminderState(state);
  }
}

async function sendWhatsApp(to, body) {
  if (!twilioClient || !fromWhatsApp) {
    console.error('[twilio] Cannot send message: client or FROM not configured.');
    return false;
  }
  try {
    await twilioClient.messages.create({
      from: fromWhatsApp,
      to: normalizeWhatsAppAddress(to),
      body,
    });
    return true;
  } catch (e) {
    console.error('[twilio] sendWhatsApp:', e.message);
    return false;
  }
}

const MONTHLY_PROMPT =
  'Did you submit your receipts this month? Reply "yes" when you have.';

async function sendMonthlyRemindersToAllUsers() {
  const phones = await uniqueUserPhonesFromReceipts();
  const state = await readReminderState();
  const now = new Date().toISOString();
  for (const phone of phones) {
    if (!state.users[phone]) {
      state.users[phone] = {
        awaitingMonthlyConfirmation: false,
        lastReminderSentAt: null,
      };
    }
    state.users[phone].awaitingMonthlyConfirmation = true;
    state.users[phone].lastReminderSentAt = now;
    await sendWhatsApp(phone, MONTHLY_PROMPT);
  }
  await writeReminderState(state);
  console.log(
    `[cron] Monthly reminders sent to ${phones.length} user(s) on ${now}.`
  );
}

async function processFollowUpReminders() {
  const state = await readReminderState();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let updated = false;

  for (const [phone, u] of Object.entries(state.users)) {
    if (!u.awaitingMonthlyConfirmation || !u.lastReminderSentAt) continue;
    const last = new Date(u.lastReminderSentAt).getTime();
    if (now - last >= dayMs) {
      u.lastReminderSentAt = new Date().toISOString();
      updated = true;
      await sendWhatsApp(
        phone,
        'Reminder: Did you submit your receipts this month? Reply "yes" when done.'
      );
    }
  }
  if (updated) await writeReminderState(state);
}

function parseCommand(body) {
  if (!body || typeof body !== 'string') return null;
  const t = body.trim().toLowerCase();
  if (t === 'summary') return 'summary';
  if (t === 'list') return 'list';
  if (t === 'submitted') return 'submitted';
  if (t === 'pending') return 'pending';
  if (t === 'yes' || t === 'yes.') return 'yes';
  return null;
}

async function runOcrOnBuffer(buffer) {
  try {
    const {
      data: { text },
    } = await Tesseract.recognize(buffer, 'eng', {
      logger: () => {},
    });
    return (text || '').trim();
  } catch (e) {
    console.error('[ocr] Tesseract error:', e.message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// HTTP: Twilio webhook
// ---------------------------------------------------------------------------

/**
 * Twilio WhatsApp Sandbox / webhook: acknowledge via TwiML in the HTTP body.
 * Twilio sends this <Message> to the user; avoid duplicating the same text with messages.create().
 */
function respondWhatsAppAck(res) {
  res.set('Content-Type', 'text/xml');
  return res.send(
    `<Response>
  <Message>היי! הודעתך התקבלה ✅</Message>
</Response>`
  );
}

/**
 * OCR + DB + REST messages can take longer than Twilio’s webhook wait (~15s).
 * That logic runs here *after* respondWhatsAppAck so the user always gets the TwiML reply in time.
 */
async function processWhatsAppInboundLogic(req, userPhone) {
  let bodyText = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;
  const ocrChunks = [];

  if (numMedia > 0 && accountSid && authToken) {
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      if (!url) continue;
      try {
        const buf = await fetchMediaBuffer(url);
        const ocr = await runOcrOnBuffer(buf);
        if (ocr) ocrChunks.push(ocr);
      } catch (e) {
        console.error('[webhook] media:', e.message);
        ocrChunks.push(`[Image ${i + 1}: could not read — ${e.message}]`);
      }
    }
  } else if (numMedia > 0) {
    ocrChunks.push('[Images skipped: Twilio credentials not set]');
  }

  const ocrCombined = ocrChunks.join('\n\n');
  if (ocrCombined && bodyText) {
    bodyText = `${bodyText}\n\n--- OCR ---\n${ocrCombined}`;
  } else if (ocrCombined && !bodyText) {
    bodyText = ocrCombined;
  }

  console.log(`Received message: ${bodyText || '(empty)'}`);

  const cmd = parseCommand(req.body.Body || '');
  const state = await readReminderState();
  const awaiting =
    state.users[userPhone] && state.users[userPhone].awaitingMonthlyConfirmation;

  if (cmd === 'yes') {
    if (awaiting) {
      const n = await markCurrentMonthSubmitted(userPhone);
      const msg =
        n > 0
          ? `Marked ${n} receipt(s) for this month as submitted. Thank you!`
          : 'No receipts to mark for this month. Confirmation recorded.';
      await sendWhatsApp(userPhone, msg);
    } else {
      await sendWhatsApp(
        userPhone,
        'There is no active monthly reminder to confirm. Your receipts are unchanged.'
      );
    }
    return;
  }

  if (cmd === 'summary') {
    const msg = await handleSummary(userPhone);
    await sendWhatsApp(userPhone, msg);
    return;
  }
  if (cmd === 'list') {
    const msg = await handleList(userPhone);
    await sendWhatsApp(userPhone, msg);
    return;
  }
  if (cmd === 'submitted') {
    const n = await markCurrentMonthSubmitted(userPhone);
    await sendWhatsApp(
      userPhone,
      `Marked ${n} receipt(s) for this month as submitted.`
    );
    return;
  }
  if (cmd === 'pending') {
    const msg = await handlePending(userPhone);
    await sendWhatsApp(userPhone, msg);
    return;
  }

  if (bodyText.length > 0) {
    const amount = extractAmount(bodyText);
    await addReceiptEntry({
      userPhone,
      originalText: bodyText,
      amount,
      status: 'pending',
    });
    const amtLine =
      amount != null
        ? `Parsed amount: ${amount.toFixed(2)} (verify if needed).`
        : 'Could not parse an amount automatically; you can still use "summary".';
    await sendWhatsApp(
      userPhone,
      `Saved receipt entry.\n${amtLine}\nCommands: summary, list, pending, submitted`
    );
  } else {
    await sendWhatsApp(
      userPhone,
      'Send text describing a purchase or a receipt photo. Commands: summary, list, pending, submitted'
    );
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/whatsapp', async (req, res) => {
  try {
    const fromRaw = req.body.From || '';
    const userPhone = normalizeWhatsAppAddress(fromRaw);
    if (!userPhone) {
      return res.status(400).send('Missing From');
    }

    await ensureReminderUser(userPhone);

    // Must respond before OCR / slow work — Twilio times out ~15s waiting for this HTTP response.
    respondWhatsAppAck(res);

    void processWhatsAppInboundLogic(req, userPhone).catch((err) =>
      console.error('[webhook] async logic:', err)
    );
  } catch (e) {
    console.error('[webhook] unhandled:', e);
    if (!res.headersSent) {
      return res.status(500).send('Server error');
    }
  }
});

// ---------------------------------------------------------------------------
// Cron: 28th 10:00, and hourly follow-ups for 24h reminders
// ---------------------------------------------------------------------------

const cronOpts = {};
if (process.env.CRON_TZ) cronOpts.timezone = process.env.CRON_TZ;

cron.schedule(
  '0 10 28 * *',
  () => {
    sendMonthlyRemindersToAllUsers().catch((e) =>
      console.error('[cron] monthly:', e)
    );
  },
  cronOpts
);

cron.schedule(
  '0 * * * *',
  () => {
    processFollowUpReminders().catch((e) =>
      console.error('[cron] follow-up:', e)
    );
  },
  cronOpts
);

// Render (and other hosts) set PORT; default 3000 for local dev.
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Expense tracker listening on port ${PORT}`);
  console.log(`Webhook URL path: POST /whatsapp`);
});
