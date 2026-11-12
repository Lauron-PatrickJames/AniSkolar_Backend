// The college student governments' scholarships (npm test): their office
// form steps, documents, assessments and slot limits, and that the
// frontend's copy of the scholarship list matches the server's.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { query } = require('./helpers');

// Slot limits: who holds a scholarship now is faked here (before the
// slot module reads it), so no database is needed.
let holders = [];
const exclusivity = require('../utils/exclusivity');
exclusivity.findHeldScholarships = async studentNumber => (holders.includes(studentNumber) ? [{ scholarshipId: currentId }] : []);
let currentId;
const Application = require('../models/Application');
const Student = require('../models/Student');
const { slotsFull } = require('../utils/collegeSlots');

const { SCHOLARSHIPS, findScholarship } = require('../data/scholarships');
const { OFFICE_FORMS, parseOfficeAnswers, officeDocuments, parseAssessment } = require('../data/officeForms');

// A complete, valid set of answers for each office form step.
const VALID = {
  s13: { department: 'ACD', noOtherScholarship: true, noMajorOffense: true, taxExemption: 'no' },
  s14: { branch: 'executive', position: 'Vice President for Finance', activeInvolvement: true, noMajorOffense: true, taxExemption: 'yes' },
  s15: { noMajorOffense: true, noAllowanceScholarship: true },
  s16: { noConcurrentScholarship: true },
  s17: { position: 'chiefOfStaff', noViolation: true, activeOfficer: true },
};

describe('office form steps', () => {
  for (const [id, answers] of Object.entries(VALID)) {
    test(`${id}: complete answers are accepted`, () => {
      const res = parseOfficeAnswers(id, answers);
      assert.equal(res.error, undefined);
      assert.deepEqual(res.value, answers);
    });

    test(`${id}: every question is required`, () => {
      for (const key of Object.keys(answers)) {
        const { [key]: _, ...rest } = answers;
        assert.ok(parseOfficeAnswers(id, rest).error, `${key} left out`);
      }
    });
  }

  test('declarations must be ticked, not just sent', () => {
    assert.ok(parseOfficeAnswers('s15', { ...VALID.s15, noMajorOffense: false }).error);
    assert.ok(parseOfficeAnswers('s16', { noConcurrentScholarship: 'true' }).error);
  });

  test('only the listed choices are accepted', () => {
    assert.ok(parseOfficeAnswers('s13', { ...VALID.s13, department: 'CICS' }).error);
    assert.ok(parseOfficeAnswers('s14', { ...VALID.s14, branch: 'adviser' }).error);
    assert.ok(parseOfficeAnswers('s17', { ...VALID.s17, position: 'president' }).error);
  });

  test('an officer\'s position is at most 100 characters', () => {
    assert.ok(parseOfficeAnswers('s14', { ...VALID.s14, position: 'x'.repeat(101) }).error);
    assert.equal(parseOfficeAnswers('s14', { ...VALID.s14, position: 'x'.repeat(100) }).error, undefined);
  });
});

describe('CBAASG documents', () => {
  const BASE = 5;
  for (const id of ['s13', 's14']) {
    test(`${id}: the tax exemption certificate only when the student has one`, () => {
      const without = officeDocuments(id, { taxExemption: 'no' });
      const withIt = officeDocuments(id, { taxExemption: 'yes' });
      assert.equal(without.length, BASE);
      assert.equal(withIt.length, BASE + 1);
      assert.ok(withIt.includes('Certificate of Tax Exemption'));
      assert.ok(!without.includes('Certificate of Tax Exemption'));
      assert.ok(without.some(d => /Department Chair/.test(d)));
    });
  }

  test('the others use the scholarship\'s own document list', () => {
    for (const id of ['s15', 's16', 's17']) assert.equal(officeDocuments(id, VALID[id]), null);
  });
});

