const express = require('express');
const router = express.Router();
const upload = require('../middleware/uploadConfig');
const uploadRequirement = require('../middleware/uploadRequirementConfig');
const Student = require('../models/Student');
const multer = require('multer');

router.post('/profile-picture/:studentId', (req, res) => {
  const singleUpload = upload.single('profilePicture');

  singleUpload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 10MB size limit.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }

    try {
      const student = await Student.findByIdAndUpdate(
        req.params.studentId,
        {
          profilePicture: {
            filename: req.file.filename,
            path: `/uploads/profile-pics/${req.file.filename}`,
            mimetype: req.file.mimetype,
            size: req.file.size,
            uploadedAt: new Date(),
          },
        },
        { new: true }
      );

      if (!student) return res.status(404).json({ error: 'Student not found.' });

      res.json({
        message: 'Profile picture uploaded successfully.',
        profilePicture: student.profilePicture,
      });
    } catch (dbErr) {
      res.status(500).json({ error: 'Failed to save file reference.' });
    }
  });
});

router.post('/requirement/:studentId', (req, res) => {
  const singleUpload = uploadRequirement.single('requirementFile');

  singleUpload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 10MB size limit.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }

    try {
      const student = await Student.findByIdAndUpdate(
        req.params.studentId,
        {
          $push: {
            fileRequirements: {
              label: req.body.label || 'Unlabeled requirement',
              filename: req.file.filename,
              path: `/uploads/requirements/${req.file.filename}`,
              mimetype: req.file.mimetype,
              size: req.file.size,
              uploadedAt: new Date(),
            },
          },
        },
        { new: true }
      );

      if (!student) return res.status(404).json({ error: 'Student not found.' });

      res.json({
        message: 'Requirement uploaded successfully.',
        fileRequirements: student.fileRequirements,
      });
    } catch (dbErr) {
      res.status(500).json({ error: 'Failed to save file reference.' });
    }
  });
});

module.exports = router;