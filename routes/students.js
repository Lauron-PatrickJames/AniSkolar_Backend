const express = require('express');
const router = express.Router();
const { getAuth, clerkClient } = require('@clerk/express');
const Student = require('../models/Student');
const { findLinkedStudent } = require('../utils/studentLink');
const { computeProfileCompletion, CORE_FIELDS } = require('../utils/profileCompletion');
const Message = require('../models/Message');
const Application = require('../models/Application');
const { findProgram, YEAR_LEVELS } = require('../data/programs');
const { requireAdso } = require('../middleware/requireAdmin');
const { requireStudent } = require('../middleware/requireStudent');
const { EXCLUSIVE_SCHOLARSHIP_ID, findHeldScholarships } = require('../utils/exclusivity');
const { slotsFull: scholarSlotsFull } = require('../utils/collegeSlots');
const { allScholarships } = require('../data/scholarships');

const ALLOWED_EMAIL_DOMAIN = '@dlsud.edu.ph';

// DLSU-D student numbers: the 4-digit year the student first enrolled at
// DLSU-D (possibly in high school, kept into college), then 5
// digits, e.g. 202312345. Same rule as CompleteProfilePage in the frontend.
// The year is NOT the college entry year, so it says nothing about year level.
function validStudentNumber(value) {
  if (typeof value !== 'string' || !/^\d{9}$/.test(value.trim())) return false;
  const year = Number(value.trim().slice(0, 4));
  return year >= 1990 && year <= new Date().getFullYear() + 1;
}

// Fields a student is allowed to set themselves. studentNumber, clerkId,
// name, and email are deliberately excluded — those are identity fields
// tied to Clerk/verification, not editable profile data. Course and
// college aren't either: they follow from programCode (data/programs.js).
const EDITABLE_FIELDS = [
  // First and last name start from Clerk; the student confirms or corrects
  // them at sign-up (Microsoft sometimes splits a name wrongly).
  'firstName', 'lastName', 'middleName', 'nameSuffix',
  'programCode', 'yearLevel', 'section', 'gpa',
  'dateOfBirth', 'nationality', 'placeOfBirth', 'civilStatus',
  'homeAddress', 'cityMunicipality', 'province', 'zipCode', 'country',
  'telephoneNumber', 'mobileNumber',
  'fatherName', 'fatherContactNo', 'fatherDeceased', 'fatherAbsent', 'motherName', 'motherContactNo', 'motherDeceased', 'motherAbsent',
  'guardianType', 'guardianName', 'guardianRelationship', 'guardianAddress', 'guardianAddressSameAsHome', 'guardianContactNo',
];

// Academic fields per verification group (Student.verification).
const GROUP_FIELDS = {
  program: ['programCode'],
  enrollment: ['yearLevel', 'section'],
  gpa: ['gpa'],
};
const GROUP_LABELS = { program: 'Program', enrollment: 'Year level and section', gpa: 'GPA', personal: 'Personal details' };

// Identity details: the student can fill them in (and correct a name the
// university directory split wrongly) until they've confirmed them by
// saving a complete Personal details section; afterwards only the AdSO
// changes them, on a "personal" correction request.
const IDENTITY_FIELDS = ['firstName', 'lastName', 'middleName', 'nameSuffix', 'dateOfBirth', 'placeOfBirth', 'nationality', 'civilStatus'];
const PERSONAL_SECTION = ['firstName', 'lastName', 'middleName', 'dateOfBirth', 'placeOfBirth', 'nationality', 'civilStatus'];
const identityConfirmed = student => !!(student.identityConfirmedAt || student.profileConfirmedAt);

// Onboarding asks only for the core (utils/profileCompletion.js): student
// number, program, year level and GPA (not for 1st years, who have none
// yet). Everything else fills in later. Returns a message or null.
const CORE_LABELS = { programCode: 'program', yearLevel: 'year level', gpa: 'GPA' };
function missingCore(data) {
  const missing = CORE_FIELDS(data).filter(f => f !== 'studentNumber' && (data[f] === undefined || data[f] === null || data[f] === ''));
  return missing.length ? `Please fill in: ${missing.map(f => CORE_LABELS[f]).join(', ')}.` : null;
}

