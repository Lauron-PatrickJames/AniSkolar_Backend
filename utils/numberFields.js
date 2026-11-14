// Number-only fields in application forms (the standard, SFAG and grant
// forms): phone numbers hold digits (with the spaces, dashes, brackets and
// leading + people type), and amounts typed as text hold a number. The
// forms filter what can be typed (src/utils/numericInput.ts); this is the
// server's check. Number fields sent as numbers are checked by each form.

// Keys holding a phone number, at any depth.
const PHONE_KEY = /(^phone$|mobileNo$|landlineNo$|telNo$|contactNo$|companyTel$|telephone)/i;
// Keys holding an amount typed as text.
const AMOUNT_KEY = /^tuitionOrIncome$/;

// "N/A" is what the SFAG form fills in for a parent who isn't there.
const isPhone = v => /^n\/?a$/i.test(v) || /^\+?[\d\s()-]+$/.test(v) && (() => { const n = v.replace(/\D/g, '').length; return n >= 7 && n <= 15; })();
const isAmount = v => /^₱?\s*\d{1,3}(,?\d{3})*(\.\d{1,2})?$/.test(v) || /^\d+(\.\d{1,2})?$/.test(v);

// The first number-only field holding something else: its error message,
// or null. `sections` is the parsed form data.
function numberFieldError(sections) {
  let found = null;
  const walk = (value, key) => {
    if (found || value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach(v => walk(v, key)); return; }
    if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, k); return; }
    if (typeof value !== 'string' || !value.trim() || !key) return;
    const text = value.trim();
    if (PHONE_KEY.test(key) && !isPhone(text)) found = `“${text}” isn’t a phone number. Use digits only, e.g. 09171234567.`;
    else if (AMOUNT_KEY.test(key) && !isAmount(text)) found = `“${text}” isn’t an amount. Use numbers only, e.g. 5000.`;
  };
  walk(sections);
  return found;
}

// The JSON-encoded sections of a submission's body, parsed (bad JSON is
// left to the route's own checks).
function bodySections(body = {}) {
  const out = {};
  for (const k of ['personalInfo', 'contactSchool', 'parentsGuardian', 'siblings', 'assetsExpenses', 'standardInfo']) {
    if (typeof body[k] !== 'string') continue;
    try { out[k] = JSON.parse(body[k]); } catch { /* the route reports it */ }
  }
  return out;
}

module.exports = { numberFieldError, bodySections, isPhone };
