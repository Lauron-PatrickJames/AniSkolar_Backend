// Number-only fields in application forms (the standard, SFAG and grant
// forms): phone numbers hold digits (with the spaces, dashes, brackets and
// leading + people type), and amounts typed as text hold a number. The
// forms filter what can be typed (src/utils/numericInput.ts); this is the
// server's check. Number fields sent as numbers are checked by each form.

// Keys holding a phone number, at any depth. Not the SFAG's bill brackets
// (telephoneBill, mobilePhoneBill: "₱0 – ₱5,321.66").
const PHONE_KEY = /(^phone$|mobileNo$|landlineNo$|telNo$|contactNo$|companyTel$|^telephone(Number|No)?$)/i;
// Keys holding an amount typed as text.
const AMOUNT_KEY = /^tuitionOrIncome$/;

// "N/A" is what the SFAG form fills in for a parent who isn't there.
const isPhone = v => /^n\/?a$/i.test(v) || /^\+?[\d\s()-]+$/.test(v) && (() => { const n = v.replace(/\D/g, '').length; return n >= 7 && n <= 15; })();
const isAmount = v => /^₱?\s*\d{1,3}(,?\d{3})*(\.\d{1,2})?$/.test(v) || /^\d+(\.\d{1,2})?$/.test(v);

// Where a field is, in the words of the form's section list, e.g.
// "Parents & Guardian, Father’s company tel. no.".
const SECTION_LABELS = {
  personalInfo: 'Personal Info', contactSchool: 'Contact & School', parentsGuardian: 'Parents & Guardian',
  siblings: 'Siblings', assetsExpenses: 'Assets & Expenses', standardInfo: 'Application form', grant: 'Application form',
};
const PERSON_LABELS = { father: 'Father', mother: 'Mother', guardian: 'Guardian', spouse: 'Spouse' };
const FIELD_LABELS = {
  phone: 'phone no.', mobileNo: 'mobile no.', landlineNo: 'landline no.', telNo: 'tel. no.', contactNo: 'contact no.',
  companyTel: 'company tel. no.', telephone: 'telephone no.', telephoneNumber: 'telephone no.', telephoneNo: 'telephone no.',
  tuitionOrIncome: 'tuition or income',
};
function where(path) {
  const [section, ...rest] = path;
  const field = rest[rest.length - 1];
  let whose = '';
  for (const p of rest.slice(0, -1)) {
    if (PERSON_LABELS[p]) whose = PERSON_LABELS[p];
    else if (typeof p === 'number' && section === 'siblings') whose = `Sibling ${p + 1}`;
  }
  const label = FIELD_LABELS[field] ?? field;
  const what = whose ? `${whose}’s ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
  return [SECTION_LABELS[section], what].filter(Boolean).join(', ');
}

// The first number-only field holding something else: { message, section }
// (section: the top-level key, e.g. 'contactSchool'), or null. `sections`
// is the parsed form data.
function numberFieldProblem(sections) {
  let found = null;
  const walk = (value, path) => {
    if (found || value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, [...path, i])); return; }
    if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, [...path, k]); return; }
    const key = [...path].reverse().find(p => typeof p === 'string');
    if (typeof value !== 'string' || !value.trim() || !key || path.length < 2) return;
    const text = value.trim();
    const problem = PHONE_KEY.test(key) && !isPhone(text) ? `“${text}” isn’t a phone number. Use digits only, e.g. 09171234567.`
      : AMOUNT_KEY.test(key) && !isAmount(text) ? `“${text}” isn’t an amount. Use numbers only, e.g. 5000.`
        : null;
    if (problem) found = { message: `${where(path)}: ${problem}`, section: path[0] };
  };
  for (const [k, v] of Object.entries(sections || {})) walk(v, [k]);
  return found;
}

// Just the message (or null).
const numberFieldError = sections => numberFieldProblem(sections)?.message ?? null;

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

module.exports = { numberFieldError, numberFieldProblem, bodySections, isPhone };