// The student as the portal gets it: the record plus its completion,
// computed now (never stored, so it can't go stale).
function withCompletion(student, extra = {}) {
  const plain = { ...(typeof student.toObject === 'function' ? student.toObject() : student), ...extra };
  return { ...plain, completion: computeProfileCompletion(plain) };
}

const TEXT_LIMIT = 200;
// Letters (any language), spaces, hyphens, apostrophes and periods.
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}\s.'’-]*$/u;

// Philippine mobile number -> 09XXXXXXXXX, or null if it isn't one.
// Accepts 09XXXXXXXXX, +639XXXXXXXXX or 639XXXXXXXXX, with spaces or dashes.
function normalizePhMobile(value) {
  const digits = String(value).replace(/[\s-]/g, '');
  const m = digits.match(/^(?:\+?63|0)(9\d{9})$/);
  return m ? `0${m[1]}` : null;
}

// Any contact number: a PH mobile is normalized; otherwise 7–15 digits
// with the usual punctuation (landlines, area codes) are kept as typed.
function normalizeContactNumber(value) {
  const mobile = normalizePhMobile(value);
  if (mobile) return mobile;
  const text = String(value).trim();
  const digitCount = text.replace(/\D/g, '').length;
  return /^[\d\s()+-]+$/.test(text) && digitCount >= 7 && digitCount <= 15 ? text : null;
}

function formatHomeAddress(s) {
  const line2 = [s.cityMunicipality, [s.province, s.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [s.homeAddress, line2, s.country].map(p => (p || '').trim()).filter(Boolean).join(', ');
}

// Parses/validates the subset of req.body fields that are safe to persist.
// Returns { data, error } — error is a user-facing message if validation fails.
function sanitizeProfileFields(body) {
  const data = {};

  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    data[field] = typeof body[field] === 'string' ? body[field].trim().slice(0, TEXT_LIMIT) : body[field];
  }

  if (data.programCode !== undefined) {
    if (!data.programCode) {
      data.programCode = undefined;
      data.course = undefined;
      data.college = undefined;
    } else {
      const program = findProgram(data.programCode);
      if (!program) return { error: 'Choose your program from the list.' };
      data.programCode = program.code;
      data.course = program.name;
      data.college = program.college;
    }
  }

  for (const f of ['firstName', 'middleName', 'lastName']) {
    if (data[f] === undefined) continue;
    if (typeof data[f] !== 'string') return { error: 'Names must be text.' };
    data[f] = data[f].replace(/\s+/g, ' ').slice(0, 60);
    if (data[f] && !NAME_PATTERN.test(data[f])) {
      return { error: 'Names can only have letters, spaces, hyphens, apostrophes and periods.' };
    }
  }

  if (data.yearLevel && !YEAR_LEVELS.includes(data.yearLevel)) {
    return { error: 'Choose your year level from the list.' };
  }

  if (data.gpa !== undefined && data.gpa !== '' && data.gpa !== null) {
    const parsed = Number(data.gpa);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 4) {
      return { error: 'GPA must be a number between 0.00 and 4.00.' };
    }
    data.gpa = Math.round(parsed * 100) / 100;
  } else if (data.gpa === '' || data.gpa === null) {
    data.gpa = undefined;
  }

  if (data.civilStatus && !Student.CIVIL_STATUS_OPTIONS.includes(data.civilStatus)) {
    return { error: 'Invalid civil status.' };
  }

  if (data.dateOfBirth) {
    const parsed = new Date(data.dateOfBirth);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'Invalid date of birth.' };
    }
    if (parsed.getTime() > Date.now()) {
      return { error: 'Date of birth can’t be in the future.' };
    }
    data.dateOfBirth = parsed;
  } else if (data.dateOfBirth === '') {
    data.dateOfBirth = undefined;
  }

  if (data.mobileNumber) {
    const mobile = normalizePhMobile(data.mobileNumber);
    if (!mobile) return { error: 'Enter a Philippine mobile number, e.g. 09171234567 or +639171234567.' };
    data.mobileNumber = mobile;
  }
  for (const [field, label] of [['telephoneNumber', 'telephone'], ['fatherContactNo', "father's contact"], ['motherContactNo', "mother's contact"], ['guardianContactNo', "guardian's contact"]]) {
    if (!data[field]) continue;
    const normalized = normalizeContactNumber(data[field]);
    if (!normalized) return { error: `Enter a valid ${label} number.` };
    data[field] = normalized;
  }

  const country = data.country ?? body.country;
  if (data.zipCode && (!country || country === 'Philippines') && !/^\d{4}$/.test(data.zipCode)) {
    return { error: 'ZIP code must be 4 digits.' };
  }

  if (data.guardianType !== undefined && data.guardianType !== '' && !Student.GUARDIAN_TYPES.includes(data.guardianType)) {
    return { error: 'Choose who your guardian is.' };
  }
  if (data.guardianType === '') data.guardianType = undefined;
  if (data.guardianAddressSameAsHome !== undefined) data.guardianAddressSameAsHome = data.guardianAddressSameAsHome === true;
  for (const who of ['father', 'mother']) {
    for (const f of [`${who}Deceased`, `${who}Absent`]) {
      if (data[f] !== undefined) data[f] = data[f] === true;
    }
    if (data[`${who}Deceased`]) data[`${who}Absent`] = false;
    if (data[`${who}Deceased`] || data[`${who}Absent`]) data[`${who}ContactNo`] = undefined;
    if (data[`${who}Absent`]) data[`${who}Name`] = undefined;
  }
  if (data.nameSuffix !== undefined && data.nameSuffix !== '' && !Student.NAME_SUFFIXES.includes(data.nameSuffix)) {
    return { error: 'Choose a name suffix from the list.' };
  }
  if (data.nameSuffix === '') data.nameSuffix = undefined;
  if ((data.guardianType === 'father' && (data.fatherDeceased || data.fatherAbsent))
    || (data.guardianType === 'mother' && (data.motherDeceased || data.motherAbsent))) {
    return { error: 'That parent can’t be your guardian. Choose another guardian.' };
  }

  return { data };
}

