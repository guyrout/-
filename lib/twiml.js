function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** תשובת Twilio ב-TwiML — Content-Type text/xml; charset=utf-8 */
function sendTwiML(res, messageText) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
      messageText
    )}</Message></Response>`
  );
}

module.exports = { escapeXml, sendTwiML };
