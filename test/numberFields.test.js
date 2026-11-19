// Number-only fields in application forms (npm test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numberFieldError, numberFieldProblem, bodySections } = require('../utils/numberFields');

test('phone numbers in the usual formats are accepted', () => {
  for (const phone of ['09171234567', '0917 123 4567', '+639171234567', '(046) 481 1900', '481-1900']) {
    assert.equal(numberFieldError({ contactSchool: { mobileNo: phone } }), null, phone);
  }
});

test('letters in a phone number are refused, at any depth', () => {
  assert.match(numberFieldError({ contactSchool: { mobileNo: '0917abc4567' } }), /isn’t a phone number/);
  assert.match(numberFieldError({ parentsGuardian: { father: { companyTel: 'none' } } }), /isn’t a phone number/);
  assert.match(numberFieldError({ grant: { evaluationSheet: { employment: { telNo: 'ask HR' } } } }), /isn’t a phone number/);
  assert.match(numberFieldError({ standardInfo: { phone: '12' } }), /isn’t a phone number/);
});

test('“N/A” (an absent parent on the SFAG form) is accepted', () => {
  assert.equal(numberFieldError({ parentsGuardian: { mother: { companyTel: 'N/A' } } }), null);
});

test('empty phone numbers are left to the required checks', () => {
  assert.equal(numberFieldError({ contactSchool: { landlineNo: '' } }), null);
});

test('a sibling’s tuition or income must be an amount', () => {
  assert.equal(numberFieldError({ siblings: [{ tuitionOrIncome: '5000' }, { tuitionOrIncome: '₱12,500.50' }] }), null);
  assert.match(numberFieldError({ siblings: [{ tuitionOrIncome: 'five thousand' }] }), /isn’t an amount/);
});

test('other text fields are not affected', () => {
  assert.equal(numberFieldError({ standardInfo: { firstName: 'Juan', address: '12 Mabini St.' } }), null);
});

test('the body’s JSON sections are read', () => {
  const sections = bodySections({ contactSchool: JSON.stringify({ mobileNo: 'abc' }), standardInfo: 'not json' });
  assert.deepEqual(Object.keys(sections), ['contactSchool']);
  assert.ok(numberFieldError(sections));
});

test('the SFAG’s bill brackets aren’t phone numbers (telephoneBill, mobilePhoneBill)', () => {
  assert.equal(numberFieldError({ assetsExpenses: { telephoneBill: '₱0 – ₱5,321.66', mobilePhoneBill: '₱5,321.67 – ₱10,643.32' } }), null);
  assert.equal(numberFieldError({ contactSchool: { telephoneNumber: '(046) 481 1900' } }), null);
});

test('the message says where the problem is, and which section', () => {
  assert.deepEqual(numberFieldProblem({ parentsGuardian: { father: { companyTel: 'none' } } }), {
    message: 'Parents & Guardian, Father’s company tel. no.: “none” isn’t a phone number. Use digits only, e.g. 09171234567.',
    section: 'parentsGuardian',
  });
  assert.match(numberFieldError({ contactSchool: { mobileNo: 'abc' } }), /^Contact & School, Mobile no\.: /);
  assert.match(numberFieldError({ siblings: [{ tuitionOrIncome: '5000' }, { tuitionOrIncome: 'five' }] }), /^Siblings, Sibling 2’s tuition or income: /);
});
