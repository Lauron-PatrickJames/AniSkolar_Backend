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
// opensOn / closesOn: the default application period (YYYY-MM-DD), until
// the office picks its own (utils/scholarshipDates.js). Keep them the
// same as the frontend's.
//
// referenceCode: the short code that starts each new application's
// reference number (utils/referenceCode.js), e.g. 'ENT' → ENT-2026-0001.
//
// directAward: the office adds its scholars itself (no application), e.g.
// the SDO from its tryouts.
//
// noRenewal: no renewals — an approved scholar keeps it until they graduate
// or stop, which their office records on the application (PATCH
// /api/applications/:id/end). No renewal periods can be opened for it.
//
// oneSemester (always with noRenewal): a grant for one semester only, e.g.
// the USG's SFAG: it counts until the end of the semester it was approved
// for (utils/semester.js), then the student applies again in the next call.
//
// slotsPerCollege: at most this many current scholars per college; a full
// college can't apply or be approved (utils/collegeSlots.js).
// totalSlots: at most this many current scholars in all (campus-wide).
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

const { OFFICE_CODES: OFFICES } = require('./offices');
// Every CBAA program: the CBAASG scholarships are for CBAA students only.
const CBAA_PROGRAMS = require('./programs').PROGRAMS.filter(p => p.college === 'CBAA').map(p => p.code);
const CICS_PROGRAMS = require('./programs').PROGRAMS.filter(p => p.college === 'CICS').map(p => p.code);
const CEAT_PROGRAMS = require('./programs').PROGRAMS.filter(p => p.college === 'CEAT').map(p => p.code);
const CCJE_PROGRAMS = require('./programs').PROGRAMS.filter(p => p.college === 'CCJE').map(p => p.code);

const ALUMNI_INSTITUTIONS = ['DLSU-EAC', 'DLSU-Aguinaldo', 'DLSU-Dasmariñas'];
// 1st and 2nd degree of consanguinity only.
const ALUMNI_RELATIONSHIPS = ['Parent', 'Sibling', 'Grandparent', 'Grandchild'];

const SCHOLARSHIPS = [
  { id: 's1', name: 'Student Financial Aid Grant (SFAG)', office: 'LSO', formType: 'sfag', referenceCode: 'SFAG', opensOn: '2026-06-16', closesOn: '2026-07-03' },
  { id: 's2', name: 'Entrance Scholarship', office: 'LSO', formType: 'standard', referenceCode: 'ENT', opensOn: '2026-06-01', closesOn: '2026-06-20' },
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
    // 2 scholars for the whole campus, kept until they graduate; no
    // renewals (Oct 2026).
    noRenewal: true,
    totalSlots: 2,
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
  // Run by their own offices (they open them, decide, renew); the AdSO sees
  // the approved scholars. They start closed until the office opens them.
  // The SDO picks its scholars from the varsity tryouts: no application
  // and no renewals. It adds each one itself (POST
  // /api/applications/direct-award) with the coach's document.
  { id: 's7', defaultStatus: 'Closed', name: 'Athletic Scholarship', office: 'SDO', formType: 'standard', referenceCode: 'ATH', applicationMode: 'info', noRenewal: true, directAward: true },
  // One semester at a time: members apply each term with that term's
  // performance evaluation and duty hours record.
  { id: 's8', defaultStatus: 'Closed', name: 'Vicissitude Scholarship Program', office: 'VICISSITUDE', formType: 'standard', referenceCode: 'VIC', noRenewal: true, oneSemester: true },
  // s9 (Performing Arts Group) was removed: PAG declined to partner with AniSkolar.
  // The ROTC Office adds its officers itself each semester, at their
  // current rank (the rank sets the amount): no application, no renewals.
  { id: 's10', defaultStatus: 'Closed', name: '267th NROTC Scholarship', office: 'ROTC', formType: 'standard', referenceCode: 'ROTC', applicationMode: 'info', directAward: true, noRenewal: true, oneSemester: true },
  { id: 's11', defaultStatus: 'Closed', name: 'USG Student Financial Aid Grant', office: 'USG', formType: 'standard', referenceCode: 'USGF', noRenewal: true, oneSemester: true },
  // No renewals: staff keep it while they're on the Editorial Staff; the
  // office marks them Stopped when they leave (or Graduated).
  { id: 's12', defaultStatus: 'Closed', name: 'Heraldo Filipino Scholarship', office: 'HERALDO', formType: 'standard', referenceCode: 'HF', noRenewal: true },
  // CBAASG Ordinance No. 01, s. 2021–2022: for CBAA students only (the
  // office can change the programs; its saved rules then apply instead).
  { id: 's13', defaultStatus: 'Closed', name: 'CBAASG Achie Scholarship', office: 'CBAASG', formType: 'standard', referenceCode: 'ACHIE', programs: CBAA_PROGRAMS },
  { id: 's14', defaultStatus: 'Closed', name: 'CBAASG Officers’ Partial Scholarship', office: 'CBAASG', formType: 'standard', referenceCode: 'CBAO', programs: CBAA_PROGRAMS },
  // CICSSG's Padayon Pioneers: two grantees, CICS students only.
  { id: 's15', defaultStatus: 'Closed', name: 'Padayon Pioneers: CICS Student Financial Aid Grant', office: 'CICSSG', formType: 'standard', referenceCode: 'PADAYON', programs: CICS_PROGRAMS, totalSlots: 2, noRenewal: true, oneSemester: true },
  // CEATSG Ordinance No. 02, s. 2025–2026: CEAT students only; the
  // semester's numbers are set by the office (Scholarship Criteria Resolution).
  { id: 's16', defaultStatus: 'Closed', name: 'CEAT Financial Aid Scholarship', office: 'CEATSG', formType: 'standard', referenceCode: 'CEAT', programs: CEAT_PROGRAMS, noRenewal: true, oneSemester: true },
  // CCJESG Ordinance No. 251125: its officers' grant, at most 11 officers.
  { id: 's17', defaultStatus: 'Closed', name: 'CCJESG Officers’ Financial Grant', office: 'CCJESG', formType: 'standard', referenceCode: 'CCJE', programs: CCJE_PROGRAMS, totalSlots: 11, noRenewal: true, oneSemester: true },
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