// After an update: a guardian who is the father or mother mirrors that
// parent, and "same as my home address" mirrors the home address, so the
// application forms (which read guardianName etc.) see the right values.
function applyGuardianLinks(student) {
  if (student.guardianType === 'father' || student.guardianType === 'mother') {
    const isFather = student.guardianType === 'father';
    student.guardianName = isFather ? student.fatherName : student.motherName;
    student.guardianRelationship = isFather ? 'Father' : 'Mother';
    student.guardianContactNo = (isFather ? student.fatherContactNo : student.motherContactNo) || student.guardianContactNo;
    student.guardianAddress = formatHomeAddress(student) || undefined;
    student.guardianAddressSameAsHome = true;
  } else if (student.guardianAddressSameAsHome) {
    student.guardianAddress = formatHomeAddress(student) || undefined;
  }
}

// Changes to a verified group are refused; the student requests a
// correction instead. Returns an error message or null.
function verifiedChangeError(student, data) {
  for (const [group, fields] of Object.entries(GROUP_FIELDS)) {
    if (!student.verification?.[group]?.verifiedAt) continue;
    const changed = fields.some(f => {
      if (data[f] === undefined && !(f in data)) return false;
      const before = student[f] ?? '';
      const after = data[f] ?? '';
      return f === 'gpa' ? Number(before || 0) !== Number(after || 0) : String(before).toLowerCase() !== String(after).toLowerCase();
    });
    if (changed) return `${GROUP_LABELS[group]} has been verified by the office and can’t be changed here. Request a correction instead.`;
  }
  return null;
}

// Words that belong to the surname after them ("dela Cruz", "San Jose").
const SURNAME_PARTICLES = new Set(['de', 'del', 'dela', 'delas', 'delos', 'di', 'da', 'du', 'la', 'las', 'los', 'san', 'santa', 'sta', 'sta.', 'sto', 'sto.', 'van', 'von', 'mac', 'mc']);

