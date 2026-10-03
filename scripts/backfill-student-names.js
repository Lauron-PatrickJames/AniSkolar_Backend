// Backfills Student.firstName / lastName from each student's Clerk profile.
//
// Before this change only the joined `name` was stored, and the forms split
// it by guessing ("Patrick James Lauron" → First "Patrick", Last "James
// Lauron"). Clerk keeps first and last name separately, so the parts are
// copied from Clerk — never split from `name`.
//
// Dry run by default: prints what would change and writes nothing.
//   node scripts/backfill-student-names.js           # report only
//   node scripts/backfill-student-names.js --apply   # write Student records
//
// Submitted applications are NOT rewritten (their answers are what the
// student submitted). The report lists applications whose stored first /
// last name differs from Clerk's, for manual review; admin pages show the
// full name, which reads correctly either way.
require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const { clerkClient } = require('@clerk/express');
const Student = require('../models/Student');
const Application = require('../models/Application');

const APPLY = process.argv.includes('--apply');

function storedParts(app) {
  const info = app.applicationFormType === 'standard' ? app.standardInfo : app.personalInfo;
  return { first: (info?.firstName || '').trim(), last: (info?.lastName || '').trim() };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const students = await Student.find({ $or: [{ firstName: { $exists: false } }, { lastName: { $exists: false } }] });
  console.log(`${students.length} student(s) without stored name parts. ${APPLY ? 'Applying.' : 'Dry run — nothing is written.'}`);

  let updated = 0;
  const mismatches = [];
  for (const student of students) {
    let clerkUser;
    try {
      clerkUser = await clerkClient.users.getUser(student.clerkId);
    } catch (err) {
      console.warn(`  ${student.studentNumber}: Clerk lookup failed (${err.message}); skipped`);
      continue;
    }
    const firstName = (clerkUser.firstName || '').trim();
    const lastName = (clerkUser.lastName || '').trim();
    console.log(`  ${student.studentNumber}: "${student.name}" → first "${firstName}", last "${lastName}"`);
    if (APPLY && (firstName || lastName)) {
      await Student.updateOne({ _id: student._id }, { $set: { firstName: firstName || undefined, lastName: lastName || undefined } });
      updated++;
    }
    const apps = await Application.find({ studentNumber: student.studentNumber }).select('referenceCode applicationFormType standardInfo personalInfo');
    for (const app of apps) {
      const { first, last } = storedParts(app);
      if ((first || last) && (first.toLowerCase() !== firstName.toLowerCase() || last.toLowerCase() !== lastName.toLowerCase())) {
        mismatches.push(`  ${app.referenceCode}: form has first "${first}", last "${last}"; Clerk has "${firstName}" / "${lastName}"`);
      }
    }
  }

  console.log(`\n${APPLY ? `Updated ${updated} student(s).` : 'Re-run with --apply to write these.'}`);
  console.log(`\n${mismatches.length} application(s) whose form name split differs from Clerk (left unchanged, review manually):`);
  mismatches.forEach(line => console.log(line));
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
