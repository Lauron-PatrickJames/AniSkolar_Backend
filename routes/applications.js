const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Readable } = require('stream');
const { ObjectId } = require('mongodb');
const { applicationUpload } = require('../middleware/uploadConfig');
const { getBucket } = require('../utils/gridfs');
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

      // Stream every file into GridFS (MongoDB Atlas) instead of disk.
      // If any single upload fails partway through, we clean up the ones
      // that already succeeded so we don't leave orphaned files in GridFS.
      const bucket = getBucket();
      const uploadedFileIds = [];
      let documents;
      try {
        documents = await Promise.all(
          req.files.map(
            (file, idx) =>
              new Promise((resolve, reject) => {
                const uploadStream = bucket.openUploadStream(file.originalname, {
                  metadata: { docType: labels[idx], mimetype: file.mimetype },
                });
                uploadedFileIds.push(uploadStream.id);
                Readable.from(file.buffer)
                  .pipe(uploadStream)
                  .on('error', reject)
                  .on('finish', () => {
                    resolve({
                      docType: labels[idx],
                      fileId: uploadStream.id,
                      filename: file.originalname,
                      mimetype: file.mimetype,
                      size: file.size,
                    });
                  });
              })
          )
        );
      } catch (uploadErr) {
        await Promise.allSettled(uploadedFileIds.map(id => bucket.delete(id)));
        console.error('GridFS upload failed:', uploadErr);
        return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
      }

      const applicationData = {
        studentNumber,
        scholarshipId,
        scholarshipName,
        applicationFormType: applicationFormType || 'standard',
        documents,
        referenceCode: `DLSU-D-SFAG-${Math.floor(Math.random() * 900000 + 100000)}`,
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

// GET a single stored document back out of GridFS, e.g. for SFAG staff review
// or for the student to preview what they uploaded.
router.get('/documents/:fileId', async (req, res) => {
  try {
    const bucket = getBucket();
    let fileId;
    try {
      fileId = new ObjectId(req.params.fileId);
    } catch {
      return res.status(400).json({ error: 'Invalid file id.' });
    }

    const matches = await bucket.find({ _id: fileId }).toArray();
    if (!matches.length) {
      return res.status(404).json({ error: 'File not found.' });
    }

    res.set('Content-Type', matches[0].metadata?.mimetype || 'image/jpeg');
    bucket
      .openDownloadStream(fileId)
      .pipe(res)
      .on('error', () => res.status(500).end());
  } catch (err) {
    console.error('GridFS download failed:', err);
    res.status(500).json({ error: 'Could not retrieve file.' });
  }
});

module.exports = router;