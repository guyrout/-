const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

/** חילוץ המספר הראשון בהודעה לעמודת Amount (אם אין מספר → 0) — לוגיקה זהה לקודם */
function firstNumberInMessage(text) {
  if (!text || typeof text !== 'string') return 0;
  const m = text.match(/\d+(?:[.,]\d+)?/);
  if (!m) return 0;
  return parseFloat(m[0].replace(',', '.')) || 0;
}

/** @param {object} config */
function createSheets(config) {
  let sheetsClientPromise = null;

  function getSpreadsheetDoc() {
    if (!config.GOOGLE_SHEET_ID || !config.serviceAccountCreds) {
      return null;
    }
    if (!sheetsClientPromise) {
      sheetsClientPromise = (async () => {
        const serviceAccountAuth = new JWT({
          email: config.serviceAccountCreds.client_email,
          key: config.serviceAccountCreds.private_key,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(
          config.GOOGLE_SHEET_ID,
          serviceAccountAuth
        );
        await doc.loadInfo();
        return doc;
      })();
    }
    return sheetsClientPromise;
  }

  /**
   * שמירת שורה בגיליון הראשון: עמודות Date, Message, Amount.
   * אם הגיליון ריק — נוצרת שורת כותרות מתאימה.
   */
  async function appendMessageRow(messageBody, amount) {
    const doc = await getSpreadsheetDoc();
    if (!doc) return;
    const sheet = doc.sheetsByIndex[0];
    await sheet.loadHeaderRow(1);
    const headers = sheet.headerValues || [];
    const hasHeaders =
      headers.length >= 3 &&
      headers[0] === 'Date' &&
      headers[1] === 'Message' &&
      headers[2] === 'Amount';
    if (!hasHeaders && headers.filter(Boolean).length === 0) {
      await sheet.setHeaderRow(['Date', 'Message', 'Amount']);
    }
    await sheet.addRow({
      Date: new Date().toISOString(),
      Message: messageBody,
      Amount: amount,
    });
  }

  /** שמירה ל-Google Sheets (ל-/webhook) — עוטף את appendMessageRow */
  async function saveToSheet(message, amount) {
    await appendMessageRow(message, parseFloat(amount) || 0);
  }

  /** סכום כל הערכים בעמודת Amount (לפקודת summary) */
  async function sumAmountColumn() {
    const doc = await getSpreadsheetDoc();
    if (!doc) return 0;
    const sheet = doc.sheetsByIndex[0];
    await sheet.loadHeaderRow(1);
    const rows = await sheet.getRows();
    let total = 0;
    for (const row of rows) {
      const raw =
        typeof row.get === 'function' ? row.get('Amount') : row.Amount;
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) total += n;
    }
    return total;
  }

  return {
    appendMessageRow,
    saveToSheet,
    sumAmountColumn,
    firstNumberInMessage,
  };
}

module.exports = { createSheets, firstNumberInMessage };
