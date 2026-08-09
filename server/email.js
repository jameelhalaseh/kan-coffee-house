// Server-side email via the EmailJS REST API (non-browser / strict mode).
// Used for the admin password-reset code so the secret is delivered out-of-band
// to the account's own inbox — never returned in an HTTP response (see auth.js).
//
// Required Heroku config vars (all four):
//   EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY
// The template must reference {{code}} (and may use {{to_email}}, {{username}}).
// In the EmailJS dashboard: Account → Security → enable "Allow EmailJS API for
// non-browser applications" so the private accessToken is accepted.

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

function emailjsConfig() {
  const service_id = process.env.EMAILJS_SERVICE_ID;
  const template_id = process.env.EMAILJS_TEMPLATE_ID;
  const user_id = process.env.EMAILJS_PUBLIC_KEY;
  const accessToken = process.env.EMAILJS_PRIVATE_KEY;
  if (!service_id || !template_id || !user_id || !accessToken) return null;
  return { service_id, template_id, user_id, accessToken };
}

// Returns true if email transport is configured (used to fail fast before minting a code).
function emailConfigured() {
  return emailjsConfig() !== null;
}

// Send the reset code to the admin's own email. Throws on misconfiguration or a non-2xx
// EmailJS response so the caller can surface a generic failure (never the code).
async function sendResetCode(toEmail, code, username) {
  const cfg = emailjsConfig();
  if (!cfg) throw new Error('email_not_configured');

  const payload = {
    ...cfg,
    template_params: {
      to_email: toEmail,
      email: toEmail,
      to_name: username,
      username,
      code,
      passcode: code,
    },
  };

  const resp = await fetch(EMAILJS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`emailjs_send_failed:${resp.status}:${detail.slice(0, 200)}`);
  }
  return true;
}

module.exports = { sendResetCode, emailConfigured };