// The DLSU-D Microsoft directory sends only the first word as the first
// name and the other given names with the surname ("JUAN" + "MIGUEL
// DELA CRUZ"). The username starts with the surname's initial (dja1234 =
// Dela Cruz, Juan, …), so the surname is the shortest ending of the last
// name that starts with that letter, with any particle before it. Left
// unchanged when that doesn't fit (first name already several words, a
// one-word last name, no match). Mirrors splitDirectoryName in the
// frontend's utils/names.ts.
function splitDirectoryName(first, last, email) {
  const f = (first || '').trim().replace(/\s+/g, ' ');
  const l = (last || '').trim().replace(/\s+/g, ' ');
  const initial = (email || '').trim().charAt(0).toLowerCase();
  const words = l.split(' ').filter(Boolean);
  if (!f || f.includes(' ') || words.length < 2 || !/[a-z]/.test(initial)) return { firstName: f, lastName: l };
  for (let i = words.length - 1; i >= 1; i--) {
    if (words[i].charAt(0).toLowerCase() !== initial) continue;
    let start = i;
    while (start > 1 && SURNAME_PARTICLES.has(words[start - 1].toLowerCase())) start--;
    return { firstName: [f, ...words.slice(0, start)].join(' '), lastName: words.slice(start).join(' ') };
  }
  return { firstName: f, lastName: l };
}

// First and last name from Clerk (the Microsoft directory), re-split as
// above. Only a fallback: the student confirms their name at sign-up.
function nameParts(clerkUser) {
  const email = clerkUser.emailAddresses?.find(e => e.id === clerkUser.primaryEmailAddressId)?.emailAddress
    || clerkUser.emailAddresses?.[0]?.emailAddress || '';
  const { firstName, lastName } = splitDirectoryName(clerkUser.firstName, clerkUser.lastName, email);
  return { firstName: firstName || undefined, lastName: lastName || undefined };
}

function fullName({ firstName, middleName, lastName, nameSuffix }) {
  return [firstName, middleName, lastName, nameSuffix].map(p => (p || '').trim()).filter(Boolean).join(' ');
}

// Identity details a student tries to change after sign-up. Returns a
// message or null.
function lockedChangeError(student, data) {
  const same = (f, before, after) => {
    if (f === 'dateOfBirth') return (before ? new Date(before).toISOString().slice(0, 10) : '') === (after ? new Date(after).toISOString().slice(0, 10) : '');
    return String(before ?? '').trim().toLowerCase() === String(after ?? '').trim().toLowerCase();
  };
  // Filling in a detail that was never set is always allowed. The program
  // is set at onboarding; identity details once the student confirmed them.
  const locked = ['programCode', ...(identityConfirmed(student) ? IDENTITY_FIELDS : [])];
  const changed = locked.filter(f => f in data && String(student[f] ?? '').trim() && !same(f, student[f], data[f]));
  if (!changed.length) return null;
  return 'Your name, birth details, nationality, civil status and program can only be changed by the Admissions and Scholarship Office. Use “Request a change” on your Profile.';
}

