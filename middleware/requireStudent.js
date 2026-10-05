const { getAuth } = require('@clerk/express');
const Student = require('../models/Student');
const Application = require('../models/Application');

// Resolves the signed-in scholar from their Clerk session (never from the
// request body) and sets req.studentNumber. 401 when signed out, 404 when
// the account has no completed profile yet.
async function requireStudent(req, res, next) {
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
    const student = await Student.findOne({ clerkId: userId }).select('studentNumber').lean();
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

module.exports = { requireStudent, requireScholar };
