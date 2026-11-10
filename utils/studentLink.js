const { clerkClient } = require('@clerk/express');
const Student = require('../models/Student');
const ApplicationDraft = require('../models/ApplicationDraft');

// Students are linked to their Clerk account by clerkId. A new Clerk
// instance (development -> production) gives every student a new user id,
// so when no record has this id, the record with the same verified
// @dlsud.edu.ph email is moved to it (with the student's saved application
// drafts). The email is the university account Microsoft verified, so it
// identifies the same student.

const ALLOWED_EMAIL_DOMAIN = '@dlsud.edu.ph';
// Accounts with no student record (admins, or students before sign-up):
// don't ask Clerk again for a while.
const NO_MATCH_TTL_MS = 10 * 60 * 1000;
const noMatch = new Map();

async function verifiedUniversityEmail(userId) {
  const user = await clerkClient.users.getUser(userId);
  const primary = user.emailAddresses?.find(e => e.id === user.primaryEmailAddressId);
  const email = primary?.verification?.status === 'verified' ? primary.emailAddress.toLowerCase() : '';
  return email.endsWith(ALLOWED_EMAIL_DOMAIN) ? email : '';
}

// Moves the student record with this account's email to `userId`. Returns
// true when a record was linked.
async function relinkStudent(userId) {
  if (!userId) return false;
  const seen = noMatch.get(userId);
  if (seen && Date.now() - seen < NO_MATCH_TTL_MS) return false;
  try {
    const email = await verifiedUniversityEmail(userId);
    const student = email
      ? await Student.findOneAndUpdate({ email, clerkId: { $ne: userId } }, { $set: { clerkId: userId } }, { returnDocument: 'before' }).lean()
      : null;
    if (!student) {
      noMatch.set(userId, Date.now());
      return false;
    }
    await ApplicationDraft.updateMany({ studentNumber: student.studentNumber }, { $set: { clerkId: userId } })
      .catch(err => console.error('Moving application drafts failed:', err));
    console.log(`Linked student ${student.studentNumber} to a new sign-in account.`);
    return true;
  } catch (err) {
    console.error('Student re-link failed:', err);
    return false;
  }
}

// Runs `find` (a Student lookup by clerkId); if nothing is found, re-links
// by email and tries once more.
async function findLinkedStudent(userId, find) {
  const student = await find();
  if (student || !(await relinkStudent(userId))) return student;
  return find();
}

module.exports = { relinkStudent, findLinkedStudent };
