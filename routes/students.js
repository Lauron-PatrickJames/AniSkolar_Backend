const express = require('express');
const router = express.Router();
const { getAuth, clerkClient } = require('@clerk/express');
const Student = require('../models/Student');

const ALLOWED_EMAIL_DOMAIN = '@dlsud.edu.ph';

// Fields a student is allowed to set themselves. studentNumber, clerkId,
// name, and email are deliberately excluded — those are identity fields
// tied to Clerk/verification, not editable profile data.
const EDITABLE_FIELDS = [
  // The middle name is the student's to enter; first/last come from Clerk.
  'middleName',
  'course', 'college', 'yearLevel', 'gpa',
  'programCode', 'section', 'dateOfBirth', 'nationality', 'placeOfBirth', 'civilStatus',
  'homeAddress', 'cityMunicipality', 'province', 'zipCode', 'country',
  'telephoneNumber', 'mobileNumber',
  'fatherName', 'motherName', 'guardianName', 'guardianRelationship',
  'guardianAddress', 'guardianContactNo',
];

// Parses/validates the subset of req.body fields that are safe to persist.
// Returns { data, error } — error is a user-facing message if validation fails.
function sanitizeProfileFields(body) {
  const data = {};

  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    data[field] = body[field];
  }

  if (data.gpa !== undefined && data.gpa !== '' && data.gpa !== null) {
    const parsed = Number(data.gpa);
    if (Number.isNaN(parsed) || parsed < 1.0 || parsed > 5.0) {
      return { error: 'GPA must be a number between 1.0 and 5.0.' };
    }
    data.gpa = parsed;
  } else if (data.gpa === '') {
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
    data.dateOfBirth = parsed;
  }

  return { data };
}

// First and last name exactly as Clerk has them. Never split a full-name
// string: "Patrick James" + "Lauron" must not become "Patrick" + "James Lauron".
function nameParts(clerkUser) {
  return {
    firstName: (clerkUser.firstName || '').trim() || undefined,
    lastName: (clerkUser.lastName || '').trim() || undefined,
  };
}

function fullName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName].map(p => (p || '').trim()).filter(Boolean).join(' ');
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

    const student = await Student.findOne({ clerkId: userId });
    if (!student) {
      return res.status(404).json({ error: 'Profile not yet completed.' });
    }
    // Records created before name parts were stored: answer with Clerk's
    // first/last name (not saved; the backfill script does that).
    if (!student.firstName && !student.lastName) {
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        return res.json({ student: { ...student.toObject(), ...nameParts(clerkUser) } });
      } catch (clerkErr) {
        console.error('Name lookup skipped:', clerkErr);
      }
    }
    res.json({ student });
  } catch (err) {
    console.error('Fetch profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile.' });
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

    const existing = await Student.findOne({ clerkId: userId });
    if (existing) {
      return res.status(409).json({ error: 'Profile already completed.' });
    }

    // Re-verify the email domain server-side — the frontend check is only
    // a UX nicety and isn't trustworthy on its own. This asks Clerk itself
    // for the verified primary email rather than trusting anything in
    // req.body.
    const clerkUser = await clerkClient.users.getUser(userId);
    const primaryEmail = clerkUser.emailAddresses.find(
      e => e.id === clerkUser.primaryEmailAddressId
    )?.emailAddress;

    if (!primaryEmail || !primaryEmail.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return res.status(403).json({ error: 'Please use your official university email.' });
    }

    const { studentNumber } = req.body;
    if (!studentNumber || !String(studentNumber).trim()) {
      return res.status(400).json({ error: 'Student number is required.' });
    }

    const duplicate = await Student.findOne({ studentNumber });
    if (duplicate) {
      return res.status(409).json({ error: 'This student number is already linked to another account.' });
    }

    const { data, error } = sanitizeProfileFields(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    const names = { ...nameParts(clerkUser), middleName: data.middleName || undefined };
    const student = await Student.create({
      clerkId: userId,
      studentNumber,
      ...names,
      name: fullName(names) || 'Student',
      email: primaryEmail.toLowerCase(),
      avatarUrl: clerkUser.imageUrl || undefined,
      ...data,
    });

    res.status(201).json({ student });
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

    const student = await Student.findOne({ clerkId: userId });
    if (!student) {
      return res.status(404).json({ error: 'Complete your profile first.' });
    }

    const { data, error } = sanitizeProfileFields(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    Object.assign(student, data);
    // A changed middle name updates the full name, as long as the record
    // has its first/last parts (older records keep their name until backfilled).
    if (data.middleName !== undefined && (student.firstName || student.lastName)) {
      student.name = fullName(student) || student.name;
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

    res.json({ student });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

module.exports = router;