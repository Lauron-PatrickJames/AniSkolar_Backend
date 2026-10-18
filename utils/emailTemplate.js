// The look of AniSkolar emails, modelled on the scholarship office's own
// Outlook announcements: optional images on top (shown inline, like their
// posters), a bold heading, the body with bullets and clickable links, a
// "View on AniSkolar" button, an optional signature and the office footer.
// Email HTML uses tables and inline styles because Outlook ignores most CSS.
//
//   EMAIL_SIGNATURE  (optional) signature lines separated by "|", e.g.
//                    "Juan Dela Cruz, MS|Scholarship Associate"

const OFFICE = {
  name: 'Admissions and Scholarship Office',
  school: 'De La Salle University-Dasmariñas',
  address: 'Ayuntamiento de Gonzalez Bldg., Brgy. Fatima 1, Dasmariñas City, Cavite 4115',
  contact: 'scholarship@dlsud.edu.ph · +63 (46) 481-1900 local 3029',
};
const GREEN = '#00703c';

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Escapes a line, then makes http(s) links clickable.
function inline(line) {
  return escapeHtml(line).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, url => `<a href="${url}" style="color:${GREEN}">${url}</a>`);
}

// Plain text → HTML: blank lines split paragraphs; lines starting with
// "-", "•" or "*" become a bulleted list; other line breaks stay.
function bodyHtml(text) {
  const blocks = [];
  let para = [];
  let list = [];
  const flushPara = () => { if (para.length) blocks.push(`<p style="margin:0 0 12px">${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list.length) blocks.push(`<ul style="margin:0 0 12px;padding-left:22px">${list.map(l => `<li style="margin:0 0 4px">${inline(l)}</li>`).join('')}</ul>`); list = []; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    if (bullet) { flushPara(); list.push(bullet[1]); continue; }
    flushList();
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks.join('');
}

function signatureLines() {
  return (process.env.EMAIL_SIGNATURE || '').split('|').map(s => s.trim()).filter(Boolean);
}

// Inline images (contentIds): the first large, the next ones as a 2-column
// grid of thumbnails, then "+N more photos" linking to AniSkolar.
function galleryHtml({ hero, thumbs = [], more = 0 }, url) {
  if (!hero) return '';
  let html = `<img src="cid:${hero}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;margin:0 0 4px;border:0">`;
  if (thumbs.length) {
    const rows = [];
    for (let i = 0; i < thumbs.length; i += 2) rows.push(thumbs.slice(i, i + 2));
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px">${rows.map(row => `<tr>${row.map(id => `<td width="50%" style="padding:2px"><img src="cid:${id}" alt="" width="276" style="display:block;width:100%;max-width:276px;height:auto;border:0"></td>`).join('')}${row.length === 1 ? '<td width="50%"></td>' : ''}</tr>`).join('')}</table>`;
  }
  if (more > 0) html += `<p style="margin:4px 0 0;font-size:13px;color:#5b6660">+${more} more photo${more === 1 ? '' : 's'} — <a href="${escapeHtml(url)}" style="color:${GREEN}">view them on AniSkolar</a></p>`;
  return `<div style="margin:0 0 14px">${html}</div>`;
}

// { heading?, intro?, body, gallery?: { hero, thumbs, more },
//   button?: { url, label } } → { html, text }
function renderEmail({ heading, intro, body, gallery, button }) {
  const sig = signatureLines();
  const images = gallery ? galleryHtml(gallery, button?.url || '') : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f4"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e2e5e2">
<tr><td style="background:${GREEN};padding:12px 20px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff">AniSkolar · ${escapeHtml(OFFICE.name)}</td></tr>
<tr><td style="padding:20px;font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2a24">
${images}
${heading ? `<h1 style="margin:0 0 10px;font-size:18px;line-height:1.3;color:#14211a">${escapeHtml(heading)}</h1>` : ''}
${intro ? `<p style="margin:0 0 12px;font-weight:bold">${inline(intro)}</p>` : ''}
${bodyHtml(body)}
${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px"><tr><td style="background:${GREEN};border-radius:4px"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:10px 18px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">${escapeHtml(button.label)}</a></td></tr></table>` : ''}
${sig.length ? `<p style="margin:16px 0 0">Thank you.</p><p style="margin:8px 0 0;font-style:italic">${sig.map((l, i) => (i === 0 ? `<b>${escapeHtml(l)}</b>` : escapeHtml(l))).join('<br>')}</p>` : ''}
</td></tr>
<tr><td style="padding:14px 20px;border-top:1px solid #e2e5e2;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#5b6660">
<b style="color:${GREEN}">${escapeHtml(OFFICE.name.toUpperCase())}</b><br>${escapeHtml(OFFICE.school)}<br>${escapeHtml(OFFICE.address)}<br>${escapeHtml(OFFICE.contact)}<br>
<span style="color:#8a948e">Sent by AniSkolar. Replies may not be read; use AniSkolar → Messages to reach the office.</span>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    heading, intro, body,
    button ? `${button.label}: ${button.url}` : '',
    sig.length ? `Thank you.\n${sig.join('\n')}` : '',
    `— ${OFFICE.name}, ${OFFICE.school}\n${OFFICE.address}\n${OFFICE.contact}`,
  ].filter(Boolean).join('\n\n');
  return { html, text };
}

module.exports = { renderEmail, bodyHtml };
