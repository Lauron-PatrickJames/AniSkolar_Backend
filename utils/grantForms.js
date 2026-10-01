// Server-side parsing and validation for the grant-form application flows
// (applicationFormType 'polca' and 'alumni'). The frontend validates the
// same rules for UX, but the eligibility rules and required documents
// are re-checked here so they can't be skipped by crafting the request.

const GRANT_FORM_TYPES = ['polca', 'alumni'];

// Multipart text fields holding one JSON-encoded form section each. These
// map 1:1 onto the Application model's section fields.
const SECTION_FIELDS = [
  'personalInfo', 'contactSchool', 'parentsGuardian', 'siblings',
  'assetsExpenses', 'agreement', 'eligibilityAnswers', 'evaluationSheet',
];

function isGrantFormType(formType) {
  return GRANT_FORM_TYPES.includes(formType);
}

function isBlank(value) {
  return typeof value !== 'string' || !value.trim();
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Returns { sections } or { error }.
function parseGrantSections(body, formType) {
  const sections = {};
  for (const field of SECTION_FIELDS) {
    if (body[field] === undefined) continue;
    try {
      sections[field] = JSON.parse(body[field]);
    } catch {
      return { error: `Invalid ${field} format.` };
    }
  }

  const required = ['personalInfo', 'contactSchool', 'parentsGuardian', 'assetsExpenses', 'agreement', 'eligibilityAnswers'];
  if (formType === 'polca') required.push('evaluationSheet');
  const missing = required.filter(f => !sections[f] || typeof sections[f] !== 'object');
  if (missing.length) {
    return { error: `Missing required form sections: ${missing.join(', ')}.` };
  }
  if (sections.siblings !== undefined && !Array.isArray(sections.siblings)) {
    return { error: 'Invalid siblings format.' };
  }
  if (!sections.siblings) sections.siblings = [];

  return { sections };
}

// Apply-time eligibility (rules the scholarship blocks on). Returns a list
// of user-facing reasons; empty means eligible.
function checkEligibility(scholarship, sections) {
  const rules = scholarship.eligibility || {};
  const answers = sections.eligibilityAnswers || {};
  const problems = [];

  if (rules.minHsGeneralAverage !== undefined) {
    const avg = answers.hsGeneralAverage;
    if (!isNumber(avg) || avg > 100) {
      problems.push('Enter your high school general average.');
    } else if (avg < rules.minHsGeneralAverage) {
      problems.push(`A high school general average of at least ${rules.minHsGeneralAverage} is required.`);
    }
  }
  if (rules.minHsSubjectGrade !== undefined) {
    const lowest = answers.lowestHsGrade;
    if (!isNumber(lowest) || lowest > 100) {
      problems.push('Enter your lowest high school subject grade.');
    } else if (lowest < rules.minHsSubjectGrade) {
      problems.push(`No high school grade may be below ${rules.minHsSubjectGrade}.`);
    }
  }
  if (rules.requiresNoBoardRelation && answers.notRelatedToBoardMember !== true) {
    problems.push('You must declare that you are not related by consanguinity to any current board member.');
  }

  if (rules.alumniRelationships) {
    if (isBlank(answers.alumnusName)) problems.push("Enter the alumnus/alumna's name.");
    if (!rules.alumniRelationships.includes(answers.relationship)) {
      problems.push('The alumnus/alumna must be related to you up to the 2nd degree of consanguinity.');
    }
    if (!rules.alumniInstitutions.includes(answers.institution)) {
      problems.push('Select the De La Salle institution the alumnus/alumna graduated from.');
    }
    const year = Number(answers.batchYear);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) {
      problems.push("Enter the alumnus/alumna's batch / year graduated.");
    }
  }

  return problems;
}

// Certification checkboxes + typed names that must be present on submit.
function checkCertifications(formType, sections) {
  const problems = [];
  const agreement = sections.agreement || {};
  if (agreement.agreed !== true || isBlank(agreement.applicantName) || isBlank(agreement.parentGuardianName)) {
    problems.push('Complete the certification: tick the consent box and type the applicant and parent/guardian names.');
  }
  if (formType === 'polca') {
    const statements = sections.evaluationSheet?.statements || {};
    for (const who of ['applicant', 'parent']) {
      const s = statements[who] || {};
      if (s.agreed !== true || isBlank(s.name)) {
        problems.push(`Complete the ${who === 'applicant' ? 'applicant' : 'parent/guardian'} statement on the evaluation sheet.`);
      }
    }
  }
  return problems;
}

// Required upload slots with no file. `presentSlotKeys` is the set of slot
// keys that have at least one file (new uploads plus, on resubmit, files
// already on record).
function missingDocumentSlots(scholarship, sections, presentSlotKeys) {
  return (scholarship.documentSlots || [])
    .filter(slot => !slot.when || slot.when(sections))
    .filter(slot => !presentSlotKeys.has(slot.key))
    .map(slot => slot.key);
}

// Parses the optional "documentMeta" multipart field — a JSON array aligned
// with the uploaded files: [{ slotKey, variant? }, ...].
function parseDocumentMeta(raw, fileCount) {
  if (raw === undefined) return { meta: [] };
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { error: 'Invalid document metadata format.' };
  }
  if (!Array.isArray(meta) || meta.length !== fileCount) {
    return { error: 'Document metadata does not match the uploaded files.' };
  }
  const cleaned = meta.map(m => ({
    slotKey: typeof m?.slotKey === 'string' ? m.slotKey : undefined,
    variant: typeof m?.variant === 'string' && m.variant.trim() ? m.variant.trim() : undefined,
  }));
  return { meta: cleaned };
}

module.exports = {
  GRANT_FORM_TYPES,
  isGrantFormType,
  parseGrantSections,
  checkEligibility,
  checkCertifications,
  missingDocumentSlots,
  parseDocumentMeta,
};
