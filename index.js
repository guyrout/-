const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: false }));

const REPLY = 'היי! הבוט עובד 🎉';

app.post('/whatsapp', (req, res) => {
  console.log(req.body.Body ?? '(no Body)');
  res.set('Content-Type', 'text/xml');
  res.send(
    `<Response><Message>${REPLY}</Message></Response>`
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
