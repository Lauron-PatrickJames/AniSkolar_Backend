// FSE reports (npm test): allowances the AdSO enters per scholarship are
// added to every grantee's discount.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReport } = require('../routes/fse');

const body = extra => ({
  academicYear: 'AY 2026–2027', term: '1st Semester', population: 8000,
  scholarships: [{
    code: '1060', name: 'VARSITY - 100% TLMOF', category: 'internalNonAcademic',
    scholars: [
      { studentId: 'S1', matriculation: 50000, totalDiscount: 50000 },
      { studentId: 'S2', matriculation: 40000, totalDiscount: 40000, allowances: 1000, allowanceDetail: { meal: 1000 } },
    ],
    ...extra,
  }],
});

test('without allowances, the FSE is the discount over the matriculation', () => {
  const { report, error } = validateReport(body());
  assert.equal(error, undefined);
  assert.equal(report.scholarships[0].scholars[0].fse, 1);
});

test('entered allowances are added to every grantee', () => {
  const { report } = validateReport(body({ allowances: { meal: 5000, dorm: 2500 } }));
  const [s1, s2] = report.scholarships[0].scholars;
  assert.equal(s1.allowances, 7500);
  assert.equal(s1.totalDiscount, 57500);
  assert.equal(s1.fse, 57500 / 50000);
  assert.deepEqual(s1.allowanceDetail, { meal: 5000, dorm: 2500 });
  // Added to what the file already had.
  assert.equal(s2.allowances, 8500);
  assert.deepEqual(s2.allowanceDetail, { meal: 6000, dorm: 2500 });
  assert.deepEqual(report.scholarships[0].allowances, { meal: 5000, dorm: 2500 });
});

test('zero or invalid amounts are ignored', () => {
  const { report } = validateReport(body({ allowances: { meal: 0, book: -5, other: 'x' } }));
  assert.equal(report.scholarships[0].allowances, undefined);
  assert.equal(report.scholarships[0].scholars[0].totalDiscount, 50000);
});

// Editing a generated report.
const { editReport } = require('../routes/fse');
const term = { academicYear: 'AY 2026–2027', term: '1st Semester', population: 8000 };

test('editing replaces the entered allowances instead of adding to them', () => {
  const saved = validateReport(body({ allowances: { meal: 5000 } })).report;
  const { report, error } = editReport(saved, { ...term, scholarships: [{ code: '1060', category: 'internalNonAcademic', allowances: { book: 1000 } }] });
  assert.equal(error, undefined);
  const [s1, s2] = report.scholarships[0].scholars;
  assert.equal(s1.totalDiscount, 51000);
  assert.deepEqual(s1.allowanceDetail, { book: 1000 });
  // The file's own meal allowance stays.
  assert.equal(s2.allowances, 2000);
  assert.deepEqual(s2.allowanceDetail, { meal: 1000, book: 1000 });
  assert.equal(s2.totalDiscount, 41000);
});

test('editing can change the category and population, and leave a scholarship out', () => {
  const saved = validateReport(body()).report;
  const edited = editReport(saved, { ...term, population: 9000, scholarships: [{ code: '1060', category: 'special', specialFunding: 'internal' }] }).report;
  assert.equal(edited.population, 9000);
  assert.equal(edited.scholarships[0].category, 'special');
  assert.equal(edited.scholarships[0].scholars[0].fse, 1);
  assert.match(editReport(saved, { ...term, scholarships: [] }).error, /no scholarships/);
});
