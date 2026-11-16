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
