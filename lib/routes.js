const { Router } = require('express');
const { sendTwiML } = require('./twiml');

function runWithTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
    }),
  ]);
}

function createRoutes(config, sheets) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).type('text/plain; charset=utf-8').send('ok');
  });

  router.post('/whatsapp', async (req, res) => {
    const bodyRaw = req.body.Body ?? '';
    console.log('[whatsapp]', bodyRaw || '(no Body)');

    const trimmed = String(bodyRaw).trim();
    const amount = sheets.firstNumberInMessage(trimmed);
    const isSummary = trimmed.toLowerCase() === 'summary';

    if (isSummary) {
      try {
        await runWithTimeout(
          sheets.appendMessageRow(trimmed, amount),
          config.SUMMARY_TIMEOUT_MS,
          'append'
        );
      } catch (e) {
        console.error('[sheets] append failed:', e.message);
      }
      let responseText = config.REPLY;
      try {
        const total = await runWithTimeout(
          sheets.sumAmountColumn(),
          config.SUMMARY_TIMEOUT_MS,
          'summary'
        );
        responseText = `סה״כ: ${total}`;
      } catch (e) {
        console.error('[sheets] summary failed:', e.message);
      }
      sendTwiML(res, responseText);
      return;
    }

    sheets.appendMessageRow(trimmed, amount).catch((e) => {
      console.error('[sheets] append failed:', e.message);
    });
    sendTwiML(res, config.REPLY);
  });

  /**
   * Webhook חלופי — אם יש ספרות בהודעה → "שמרתי …₪" + שורה ב-Sheets;
   * אחרת → "קיבלתי ממך: …".
   */
  router.post('/webhook', async (req, res) => {
    try {
      const message = req.body.Body || '';
      console.log('[webhook]', message || '(no Body)');

      let reply = '';
      const match = message.match(/\d+/);

      if (match) {
        const amount = match[0];
        sheets.saveToSheet(message, amount).catch((e) => {
          console.error('[webhook] sheets:', e.message);
        });
        reply = `שמרתי ${amount}₪`;
      } else {
        reply = `קיבלתי ממך: ${message}`;
      }

      sendTwiML(res, reply);
    } catch (error) {
      console.error(error);
      sendTwiML(res, 'קרתה שגיאה, נסה שוב');
    }
  });

  return router;
}

module.exports = { createRoutes };
