const express = require('express');
const router = express.Router();
const multer = require('multer');
const { applicationUpload } = require('../middleware/uploadConfig');
const Application = require('../models/Application');

// Accept up to 8 files under the same field name "documents", plus a
// parallel JSON array "documentLabels" telling us which requirement
// each file corresponds to (e.g. ["Application Letter", "Indigency", ...]).
// This matches your frontend's dynamic scholarship.requirements list
// instead of hardcoding fixed field names.
const uploadDocs = applicationUpload.array('documents', 8);

router.post('/', (req, res) => {
  uploadDocs(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Each file must be under 10MB.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const {
        studentNumber,
        scholarshipId,
        scholarshipName,
        applicationFormType,
        standardInfo,
        personalInfo,
        contactSchool,
        parentsGuardian,
        siblings,
        assetsExpenses,
        agreement,
        documentLabels,
      } = req.body;

      if (!studentNumber || !scholarshipId) {
        return res.status(400).json({ error: 'Missing student number or scholarship reference.' });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Please upload all required documents.' });
      }

      let labels;
      try {
        labels = JSON.parse(documentLabels || '[]');
      } catch {
        return res.status(400).json({ error: 'Invalid document labels format.' });
      }

      if (labels.length !== req.files.length) {
        return res.status(400).json({ error: 'Document count does not match label count.' });
      }

      const documents = req.files.map((file, idx) => ({
        docType: labels[idx],
        filename: file.filename,
        path: `/uploads/application-docs/${file.filename}`,
        mimetype: file.mimetype,
        size: file.size,
      }));

      const applicationData = {
        studentNumber,
        scholarshipId,
        scholarshipName,
        applicationFormType: applicationFormType || 'standard',
        documents,
        referenceCode: `DLSU-D-SFAO-${Math.floor(Math.random() * 900000 + 100000)}`,
      };

      if (applicationFormType === 'sfag') {
        if (!personalInfo || !contactSchool || !parentsGuardian || !assetsExpenses || !agreement) {
          return res.status(400).json({ error: 'Missing required SFAG form sections.' });
        }
        applicationData.personalInfo = JSON.parse(personalInfo);
        applicationData.contactSchool = JSON.parse(contactSchool);
        applicationData.parentsGuardian = JSON.parse(parentsGuardian);
        applicationData.siblings = siblings ? JSON.parse(siblings) : [];
        applicationData.assetsExpenses = JSON.parse(assetsExpenses);
        applicationData.agreement = JSON.parse(agreement);
      } else {
        if (!standardInfo) {
          return res.status(400).json({ error: 'Missing personal/academic profile.' });
        }
        applicationData.standardInfo = JSON.parse(standardInfo);
      }

      const application = await Application.create(applicationData);

      res.status(201).json({
        message: 'Application submitted successfully.',
        application,
      });
    } catch (err) {
      console.error('Application submit error:', err);
      res.status(500).json({ error: 'Failed to save application. Please check your submitted data.' });
    }
  });
});

// GET a student's applications, by student number
router.get('/student/:studentNumber', async (req, res) => {
  try {
    const applications = await Application.find({ studentNumber: req.params.studentNumber }).sort({ createdAt: -1 });
    res.json({ applications });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications.' });
  }
});

module.exports = router;