describe('office assessments', () => {
  test('CBAASG records both interview dates', () => {
    assert.deepEqual(parseAssessment('s13', { initialInterview: '2026-11-20', finalInterview: '2026-11-27' }).value,
      { initialInterview: '2026-11-20', finalInterview: '2026-11-27' });
    assert.ok(parseAssessment('s14', { initialInterview: '20/11/2026' }).error);
  });

  test('Padayon Pioneers records the interview booking', () => {
    assert.deepEqual(parseAssessment('s15', { interviewDate: '2026-12-01', interviewTime: '14:30' }).value,
      { interviewDate: '2026-12-01', interviewTime: '14:30' });
    assert.ok(parseAssessment('s15', { interviewTime: '25:00' }).error);
  });

  test('CEATSG grants stay within the semester\'s ₱200,000', () => {
    assert.equal(parseAssessment('s16', { grant: 200000 }).value.grant, 200000);
    assert.ok(parseAssessment('s16', { grant: 200001 }).error);
    assert.ok(parseAssessment('s16', { grant: -1 }).error);
  });

  test('CCJESG grants stay within the highest cap (₱10,000)', () => {
    assert.deepEqual(parseAssessment('s17', { evaluationPassed: true, grant: 7000 }).value, { evaluationPassed: true, grant: 7000 });
    assert.ok(parseAssessment('s17', { grant: 10001 }).error);
  });

  test('empty fields are cleared, not rejected', () => {
    assert.deepEqual(parseAssessment('s16', { interviewDate: '', grant: '' }).value, {});
  });
});

describe('slot limits', () => {
  const run = async (id, count) => {
    currentId = id;
    holders = Array.from({ length: count }, (_, i) => `20230000${i}`);
    Application.distinct = () => query(holders);
    Student.find = () => query(holders.map(studentNumber => ({ studentNumber, name: 'Juan Miguel Dela Cruz' })));
    return slotsFull(findScholarship(id), '202312345');
  };

  test('Padayon Pioneers takes 2 scholars in all', async () => {
    assert.equal(await run('s15', 1), null);
    const full = await run('s15', 2);
    assert.equal(full.slots, 2);
    assert.match(full.message, /only 2 scholars in all/);
  });

  test('the CCJESG officers\' grant takes 11', async () => {
    assert.equal(await run('s17', 10), null);
    assert.equal((await run('s17', 11)).slots, 11);
  });

  test('the CBAASG and CEATSG scholarships have no slot limit', async () => {
    for (const id of ['s13', 's14', 's16']) assert.equal(await run(id, 50), null);
  });
});

// The frontend keeps its own copy of the built-in scholarships
// (src/data/scholarships.ts). A mismatch there showed the Athletic
// Scholarship as Open in the editor while the server had it Closed.
describe('frontend and backend scholarship lists match', () => {
  const file = path.join(__dirname, '..', '..', 'AniSkolar_Frontend', 'src', 'data', 'scholarships.ts');
  const frontendForms = path.join(__dirname, '..', '..', 'AniSkolar_Frontend', 'src', 'data', 'officeForms.ts');
  const available = fs.existsSync(file) && fs.existsSync(frontendForms);
  const opts = { skip: available ? false : 'the frontend repo isn\'t next to this one' };

  const frontend = () => {
    const text = fs.readFileSync(file, 'utf8');
    const byId = {};
    // Each built-in entry, from its id to the next one; the AdSO's leave
    // out the office (it defaults to the AdSO, 'LSO').
    const list = text.slice(text.indexOf('const BUILT_IN_SCHOLARSHIPS'));
    for (const entry of list.split(/\n {4}id: '/).slice(1)) {
      const id = entry.match(/^(s\d+)'/)?.[1];
      if (!id) continue;
      byId[id] = {
        office: entry.match(/\n {4}office: '([A-Z]+)'/)?.[1] ?? 'LSO',
        status: entry.match(/\n {4}status: '([^']+)'/)?.[1],
      };
    }
    return byId;
  };

  test('same scholarships, offices and default status', opts, () => {
    const fe = frontend();
    for (const s of SCHOLARSHIPS) {
      assert.ok(fe[s.id], `${s.id} is missing from the frontend`);
      assert.equal(fe[s.id].office, s.office, `${s.id} office`);
      assert.equal(fe[s.id].status, s.defaultStatus ?? 'Open', `${s.id} default status`);
    }
    assert.deepEqual(Object.keys(fe).sort(), SCHOLARSHIPS.map(s => s.id).sort());
  });

  test('the same scholarships have an office form step', opts, () => {
    const text = fs.readFileSync(frontendForms, 'utf8');
    const ids = [...text.matchAll(/\n {2}(s\d+): \{/g)].map(m => m[1]).sort();
    assert.deepEqual(ids, Object.keys(OFFICE_FORMS).sort());
  });
});
