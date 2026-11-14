// Deleting students (npm test): only students with nothing active can be
// deleted; they and their records move to the Trash and come back on
// restore.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { query } = require('./helpers');

// Held scholarships are faked before the module reads them.
let held = [];
const exclusivity = require('../utils/exclusivity');
exclusivity.findHeldScholarships = async () => held;

const Student = require('../models/Student');
const Application = require('../models/Application');
const ApplicationDraft = require('../models/ApplicationDraft');
const Renewal = require('../models/Renewal');
const DutyLog = require('../models/DutyLog');
const Message = require('../models/Message');
const MessageThread = require('../models/MessageThread');
const TrashItem = require('../models/TrashItem');
const { deleteBlock, trashStudent, restoreStudent } = require('../utils/studentDelete');

const SN = '202399001';
let created, removed;

beforeEach(() => {
  held = [];
  created = null;
  removed = [];
  Application.findOne = () => query(null);
  Renewal.findOne = () => query(null);
  Student.findOne = () => query({ _id: 'stu1', studentNumber: SN, name: 'JUAN DELA CRUZ' });
  Student.deleteOne = async f => { removed.push(['students', f]); };
  for (const [name, Model] of [['applications', Application], ['drafts', ApplicationDraft], ['renewals', Renewal], ['dutyLogs', DutyLog], ['messages', Message], ['threads', MessageThread]]) {
    Model.find = () => query(name === 'applications' ? [{ _id: 'a1', status: 'Rejected', documents: [{ fileId: 'f1' }] }] : name === 'messages' ? [{ _id: 'm1', attachments: [{ fileId: 'f2' }] }] : []);
    Model.deleteMany = async f => { removed.push([name, f]); };
  }
  TrashItem.create = async doc => { created = doc; return doc; };
});

describe('who can be deleted', () => {
  test('a rejected applicant can', async () => {
    assert.equal(await deleteBlock(SN), null);
  });

  test('a current scholar can’t', async () => {
    held = [{ scholarshipId: 's1', scholarshipName: 'Student Financial Aid Grant (SFAG)' }];
    assert.match(await deleteBlock(SN), /hold the Student Financial Aid Grant/);
  });

  test('an application still being decided blocks it', async () => {
    Application.findOne = () => query({ scholarshipName: 'POLCA Scholarship (PSEF)' });
    assert.match(await deleteBlock(SN), /POLCA Scholarship \(PSEF\) application is still being decided/);
  });

  test('a renewal still being decided blocks it', async () => {
    Renewal.findOne = () => query({ scholarshipName: 'Entrance Scholarship' });
    assert.match(await deleteBlock(SN), /renewal is still being decided/);
  });
});

describe('deleting', () => {
  test('moves the student and their records to the Trash, with their files', async () => {
    const res = await trashStudent(SN, { email: 'adso@dlsud.edu.ph', name: 'AdSO' });
    assert.ok(res.item);
    assert.equal(created.kind, 'student');
    assert.match(created.title, /JUAN DELA CRUZ \(202399001\)/);
    assert.deepEqual(created.files, ['f1', 'f2']);
    assert.equal(created.extra.applications.length, 1);
    assert.ok(removed.some(([n]) => n === 'students'));
    assert.ok(removed.some(([n]) => n === 'applications'));
  });

  test('a blocked student is left untouched', async () => {
    held = [{ scholarshipName: 'SFAG' }];
    const res = await trashStudent(SN);
    assert.equal(res.status, 409);
    assert.equal(created, null);
    assert.deepEqual(removed, []);
  });
});

describe('restoring', () => {
  test('is refused when they signed up again', async () => {
    Student.exists = async () => true;
    const res = await restoreStudent({ data: { studentNumber: SN }, extra: {} });
    assert.equal(res.status, 409);
  });
});
