// Office-specific parts of the standard application form, for the
// scholarships whose office decides on its own criteria. Mirrors
// OFFICE_FORMS in the frontend's src/data/officeForms.ts (same keys and
// options; the frontend has the labels).
//
//   answers     what the student answers in the form's office step, saved
//               as standardInfo.officeAnswers and checked on submit.
//               showIf: { key, value } asks it only after that answer.
//   documents   the documents to upload, by an answer (replaces the
//               scholarship's list), e.g. the SDO's coach's document.
//   award       scholarships the office adds itself (directAward): who
//               they add ('player'), who must approve, and the history note.
//   assessment  what the office records while deciding (the points,
//               rating, rank or schedule behind its decision), saved by
//               PATCH /api/applications/:id/office-assessment.
//               Never shown to the student.

const SPORTS = ['Basketball', 'Volleyball', 'Athletics (track and field)', 'Badminton', 'Table tennis', 'Swimming', 'Chess'];
const SCORE = { type: 'number', min: 1, max: 5, step: 0.01 };

// CBAASG: the tax exemption certificate is optional, so it's asked for
// only when the student says they have one.
const CBAASG_BASE = [
  'Recommendation letter from your Department Chair',
  'Grades from the previous academic year',
  'Certificate of Registration (COR) for the current semester',
  'Certificate of Indigency or proof of inability to pay the tuition fee',
  'Payslip or ITR supporting your parents’ or guardian’s annual gross income',
];
const CBAASG_DOCUMENTS = { by: 'taxExemption', yes: [...CBAASG_BASE, 'Certificate of Tax Exemption'], no: CBAASG_BASE };
const CBAASG_INTERVIEWS = { initialInterview: { type: 'date' }, finalInterview: { type: 'date' } };

const OFFICE_FORMS = {
  // Sports Development Office: no application. It adds each player picked
  // from the tryouts (POST /api/applications/direct-award); these are the
  // details it records then, with the coach's document and the SDO
  // Director's approval.
  s7: {
    answers: {
      playerType: { type: 'choice', options: ['incoming', 'current'] },
      sport: { type: 'choice', options: SPORTS },
      coach: { type: 'text', max: 100 },
    },
    award: { who: 'player', approver: 'SDO Director', note: 'Picked from the varsity tryouts; approved by the SDO Director.' },
    documents: {
      by: 'playerType',
      incoming: ['Coach\'s evaluation and recommendation'],
      current: ['Coach\'s evaluation and endorsement'],
    },
    assessment: {
      tuitionDiscount: { type: 'number', min: 0, max: 100, step: 1 },
      matriculation: { type: 'bool' },
      foodAndLodging: { type: 'bool' },
    },
  },
  // Vicissitude: Editorial Board discounts follow the performance rating
  // (60% Coordinator and Layout Artist, 40% Editorial Board).
  s8: {
    answers: {
      member: { type: 'choice', options: ['board', 'staff'] },
      position: { type: 'text', max: 100 },
      department: { type: 'text', max: 100, showIf: { key: 'member', value: 'staff' } },
      dutyHours: { type: 'number', min: 0, max: 1000, step: 1 },
    },
    assessment: {
      coordinatorScore: SCORE,
      boardScore: SCORE,
    },
  },
  // 267th NROTCU: no application. The ROTC Office adds each officer every
  // semester (POST /api/applications/direct-award) with the Commandant's
  // or ROTC Coordinator's recommendation; the amount follows the rank.
  s10: {
    answers: {
      rank: { type: 'choice', options: ['corps', 'vice', 'second', 'third', 'fourth'] },
      activeDuty: { type: 'confirm' },
    },
    documents: Object.fromEntries([['by', 'rank'], ...['corps', 'vice', 'second', 'third', 'fourth'].map(r => [r, ['Recommendation from the Commandant and/or the ROTC Coordinator']])]),
    award: { who: 'officer', approver: 'Commandant or ROTC Coordinator', note: 'Added by the ROTC Office at their current rank, recommended by the Commandant or ROTC Coordinator.' },
    assessment: {
      amount: { type: 'number', min: 0, max: 100000, step: 1 },
    },
  },
  // University Student Government: documents verified within 72 hours,
  // then an on-site submission schedule.
  s11: {
    answers: {
      noOtherScholarship: { type: 'confirm' },
      noMajorOffense: { type: 'confirm' },
    },
    assessment: {
      verified: { type: 'bool' },
      onsiteDate: { type: 'date' },
      onsiteTime: { type: 'time' },
    },
  },
  // Heraldo Filipino: the Managing Director computes the points.
  s12: {
    answers: {
      position: { type: 'choice', options: ['junior', 'senior', 'section', 'associate', 'managing', 'chief'] },
      publishedWorks: { type: 'number', min: 0, max: 500, step: 1 },
    },
    assessment: {
      evaluationScore: { type: 'number', min: 0, max: 100, step: 0.01 },
      publishedWorks: { type: 'number', min: 0, max: 500, step: 1 },
      officeHours: { type: 'number', min: 0, max: 100, step: 0.01 },
      merit: { type: 'choice', options: ['3', '2', '1', '0', 'demerit'] },
    },
  },  // CBAASG (Ordinance No. 01, s. 2021–2022): one Achie scholar per CBAA
  // department, and its officers' 25%. Same documents and interviews.
  s13: {
    answers: {
      department: { type: 'choice', options: ['ABD', 'ACD', 'BMD', 'MKD'] },
      noOtherScholarship: { type: 'confirm' },
      noMajorOffense: { type: 'confirm' },
      taxExemption: { type: 'choice', options: ['yes', 'no'] },
    },
    documents: CBAASG_DOCUMENTS,
    assessment: CBAASG_INTERVIEWS,
  },
  s14: {
    answers: {
      branch: { type: 'choice', options: ['executive', 'legislative'] },
      position: { type: 'text', max: 100 },
      activeInvolvement: { type: 'confirm' },
      noMajorOffense: { type: 'confirm' },
      taxExemption: { type: 'choice', options: ['yes', 'no'] },
    },
    documents: CBAASG_DOCUMENTS,
    assessment: CBAASG_INTERVIEWS,
  },
  // CICSSG's Padayon Pioneers: confirmed by email, then an interview.
  s15: {
    answers: {
      noMajorOffense: { type: 'confirm' },
      noAllowanceScholarship: { type: 'confirm' },
    },
    assessment: {
      interviewDate: { type: 'date' },
      interviewTime: { type: 'time' },
    },
  },
  // CEATSG: the Director of Academics evaluates; grants come from the
  // semester's ₱200,000 fund.
  s16: {
    answers: {
      noConcurrentScholarship: { type: 'confirm' },
    },
    assessment: {
      interviewDate: { type: 'date' },
      interviewTime: { type: 'time' },
      grant: { type: 'number', min: 0, max: 200000, step: 1 },
    },
  },
  // CCJESG: the grant is capped by position (₱10,000 / ₱7,000 / ₱6,000).
  s17: {
    answers: {
      position: { type: 'choice', options: ['governor', 'viceGovernor', 'chiefOfStaff', 'executive', 'legislative'] },
      noViolation: { type: 'confirm' },
      activeOfficer: { type: 'confirm' },
    },
    assessment: {
      interviewDate: { type: 'date' },
      evaluationPassed: { type: 'bool' },
      grant: { type: 'number', min: 0, max: 10000, step: 1 },
    },
  },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// One value against its rule: { value } or { error }. Empty → { value: undefined }.
function parseValue(rule, raw) {
  if (raw === undefined || raw === null || raw === '') return { value: undefined };
  switch (rule.type) {
    case 'choice': return rule.options.includes(String(raw)) ? { value: String(raw) } : { error: true };
    case 'text': return typeof raw === 'string' && raw.trim().length <= rule.max ? { value: raw.trim() || undefined } : { error: true };
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) && n >= rule.min && n <= rule.max ? { value: n } : { error: true };
    }
    case 'confirm': return raw === true ? { value: true } : { error: true };
    case 'bool': return typeof raw === 'boolean' ? { value: raw } : { error: true };
    case 'date': return typeof raw === 'string' && DATE.test(raw) ? { value: raw } : { error: true };
    case 'time': return typeof raw === 'string' && TIME.test(raw) ? { value: raw } : { error: true };
    default: return { error: true };
  }
}

