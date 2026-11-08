// Keys of the shared eligibility rules and documents scholarships pick
// from. Mirrors the frontend's src/data/requirementCatalog.ts (which also
// holds the wording) — keep the keys in sync.

const { findProgram } = require('./programs');

const APPLICANT_TYPES = ['incoming', 'continuing', 'any'];

// Rule key -> how its value is validated.
const RULES = {
  applicantType: { kind: 'choice', values: APPLICANT_TYPES },
  minGpa: { kind: 'number', min: 0, max: 4 },
  noFailingGrade: { kind: 'flag' },
  minHsAverage: { kind: 'number', min: 60, max: 100 },
  minUnits: { kind: 'number', min: 1, max: 40 },
  residencySemesters: { kind: 'number', min: 1, max: 8 },
  filipino: { kind: 'flag' },
  noBalance: { kind: 'flag' },
  // Open only to students of these programs (codes from data/programs.js);
  // unset = every program. Others don't see it in Explore and can't apply.
  programs: { kind: 'programs' },
};

const DOCUMENT_KEYS = [
  'applicationLetter', 'parentLetter', 'recommendationLetter', 'personalEssay', 'photo2x2', 'indigency',
  'incomeProof', 'employmentCertificate', 'utilityBills', 'electricityBill', 'waterBill', 'residencePictures',
  'vicinityMap', 'psaBirthCertificate', 'reportCard', 'shsGrades', 'grade12Card', 'rankingCertificate',
  'entranceTestResult', 'honorsActivities', 'proofOfRelation', 'polcaForm', 'evaluationSheet', 'alumniForm',
];

// Validates a rules object. Returns { value } (only ticked rules kept) or { error }.
function parseRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Rules must be an object.' };
  const value = {};
  for (const [key, raw] of Object.entries(input)) {
    const spec = RULES[key];
    if (!spec) return { error: `Unknown eligibility rule: ${key}.` };
    if (raw === null || raw === undefined || raw === false || raw === '') continue;
    if (spec.kind === 'programs') {
      if (!Array.isArray(raw) || raw.some(c => typeof c !== 'string' || !findProgram(c))) return { error: 'Choose programs from the list.' };
      const codes = [...new Set(raw.map(c => findProgram(c).code))];
      if (codes.length) value[key] = codes;
      continue;
    }
    if (spec.kind === 'flag') {
      if (raw !== true) return { error: `${key} must be true or false.` };
      value[key] = true;
    } else if (spec.kind === 'choice') {
      if (!spec.values.includes(raw)) return { error: `${key} must be one of: ${spec.values.join(', ')}.` };
      value[key] = raw;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) return { error: `${key} must be between ${spec.min} and ${spec.max}.` };
      value[key] = Math.round(n * 100) / 100;
    }
  }
  return { value };
}

module.exports = { RULES, DOCUMENT_KEYS, APPLICANT_TYPES, parseRules };
