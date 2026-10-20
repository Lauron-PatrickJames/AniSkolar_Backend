// Email alerts (e.g. "you have a new message"), sent with Azure
// Communication Services Email so they land in the recipients' Outlook
// (@dlsud.edu.ph) inboxes. Off until the backend .env has:
//   ACS_EMAIL_CONNECTION_STRING  from the Communication Services resource (Keys)
//   ACS_EMAIL_SENDER             a verified sender, e.g. DoNotReply@<id>.azurecomm.net
//   EMAIL_REPLY_TO               (optional) where replies go, e.g. the AdSO's
//                                mailbox; empty = replies go to the sender
// Without them sendMail() only logs, so the app works the same minus emails.
// Sending never throws: a failed email mustn't fail the request that sent it.
let client = null;

function mailEnabled() {
  return Boolean(process.env.ACS_EMAIL_CONNECTION_STRING && process.env.ACS_EMAIL_SENDER);
}

function getClient() {
  if (!client) {
    const { EmailClient } = require('@azure/communication-email');
    client = new EmailClient(process.env.ACS_EMAIL_CONNECTION_STRING);
  }
  return client;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Outlook drops CSS line breaks, so each line break becomes <br>.
const toHtml = text => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
// Addresses under the reserved .invalid domain (sample or test records)
// can't receive mail, so they're skipped.
const deliverable = address => typeof address === 'string' && !/\.invalid$/i.test(address.trim());

// { to, bcc?, subject, text, wait? } — text is plain; an HTML copy is made
// from it unless `html` is given (utils/emailTemplate.js). bcc: up to 50
// addresses. inlineImages: [{ contentId, name, contentType, buffer }],
// shown in the HTML as <img src="cid:…">. wait: resolve only once the
// service has accepted or refused it (for bulk sends that track progress).
async function sendMail({ to, bcc = [], subject, text, html, inlineImages = [], wait = false }) {
  bcc = bcc.filter(deliverable);
  if (!to || !deliverable(to)) return false;
  if (!mailEnabled()) {
    console.log(`[mail off] would email ${to}${bcc.length ? ` (+${bcc.length} bcc)` : ''}: ${subject}`);
    return false;
  }
  try {
    const poller = await getClient().beginSend({
      senderAddress: process.env.ACS_EMAIL_SENDER,
      recipients: { to: [{ address: to }], ...(bcc.length ? { bcc: bcc.map(address => ({ address })) } : {}) },
      ...(process.env.EMAIL_REPLY_TO ? { replyTo: [{ address: process.env.EMAIL_REPLY_TO.trim() }] } : {}),
      content: {
        subject,
        plainText: text,
        html: html || toHtml(text),
      },
      ...(inlineImages.length ? {
        attachments: inlineImages.map(img => ({ name: img.name, contentType: img.contentType, contentInBase64: img.buffer.toString('base64'), contentId: img.contentId })),
      } : {}),
    });
    if (wait) {
      const result = await poller.pollUntilDone();
      if (result?.status && result.status !== 'Succeeded') throw new Error(result.error?.message || `Email ${result.status}`);
    }
    return true;
  } catch (err) {
    console.error('Email send failed:', err.message);
    return false;
  }
}

module.exports = { sendMail, mailEnabled };
