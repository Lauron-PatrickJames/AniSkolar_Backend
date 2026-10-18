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
// applicationMode: 'online' (default) accepts applications through
// AniSkolar. 'info' scholarships are listed for information only: they are
// awarded by nomination, ranking or recruitment,
// so POST /api/applications refuses them.
//
// referenceCode: the short code that starts each new application's
// reference number (utils/referenceCode.js), e.g. 'ENT' → ENT-2026-0001.
//
// noRenewal: no renewals — an approved scholar keeps it until they graduate
// or stop, which their office records on the application (PATCH
// /api/applications/:id/end). No renewal periods can be opened for it.
//
// slotsPerCollege: at most this many current scholars per college; a full
// college can't apply or be approved (utils/collegeSlots.js).
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
  { id: 's1', name: 'Student Financial Aid Grant (SFAG)', office: 'LSO', formType: 'sfag', referenceCode: 'SFAG' },
  { id: 's2', name: 'Entrance Scholarship', office: 'LSO', formType: 'standard', referenceCode: 'ENT' },
  {
    id: 's3',
    name: 'POLCA Scholarship (PSEF)',
    office: 'POLCA',
    formType: 'polca',
    referenceCode: 'PSEF',
    // POLCA takes 2 scholars per college and keeps them until they
    // graduate; no renewals (Oct 2026 — to confirm with POLCA).
    noRenewal: true,
    slotsPerCollege: 2,
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
    referenceCode: 'DAA',
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
  { id: 's5', name: 'Academic Scholarship', office: 'LSO', applicationMode: 'info' },
  { id: 's6', name: 'Enhanced Brother President Scholarship Program (EBPSP)', office: 'LSO', formType: 'standard', referenceCode: 'EBPSP' },
  { id: 's7', name: 'Athletic Scholarship', office: 'LSO', applicationMode: 'info' },
  { id: 's8', name: 'Vicissitude Scholarship Program', office: 'LSO', applicationMode: 'info' },
  // s9 (Performing Arts Group) was removed: PAG declined to partner with AniSkolar.
  { id: 's10', name: '267th NROTC Scholarship', office: 'LSO', applicationMode: 'info' },
  // The USG's own grant, applied for through the USG's form.
  { id: 's11', name: 'USG Student Financial Aid Grant', office: 'LSO', applicationMode: 'info' },
];

// Built-in scholarships, then the ones the AdSO created (standard form;
// kept in memory by utils/customScholarships.js).
function findScholarship(scholarshipId) {
  return SCHOLARSHIPS.find(s => s.id === scholarshipId) || require('../utils/customScholarships').get(scholarshipId);
}

function allScholarships() {
  return [...SCHOLARSHIPS, ...require('../utils/customScholarships').list()];
}

function acceptsOnlineApplications(scholarship) {
  return (scholarship.applicationMode || 'online') === 'online';
}

module.exports = { SCHOLARSHIPS, acceptsOnlineApplications, OFFICES, ALUMNI_INSTITUTIONS, ALUMNI_RELATIONSHIPS, findScholarship, allScholarships };
