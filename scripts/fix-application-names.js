// Corrects the applicant name on applications submitted before name parts
// were stored separately, when the standard form split the full name
// ("Patrick James Lauron" -> First "PATRICK", Last "JAMES LAURON").
//
// The name parts are copied from the student's record (first and last
// from the university account, middle from the profile) — never split
// from a full name. Only the name changes: everything else on the
// application stays as it was submitted. The previous name is kept on the
// application under `nameCorrection` so the change can be traced.
//
// Dry run by default: lists what would change and writes nothing.
//   node scripts/fix-application-names.js           # report only
//   node scripts/fix-application-names.js --apply   # write the corrections
//
// Run scripts/backfill-student-names.js first so every Student has its
// name parts.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const Application = require('../models/Application');
const Student = require('../models/Student');

const APPLY = process.argv.includes('--apply');

const norm = s => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// The stored name block and what the corrected one would be.
function correction(app, student) {
  const middle = (student.middleName || '').trim();
  if (app.standardInfo) {
    const info = app.standardInfo;
    const next = { firstName: student.firstName, middleName: middle, lastName: student.lastName };
    const prev = { firstName: info.firstName, middleName: info.middleName, lastName: info.lastName };
    return { path: 'standardInfo', prev, next };
  }
  if (app.personalInfo && Object.keys(app.personalInfo).length) {
    const info = app.personalInfo;
    const usesInitial = 'middleInitial' in info;
    const next = usesInitial
      ? { firstName: student.firstName, middleInitial: middle.charAt(0).toUpperCase(), lastName: student.lastName }
      : { firstName: student.firstName, middleName: middle, lastName: student.lastName };
    const prev = usesInitial
      ? { firstName: info.firstName, middleInitial: info.middleInitial, lastName: info.lastName }
      : { firstName: info.firstName, middleName: info.middleName, lastName: info.lastName };
    return { path: 'personalInfo', prev, next };
  }
  return null;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const students = await Student.find({ firstName: { $exists: true }, lastName: { $exists: true } })
    .select('studentNumber firstName middleName lastName').lean();
  const byNumber = new Map(students.map(s => [s.studentNumber, s]));
  const apps = await Application.find({ studentNumber: { $in: [...byNumber.keys()] } })
    .select('referenceCode studentNumber standardInfo personalInfo createdAt').lean();

  console.log(`${apps.length} application(s) from students with name parts. ${APPLY ? 'Applying.' : 'Dry run — nothing is written.'}\n`);
  let changed = 0;
  for (const app of apps) {
    const c = correction(app, byNumber.get(app.studentNumber));
    if (!c) continue;
    const differs = Object.keys(c.next).some(k => norm(c.prev[k]) !== norm(c.next[k]));
    if (!differs) continue;
    changed++;
    console.log(`  ${app.referenceCode} (${c.path}): ${JSON.stringify(c.prev)}\n    -> ${JSON.stringify(c.next)}`);
    if (APPLY) {
      const $set = { nameCorrection: { previous: c.prev, correctedAt: new Date(), source: 'scripts/fix-application-names.js' } };
      for (const [k, v] of Object.entries(c.next)) $set[`${c.path}.${k}`] = v;
      await Application.collection.updateOne({ _id: app._id }, { $set });
    }
  }
  console.log(`\n${changed} application(s) ${APPLY ? 'corrected' : 'would be corrected. Re-run with --apply to write them'}.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
