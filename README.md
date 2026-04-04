# WhatsApp expense & receipt tracker (Twilio)

A Node.js service that receives WhatsApp messages through Twilio, parses expenses from text or receipt photos (OCR via [tesseract.js](https://github.com/naptha/tesseract.js)), and stores entries in `receipts.json`. Multiple users are supported: each person is identified by their WhatsApp number.

## Project layout

| File | Description |
|------|-------------|
| `index.js` | Express server, webhook, OCR, cron reminders |
| `package.json` | Dependencies and `npm start` |
| `receipts.json` | Receipt entries (starts as `[]`) |
| `reminder-state.json` | Per-user monthly reminder flags (created automatically) |
| `README.md` | This file |

## Features

- **Webhook**: `POST /whatsapp` for Twilio incoming messages
- **Text & images**: optional caption + OCR text from receipt photos
- **Amount parsing**: regex-based extraction from text/OCR (verify important totals manually)
- **Commands**: `summary`, `list`, `pending`, `submitted`, and `yes` (monthly reminder flow)
- **Reminders**: on the **28th at 10:00** (see `CRON_TZ`), asks whether receipts were submitted; if there is no `yes` reply, a follow-up is sent **every 24 hours** until they reply `yes` (checked hourly)
- **Health check**: `GET /health` for uptime monitors

## Data files

| File | Purpose |
|------|---------|
| `receipts.json` | Array of receipt objects |
| `reminder-state.json` | Per-user reminder flags (created/updated automatically) |

### Receipt object shape

```json
{
  "id": "rec_...",
  "userPhone": "whatsapp:+15551234567",
  "originalText": "Coffee $4.50",
  "amount": 4.5,
  "date": "2026-04-04T12:00:00.000Z",
  "status": "pending"
}
```

`status` is `pending` or `submitted`.

## Prerequisites

- Node.js **18+** (uses global `fetch`)
- A [Twilio](https://www.twilio.com/) account with WhatsApp enabled (Sandbox or approved sender)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token |
| `FROM_WHATSAPP_NUMBER` | Yes | Your Twilio WhatsApp sender, e.g. `whatsapp:+14155238886` |
| `PORT` | No | HTTP port (default `3000`; Render sets this automatically) |
| `CRON_TZ` | No | IANA timezone for cron schedules, e.g. `America/Los_Angeles`. If unset, the server default timezone applies (often UTC on cloud hosts). |

## Local setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   export TWILIO_ACCOUNT_SID="ACxxxxxxxx"
   export TWILIO_AUTH_TOKEN="your_auth_token"
   export FROM_WHATSAPP_NUMBER="whatsapp:+1xxxxxxxxxx"
   ```

3. **Run the server**

   ```bash
   npm start
   ```

4. **Expose HTTPS for Twilio** (e.g. [ngrok](https://ngrok.com/)) and set the Twilio **when a message comes in** webhook to `https://YOUR_PUBLIC_URL/whatsapp` (POST).

## Deploy on [Render](https://render.com/)

1. Create a **Web Service**, runtime **Node**, build `npm install`, start `npm start`.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `FROM_WHATSAPP_NUMBER`, and optionally `CRON_TZ`.
3. Set the Twilio webhook to `https://<your-service>.onrender.com/whatsapp`.

**Persistence:** Use a **persistent disk** or external storage if you need data to survive redeploys.

## Commands

| Message | Action |
|---------|--------|
| `summary` | Total for the current month + receipt count |
| `list` | Last 5 receipts for you |
| `pending` | Count of **pending** receipts this month |
| `submitted` | Mark **all** receipts this month as submitted |
| `yes` | During the monthly reminder flow: mark all this month’s receipts submitted and stop reminders |

## License

MIT
