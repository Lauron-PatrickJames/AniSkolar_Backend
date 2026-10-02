// Application reference numbers: <CODE>-<YEAR>-<SEQ>, e.g. ENT-2026-0001.
//
//   CODE  the scholarship's short code from data/scholarships.js
//         (referenceCode: 'ENT', 'SFA', 'PSEF', 'DAA', 'EBPSP')
//   YEAR  the academic year the application belongs to, by its start year
//         (AY 2026–2027 → 2026; see utils/academicYear.js)
//   SEQ   a counter per code and year, zero-padded to 4 digits (it simply
//         grows past 9999)
//
// This is the only place references are generated. Older applications keep
// their original references ("DLSU-D-ENTRANCE-735161", "DLSUD-AA-427193",
// "POLCA-PSEF-633089"); they're never rewritten.
const Counter = require('../models/Counter');
const { academicYearStart } = require('./academicYear');

const FALLBACK_CODE = 'APP';

function formatReference(code, year, seq) {
  return `${code}-${year}-${String(seq).padStart(4, '0')}`;
}

async function nextReferenceCode(scholarship, date = new Date()) {
  const code = (scholarship && scholarship.referenceCode) || FALLBACK_CODE;
  const year = academicYearStart(date);
  const counter = await Counter.findOneAndUpdate(
    { _id: `ref:${code}:${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return formatReference(code, year, counter.seq);
}

module.exports = { nextReferenceCode, formatReference };
