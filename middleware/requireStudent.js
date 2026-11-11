const { getAuth } = require('@clerk/express');
const Student = require('../models/Student');
const { findLinkedStudent } = require('../utils/studentLink');
const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const { requireAdmin } = require('./requireAdmin');
const { findHeldScholarships } = require('../utils/exclusivity');

// The Student Financial Aid Grant (SFAG) — the only scholarship with duty
// hours.
const SFAG_ID = 's1';

// Resolves the signed-in scholar from their Clerk session (never from the
// request body) and sets req.studentNumber. 401 when signed out, 404 when
// the account has no completed profile yet.
async function requireStudent(req, res, next) {
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
    const student = await findLinkedStudent(userId, () => Student.findOne({ clerkId: userId }).select('studentNumber').lean());
    if (!student) return res.status(404).json({ error: 'Complete your profile first.' });
    req.studentNumber = student.studentNumber;
    next();
  } catch (err) {
    console.error('Student lookup failed:', err);
    res.status(500).json({ error: 'Failed to verify your account.' });
  }
}

// Scholars only: a student with at least one approved application. Used
// for features non-scholars don't get (renewals, duty hours). Runs
// requireStudent first.
const requireScholar = [requireStudent, async (req, res, next) => {
  try {
    if (!(await Application.exists({ studentNumber: req.studentNumber, status: 'Approved' }))) {
      return res.status(403).json({ error: 'This is only for scholars with an approved scholarship.' });
    }
    next();
  } catch (err) {
    console.error('Scholar check failed:', err);
    res.status(500).json({ error: 'Failed to verify your scholarship.' });
  }
}];

// SFAG scholars only (duty hours): approved for the SFAG, or renewed on it,
// at any time — so a past grantee can still open their old logs. Runs
// requireStudent first.
const requireSfagScholar = [requireStudent, async (req, res, next) => {
  try {
    const [approved, renewed] = await Promise.all([
      Application.exists({ studentNumber: req.studentNumber, scholarshipId: SFAG_ID, status: 'Approved' }),
      Renewal.exists({ studentNumber: req.studentNumber, scholarshipId: SFAG_ID, status: 'Renewed' }),
    ]);
    if (!approved && !renewed) {
      return res.status(403).json({ error: 'Duty hours are only for Student Financial Aid Grant (SFAG) scholars.' });
    }
    next();
  } catch (err) {
    console.error('SFAG check failed:', err);
    res.status(500).json({ error: 'Failed to verify your scholarship.' });
  }
}];

// A student (sets req.studentNumber) or an admin (sets req.adminUser), for
// routes both use; the route then checks the record is theirs. Admin
// accounts have no Student record.
// Holds the SFAG *now*: approved, not ended (graduated, stopped or declined
// for another scholarship) and not left unrenewed. requireSfagScholar above
// is "was ever an SFAG scholar", enough to read past duty hours; logging
// duties and claiming events needs this.
const requireCurrentSfagScholar = [requireStudent, async (req, res, next) => {
  try {
    const held = await findHeldScholarships(req.studentNumber);
    if (!held.some(s => s.scholarshipId === SFAG_ID)) {
      return res.status(403).json({ error: 'You no longer hold the Student Financial Aid Grant (SFAG), so you can’t log duty hours.' });
    }
    next();
  } catch (err) {
    console.error('Current SFAG check failed:', err);
    res.status(500).json({ error: 'Failed to verify your scholarship.' });
  }
}];

async function requireStudentOrAdmin(req, res, next) {
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
    const student = await findLinkedStudent(userId, () => Student.findOne({ clerkId: userId }).select('studentNumber').lean());
    if (student) {
      req.studentNumber = student.studentNumber;
      return next();
    }
    return requireAdmin(req, res, next);
  } catch (err) {
    console.error('Account lookup failed:', err);
    res.status(500).json({ error: 'Failed to verify your account.' });
  }
}

module.exports = { requireStudent, requireScholar, requireSfagScholar, requireCurrentSfagScholar, requireStudentOrAdmin, SFAG_ID };
