const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Student = require('../models/Student');

// --- REGISTER ---
// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { studentNumber, name, course, college, yearLevel, email, password, gpa } = req.body;

    if (!studentNumber || !name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    if (!email.endsWith('@dlsud.edu.ph')) {
      return res.status(400).json({ error: 'Please use your official university email.' });
    }

    // Check if student already exists (by email or student number)
    const existing = await Student.findOne({ $or: [{ email }, { studentNumber }] });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email or student number already exists.' });
    }

    // Hash the password before storing — never store plain text
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const student = await Student.create({
      studentNumber,
      name,
      course,
      college,
      yearLevel,
      email: email.toLowerCase().trim(),
      passwordHash,
      gpa,
    });

    const token = jwt.sign(
      { studentId: student._id, email: student.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Account created successfully.',
      token,
      student: {
        id: student._id,
        studentNumber: student.studentNumber,
        name: student.name,
        email: student.email,
        course: student.course,
        college: student.college,
        yearLevel: student.yearLevel,
        gpa: student.gpa,
        profilePicture: student.profilePicture,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong creating the account.' });
  }
});

// --- LOGIN ---
// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Please fill in all fields.' });
    }

    if (!email.endsWith('@dlsud.edu.ph')) {
      return res.status(400).json({ error: 'Please use your official university email.' });
    }

    const student = await Student.findOne({ email: email.toLowerCase().trim() });
    if (!student) {
      // Same generic message as wrong password below — don't reveal which part was wrong
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, student.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { studentId: student._id, email: student.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful.',
      token,
      student: {
        id: student._id,
        studentNumber: student.studentNumber,
        name: student.name,
        email: student.email,
        course: student.course,
        college: student.college,
        yearLevel: student.yearLevel,
        gpa: student.gpa,
        profilePicture: student.profilePicture,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

module.exports = router;