// GET /api/students/me
// Returns the Student record linked to the caller's Clerk account, or 404
// if they've signed in with Clerk but never completed their academic
// profile (studentNumber/course/etc) — the frontend uses that 404 to
// route to the "complete your profile" page.
//
// Uses getAuth() + a manual 401 check instead of requireAuth(): per
// Clerk's own docs, requireAuth() is meant for full-stack apps and
// redirects unauthenticated requests to the homepage/sign-in page rather
// than returning a normal HTTP status — which is exactly wrong for a JSON
// API route (a failed fetch() would silently follow that redirect and
// receive the wrong body instead of an error you can check for).
router.get('/me', async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const student = await findLinkedStudent(userId, () => Student.findOne({ clerkId: userId }));
    if (!student) {
      return res.status(404).json({ error: 'Profile not yet completed.' });
    }
    // Records created before name parts were stored: answer with Clerk's
    // first/last name (not saved; the backfill script does that).
    if (!student.firstName && !student.lastName) {
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        return res.json({ student: withCompletion(student, nameParts(clerkUser)) });
      } catch (clerkErr) {
        console.error('Name lookup skipped:', clerkErr);
      }
    }
    res.json({ student: withCompletion(student) });
  } catch (err) {
    console.error('Fetch profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

// GET /api/students/me/holdings — scholarships the signed-in student holds
// now, whether one of them rules out applying for others (SFAG), and the
// scholarships whose slots for the student's college are full (POLCA):
// { held, exclusive, slotsFull: [{ scholarshipId, message }], details }.
// details: per held scholarship, the approved application behind it
// (reference, approval date, SFAG grant percentage) for My Scholarship.
router.get('/me/holdings', requireStudent, async (req, res) => {
  try {
    const held = await findHeldScholarships(req.studentNumber);
    const exclusive = held.find(s => s.scholarshipId === EXCLUSIVE_SCHOLARSHIP_ID) ?? null;
    const slotsFull = [];
    // Slot limits come from the code or the office's saved ones
    // (utils/collegeSlots.js), so every scholarship is checked.
    for (const scholarship of allScholarships()) {
      if (held.some(h => h.scholarshipId === scholarship.id)) continue;
      const full = await scholarSlotsFull(scholarship, req.studentNumber);
      if (full) slotsFull.push({ scholarshipId: scholarship.id, message: full.message });
    }
    const apps = await Application.find({ studentNumber: req.studentNumber, status: 'Approved', endedAt: null, scholarshipId: { $in: held.map(h => h.scholarshipId) } })
      .select('scholarshipId referenceCode reviewedAt createdAt sfagPercentage office').sort({ reviewedAt: -1, createdAt: -1 }).lean();
    const details = held.map(h => {
      const a = apps.find(x => x.scholarshipId === h.scholarshipId);
      return { scholarshipId: h.scholarshipId, applicationId: a ? String(a._id) : null, referenceCode: a?.referenceCode ?? null, approvedAt: a?.reviewedAt ?? a?.createdAt ?? null, grantPercentage: a?.sfagPercentage ?? null };
    });
    res.json({ held, exclusive, slotsFull, details });
  } catch (err) {
    console.error('Fetch holdings error:', err);
    res.status(500).json({ error: 'Failed to load your scholarships.' });
  }
});

// POST /api/students/me/holdings/choose  { keepScholarshipId }
// Two (or more) scholarships approved at once: only one internally funded
// scholarship can be credited, so the student keeps one. The others' approved
// applications end as 'Declined' (by the student), which frees their slots,
// and the AdSO gets a message about it.
router.post('/me/holdings/choose', requireStudent, async (req, res) => {
  try {
    const keep = typeof req.body?.keepScholarshipId === 'string' ? req.body.keepScholarshipId : '';
    const held = await findHeldScholarships(req.studentNumber);
    if (held.length < 2) return res.status(409).json({ error: 'You only hold one scholarship, so there’s nothing to choose.' });
    const kept = held.find(h => h.scholarshipId === keep);
    if (!kept) return res.status(400).json({ error: 'Choose one of the scholarships you were approved for.' });
    const declined = held.filter(h => h.scholarshipId !== keep);
    const now = new Date();
    await Application.updateMany(
      { studentNumber: req.studentNumber, status: 'Approved', endedAt: null, scholarshipId: { $in: declined.map(d => d.scholarshipId) } },
      { $set: { endedAt: now, endReason: 'Declined', endedBy: 'student' } }
    );
    const student = await Student.findOne({ studentNumber: req.studentNumber }).select('studentNumber email name').lean();
    await Message.create({
      studentNumber: req.studentNumber, from: 'student', authorEmail: student?.email, authorName: student?.name,
      body: `I was approved for more than one scholarship. I’m keeping the ${kept.scholarshipName} and declining the ${declined.map(d => d.scholarshipName).join(' and the ')}.`,
    }).catch(err => console.error('Choice message failed:', err));
    res.json({ kept: kept.scholarshipId, declined: declined.map(d => d.scholarshipId) });
  } catch (err) {
    console.error('Choose scholarship error:', err);
    res.status(500).json({ error: 'Failed to save your choice.' });
  }
});

// POST /api/students/complete-profile
// Called once, right after a brand-new Clerk account signs in for the
// first time. Clerk owns identity/credentials; this attaches the academic,
// personal, contact, and parent/guardian fields Clerk has no concept of.
router.post('/complete-profile', async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const existing = await findLinkedStudent(userId, () => Student.findOne({ clerkId: userId }));
    if (existing) {
      return res.status(409).json({ error: 'Profile already completed.' });
    }

    // Re-verify the email domain server-side — the frontend check is only
    // a UX nicety and isn't trustworthy on its own. This asks Clerk itself
    // for the verified primary email rather than trusting anything in
    // req.body.
    const clerkUser = await clerkClient.users.getUser(userId);
    const primary = clerkUser.emailAddresses.find(e => e.id === clerkUser.primaryEmailAddressId);
    const primaryEmail = primary?.emailAddress;

    if (!primaryEmail || !primaryEmail.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return res.status(403).json({ error: 'Please use your official university email.' });
    }
    if (primary.verification?.status !== 'verified') {
      return res.status(403).json({ error: 'Verify your university email first.' });
    }

    if (!req.body.studentNumber) {
      return res.status(400).json({ error: 'Student number is required.' });
    }
    // Also rejects non-strings, so the value is safe to use in a query.
    if (!validStudentNumber(req.body.studentNumber)) {
      return res.status(400).json({ error: 'Student numbers have 9 digits and start with the year you entered, like 202312345.' });
    }
    const studentNumber = req.body.studentNumber.trim();

    const duplicate = await Student.findOne({ studentNumber });
    if (duplicate) {
      return res.status(409).json({ error: 'This student number is already linked to another account.' });
    }

    // An office can add a scholar before they sign up (the SDO's tryouts):
    // their approved application already sits under this student number,
    // with the email the office entered. Only that person may claim the
    // number, so someone who merely knows it can't take over their record.
    const waiting = await Application.find({ studentNumber }).select('standardInfo.email').lean();
    if (waiting.length) {
      const emails = new Set(waiting.map(a => a.standardInfo?.email?.trim().toLowerCase()).filter(Boolean));
      if (!emails.has(primaryEmail.toLowerCase())) {
        console.warn(`Blocked claiming student number ${studentNumber}: it has records under a different email.`);
        return res.status(409).json({ error: 'This student number already has scholarship records under a different DLSU-D email. Sign in with that email, or message the Admissions and Scholarship Office.' });
      }
    }

    const { data, error } = sanitizeProfileFields(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    // An older page that doesn't send names: use Clerk's.
    const fromClerk = nameParts(clerkUser);
    if (data.firstName === undefined) data.firstName = fromClerk.firstName;
    if (data.lastName === undefined) data.lastName = fromClerk.lastName;
    // Only the core is required here; the rest of the profile fills in
    // later (Profile page, or saved from an application).
    const missing = missingCore(data);
    if (missing) return res.status(400).json({ error: missing });

    const names = {
      firstName: data.firstName,
      lastName: data.lastName,
      middleName: data.middleName || undefined,
      nameSuffix: data.nameSuffix,
    };
    const student = new Student({
      clerkId: userId,
      studentNumber,
      ...names,
      name: fullName(names) || 'Student',
      email: primaryEmail.toLowerCase(),
      avatarUrl: clerkUser.imageUrl || undefined,
      ...data,
    });
    applyGuardianLinks(student);
    await student.save();

    res.status(201).json({ student: withCompletion(student) });
  } catch (err) {
    console.error('Complete profile error:', err);
    res.status(500).json({ error: 'Failed to save profile.' });
  }
});

// PATCH /api/students/me
// Lets a student edit their own profile after onboarding (personal,
// contact, and parent/guardian sections). studentNumber/clerkId/name/email
// are never touched here — those stay tied to Clerk/verification.
router.patch('/me', async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const student = await findLinkedStudent(userId, () => Student.findOne({ clerkId: userId }));
    if (!student) {
      return res.status(404).json({ error: 'Complete your profile first.' });
    }

    const { data, error } = sanitizeProfileFields(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    const lockedError = verifiedChangeError(student, data) || lockedChangeError(student, data);
    if (lockedError) {
      return res.status(409).json({ error: lockedError });
    }

    // Partial updates: only the fields sent are validated and saved.
    Object.assign(student, data);
    if (['firstName', 'middleName', 'lastName', 'nameSuffix'].some(f => f in data)) {
      student.name = fullName(student) || student.name;
    }
    applyGuardianLinks(student);
    // A complete Personal details section confirms the student's identity
    // details; from then on only the AdSO changes them.
    if (!identityConfirmed(student) && PERSONAL_SECTION.every(f => student[f] !== undefined && student[f] !== null && String(student[f]).trim() !== '')) {
      student.identityConfirmedAt = new Date();
    }

    // Keep the avatar synced with whatever Clerk/Microsoft currently has
    // on file — a no-op fetch cost if it hasn't changed, but means a
    // student who updates their Microsoft photo doesn't need a fresh
    // sign-up to see it reflected here.
    try {
      const clerkUser = await clerkClient.users.getUser(userId);
      if (clerkUser.imageUrl) student.avatarUrl = clerkUser.imageUrl;
    } catch (syncErr) {
      console.error('Avatar sync skipped:', syncErr);
      // Not fatal — proceed with the save using whatever avatarUrl is
      // already on the record.
    }

    await student.save();

    res.json({ student: withCompletion(student) });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// POST /api/students/me/correction-requests  { group, message }
// A student asks the office to correct a verified group of academic
// details (they can't edit it themselves). The office's queue for these
// is a follow-up (see HANDOFF.md).
router.post('/me/correction-requests', async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
    const student = await findLinkedStudent(userId, () => Student.findOne({ clerkId: userId }));
    if (!student) return res.status(404).json({ error: 'Complete your profile first.' });

    const group = req.body?.group;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!GROUP_LABELS[group]) return res.status(400).json({ error: 'Choose what needs correcting.' });
    if (!message) return res.status(400).json({ error: 'Tell the office what should be corrected.' });
    if (message.length > 1000) return res.status(400).json({ error: 'Keep the request under 1000 characters.' });
    if (student.correctionRequests.some(r => r.group === group && r.status === 'open')) {
      return res.status(409).json({ error: 'You already have an open request for this. The office will get back to you.' });
    }

    student.correctionRequests.push({ group, message });
    await student.save();
    // Also a message in the student's conversation, so the AdSO sees it in
    // Messages and can reply there.
    await Message.create({
      studentNumber: student.studentNumber, from: 'student', authorEmail: student.email, authorName: student.name,
      body: `Correction request (${GROUP_LABELS[group]}):\n${message}`,
    }).catch(err => console.error('Correction request message failed:', err));
    res.status(201).json({ student: withCompletion(student) });
  } catch (err) {
    console.error('Correction request error:', err);
    res.status(500).json({ error: 'Failed to send the request.' });
  }
});

