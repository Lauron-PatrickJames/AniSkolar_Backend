// Server-side source of truth for valid scholarships. The application
// submit route checks scholarshipId against this list instead of trusting
// whatever scholarshipId/scholarshipName the client sends.
//
// IMPORTANT: keep this in sync with frontend/src/data/scholarships.ts
// (mockScholarships) — whenever you add/rename/remove a scholarship there,
// mirror the id + name change here too. Once scholarships are managed
// server-side (e.g. their own MongoDB collection), replace this file with
// a DB query and delete this comment.
//
// office: which scholarship office reviews the grant ('LSO' is the AdSO's
// stored code). Every admin has an office in their Clerk publicMetadata
// (ADSO, POLCA or ALUMNI); see middleware/requireAdmin.js and
// utils/officeScope.js for who sees what.
//
// For the grant-form scholarships (applicationFormType 'polca' / 'alumni'):
//   - eligibility: the rules checked at apply time (utils/grantForms.js).
//     Retention rules (GPA, no failing grades, unit load, good moral) are
//     display-only and live on the frontend entry.
//   - documentSlots: upload slot keys that must have at least one file.
//     Keys MUST match `key` in the frontend's documentSlots for the same
//     scholarship. Slots satisfied by the in-app form (source: 'form' on
//     the frontend) are not listed here. `when` makes a slot conditional
//     on an answer in the submitted form.

const OFFICES = ['LSO', 'POLCA', 'ALUMNI'];

const ALUMNI_INSTITUTIONS = ['DLSU-EAC', 'DLSU-Aguinaldo', 'DLSU-Dasmariñas'];
// 1st and 2nd degree of consanguinity only.
const ALUMNI_RELATIONSHIPS = ['Parent', 'Sibling', 'Grandparent', 'Grandchild'];

const SCHOLARSHIPS = [
  { id: 's1', name: 'Student Financial Aid (SFA) Grant', office: 'LSO', formType: 'sfag', referencePrefix: 'DLSU-D-SFAG' },
  { id: 's2', name: 'Entrance Scholarship', office: 'LSO', formType: 'standard', referencePrefix: 'DLSU-D-ENTRANCE' },
  {
    id: 's3',
    name: 'POLCA Scholarship (PSEF)',
    office: 'POLCA',
    formType: 'polca',
    referencePrefix: 'POLCA-PSEF',
    eligibility: {
      minHsGeneralAverage: 85,
      // "No grade in the 70s" — every HS subject grade must be at least 80.
      minHsSubjectGrade: 80,
      requiresNoBoardRelation: true,
    },
    documentSlots: [
      { key: 'photo2x2' },
      { key: 'parentLetter' },
      { key: 'personalEssay' },
      { key: 'indigency' },
      { key: 'incomeProof' },
      { key: 'shsGrades' },
      { key: 'recommendationLetter' },
      { key: 'residencePictures' },
      { key: 'vicinityMap' },
      { key: 'entranceTestResult' },
      { key: 'electricityBill', when: (app) => app.evaluationSheet?.assets?.electricity?.has === 'Yes' },
      { key: 'waterBill', when: (app) => app.evaluationSheet?.assets?.water?.has === 'Yes' },
    ],
  },
  {
    id: 's4',
    name: 'DLSU-D Alumni Association Scholarship',
    office: 'ALUMNI',
    formType: 'alumni',
    referencePrefix: 'DLSUD-AA',
    eligibility: {
      alumniInstitutions: ALUMNI_INSTITUTIONS,
      alumniRelationships: ALUMNI_RELATIONSHIPS,
    },
    // The accomplished alumni application form is the in-app form itself
    // (no official PDF yet), so it has no upload slot here.
    documentSlots: [
      { key: 'psaBirthCertificate' },
      { key: 'parentLetter' },
      { key: 'incomeProof' },
      { key: 'employmentCertificate' },
      { key: 'grade12Card' },
      // Honors/extracurriculars are optional — not every applicant has any.
      { key: 'vicinityMap' },
      { key: 'entranceTestResult' },
      { key: 'proofOfRelation' },
    ],
  },
];

function findScholarship(scholarshipId) {
  return SCHOLARSHIPS.find(s => s.id === scholarshipId);
}

module.exports = { SCHOLARSHIPS, OFFICES, ALUMNI_INSTITUTIONS, ALUMNI_RELATIONSHIPS, findScholarship };