// The student's answers for a scholarship with an office form: every
// question asked is required. Returns { value } or { error }; { value:
// undefined } for scholarships without one.
function parseOfficeAnswers(scholarshipId, raw) {
  const form = OFFICE_FORMS[scholarshipId];
  if (!form) return { value: undefined };
  const answers = raw && typeof raw === 'object' ? raw : {};
  const value = {};
  for (const [key, rule] of Object.entries(form.answers)) {
    if (rule.showIf && answers[rule.showIf.key] !== rule.showIf.value) continue;
    const parsed = parseValue(rule, answers[key]);
    if (parsed.error || parsed.value === undefined) return { error: 'Answer every question in the office’s step of the form.' };
    value[key] = parsed.value;
  }
  return { value };
}

// The documents a student must upload for their answers, or null when the
// scholarship's own list applies.
function officeDocuments(scholarshipId, answers) {
  const docs = OFFICE_FORMS[scholarshipId]?.documents;
  if (!docs) return null;
  return docs[answers?.[docs.by]] ?? [];
}

// The office's assessment; fields left empty are cleared.
function parseAssessment(scholarshipId, raw) {
  const form = OFFICE_FORMS[scholarshipId];
  if (!form?.assessment) return { error: 'This scholarship has no office assessment.' };
  const body = raw && typeof raw === 'object' ? raw : {};
  const value = {};
  for (const [key, rule] of Object.entries(form.assessment)) {
    const parsed = parseValue(rule, body[key]);
    if (parsed.error) return { error: 'Check the values: one is out of range.' };
    if (parsed.value !== undefined) value[key] = parsed.value;
  }
  return { value };
}

module.exports = { OFFICE_FORMS, parseOfficeAnswers, officeDocuments, parseAssessment };