// GET /api/students — AdSO only: every student who finished setting up a
// profile, with how many applications they've submitted, so the office can
// see who signed up but hasn't applied yet. Only the profile details the
// student gave at sign-up; no activity tracking.
router.get('/', requireAdso, async (req, res) => {
  try {
    const [students, counts] = await Promise.all([
      Student.find({})
        .select('studentNumber firstName middleName lastName name email avatarUrl programCode course college yearLevel createdAt')
        .sort({ createdAt: -1 })
        .lean(),
      Application.aggregate([{ $group: { _id: '$studentNumber', n: { $sum: 1 }, last: { $max: '$createdAt' } } }]),
    ]);
    const byStudent = new Map(counts.map(c => [c._id, c]));
    res.json({
      students: students.map(s => ({
        studentNumber: s.studentNumber,
        firstName: s.firstName ?? null,
        middleName: s.middleName ?? null,
        lastName: s.lastName ?? null,
        name: s.name ?? null,
        email: s.email ?? null,
        avatarUrl: s.avatarUrl ?? null,
        programCode: s.programCode ?? null,
        course: s.course ?? null,
        college: s.college ?? null,
        yearLevel: s.yearLevel ?? null,
        joinedAt: s.createdAt ?? null,
        applications: byStudent.get(s.studentNumber)?.n ?? 0,
        lastAppliedAt: byStudent.get(s.studentNumber)?.last ?? null,
      })),
    });
  } catch (err) {
    console.error('Student list error:', err);
    res.status(500).json({ error: 'Failed to load the students.' });
  }
});

