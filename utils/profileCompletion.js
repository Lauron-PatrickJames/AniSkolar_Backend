// How complete a student's profile is: the one definition, computed on every
// read (GET /api/students/me returns it as `completion`) so it can't drift
// out of sync the way a stored flag could.
//
// core: what the portal can't work without (student number, program, year
// level, GPA). Eligibility filtering depends on these, so a student who
// lacks one is sent to onboarding before the dashboard.
// sections: what fills in over time from the Profile page or from
// scholarship applications. Each lists its required fields; optional ones
// (telephone, name suffix, a 1st year's GPA, a deceased parent's number,
// the guardian when both parents are listed) never count against it.
//
// The frontend's form validation (components/profile/profileForm.ts,
// validateDraft) asks for the same fields per section.

const SECTION_LABELS = {
  academic: 'Academic',
  personal: 'Personal details',
  contact: 'Contact information',
  family: 'Parents and guardian',
};

const filled = v => v !== undefined && v !== null && String(v).trim() !== '';

// Living parents, both listed: no guardian needed.
function needsGuardian(s) {
  const father = filled(s.fatherName) && !s.fatherDeceased;
  const mother = filled(s.motherName) && !s.motherDeceased;
  return !(father && mother);
}

// Required fields per section for this student (some depend on others).
function requiredFields(s) {
  const family = ['fatherName', 'motherName'];
  if (!s.fatherDeceased) family.push('fatherContactNo');
  if (!s.motherDeceased) family.push('motherContactNo');
  if (needsGuardian(s) || filled(s.guardianType)) {
    family.push('guardianType');
    if (s.guardianType === 'other') {
      family.push('guardianName', 'guardianRelationship', 'guardianContactNo');
      if (!s.guardianAddressSameAsHome) family.push('guardianAddress');
    }
  }
  return {
    academic: ['programCode', 'yearLevel', ...(s.yearLevel === '1st Year' ? [] : ['gpa']), 'section'],
    personal: ['firstName', 'lastName', 'middleName', 'dateOfBirth', 'placeOfBirth', 'nationality', 'civilStatus'],
    contact: ['homeAddress', 'province', 'cityMunicipality', 'zipCode', 'mobileNumber'],
    family,
  };
}

const CORE_FIELDS = s => ['studentNumber', 'programCode', 'yearLevel', ...(s.yearLevel === '1st Year' ? [] : ['gpa'])];

function computeProfileCompletion(student) {
  const s = student && typeof student.toObject === 'function' ? student.toObject() : (student || {});
  const required = requiredFields(s);
  const sections = Object.entries(required).map(([key, fields]) => {
    const missing = fields.filter(f => !filled(s[f]));
    return { key, label: SECTION_LABELS[key], complete: missing.length === 0, missing, required: fields.length };
  });
  const total = sections.reduce((n, x) => n + x.required, 0);
  const done = sections.reduce((n, x) => n + x.required - x.missing.length, 0);
  return {
    coreComplete: CORE_FIELDS(s).every(f => filled(s[f])),
    percent: total ? Math.floor((done / total) * 100) : 100,
    complete: sections.every(x => x.complete),
    sections,
  };
}

module.exports = { computeProfileCompletion, requiredFields, CORE_FIELDS };