// PATCH /api/students/:studentNumber/verification  { group, verified }
// AdSO only: marks a group of a student's academic details as verified
// (locking it from student edits) or back to self-reported. Verifying
// resolves any open correction request for that group.
// GET /api/students/:studentNumber/profile — AdSO only: the full profile
// (with open correction requests), for editing it on a student's request.
router.get('/:studentNumber/profile', requireAdso, async (req, res) => {
  try {
    const student = await Student.findOne({ studentNumber: String(req.params.studentNumber) }).lean();
    if (!student) return res.status(404).json({ error: 'This student hasn’t set up a profile yet.' });
    res.json({ student });
  } catch (err) {
    console.error('Admin profile load error:', err);
    res.status(500).json({ error: 'Failed to load the profile.' });
  }
});

// PATCH /api/students/:studentNumber/profile — AdSO only: edits a student's
// profile, including the details students can't change after sign-up
// (name parts, birth details, program, …). Resolves open correction
// requests for what was changed.
router.patch('/:studentNumber/profile', requireAdso, async (req, res) => {
  try {
    const student = await Student.findOne({ studentNumber: req.params.studentNumber });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const { data, error } = sanitizeProfileFields(req.body);
    if (error) return res.status(400).json({ error });
    // Partial updates: only the fields sent are validated and saved.
    Object.assign(student, data);
    if (['firstName', 'middleName', 'lastName', 'nameSuffix'].some(f => f in data)) {
      student.name = fullName(student) || student.name;
    }
    applyGuardianLinks(student);
    // A complete Personal details section confirms the student's identity
    // details; from then on only the AdSO changes them.
    if (!identityConfirmed(student) && PERSONAL_SECTION.every(f => student[f] !== undefined && student[f] !== null && String(student[f]).trim() !== '')) {
      student.identityConfirmedAt = new Date();
    }
    if (student.firstName || student.lastName) student.name = fullName(student) || student.name;
    const now = new Date();
    for (const r of student.correctionRequests) {
      if (r.status === 'open') { r.status = 'resolved'; r.resolvedAt = now; r.resolvedBy = req.adminUser.email; }
    }
    await student.save();
    res.json({ student });
  } catch (err) {
    console.error('Admin profile update error:', err);
    res.status(500).json({ error: 'Failed to update the profile.' });
  }
});

router.patch('/:studentNumber/verification', requireAdso, async (req, res) => {
  try {
    const { group, verified } = req.body || {};
    if (!GROUP_FIELDS[group]) return res.status(400).json({ error: `Group must be one of: ${Object.keys(GROUP_FIELDS).join(', ')}.` });
    const student = await Student.findOne({ studentNumber: req.params.studentNumber });
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    if (verified === true) {
      student.set(`verification.${group}`, {
        verifiedAt: new Date(),
        verifiedBy: req.adminUser.email,
        verifiedByName: req.adminUser.name,
        office: req.adminUser.office,
      });
      for (const r of student.correctionRequests) {
        if (r.group === group && r.status === 'open') {
          r.status = 'resolved';
          r.resolvedAt = new Date();
          r.resolvedBy = req.adminUser.email;
        }
      }
    } else {
      student.set(`verification.${group}`, undefined);
    }
    await student.save();
    res.json({ student });
  } catch (err) {
    console.error('Verification update error:', err);
    res.status(500).json({ error: 'Failed to update verification.' });
  }
});

module.exports = router;
module.exports.normalizePhMobile = normalizePhMobile;