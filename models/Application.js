const mongoose = require('mongoose');

// One entry per uploaded document (built in routes/applications.js when
// streaming files into GridFS) — fileId points at the GridFS file, docType
// is the label the frontend supplied (e.g. "Application Letter", "Indigency").
const documentSchema = new mongoose.Schema({
  docType: String,
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  filename: String,
  mimetype: String,
  size: Number,
}, { _id: false });

const applicationSchema = new mongoose.Schema({
  // Taken from the authenticated Student record server-side, never from
  // req.body directly — see routes/applications.js.
  studentNumber: { type: String, required: true, index: true },

  scholarshipId: { type: String, required: true },
  // Derived server-side from the scholarship registry (findScholarship),
  // not trusted from the client.
  scholarshipName: { type: String, required: true },

  applicationFormType: { type: String, enum: ['standard', 'sfag'], default: 'standard' },

  documents: { type: [documentSchema], default: [] },

  referenceCode: { type: String, required: true, unique: true },

  // Populated only when applicationFormType === 'standard'.
  standardInfo: { type: mongoose.Schema.Types.Mixed },

  // Populated only when applicationFormType === 'sfag'.
  personalInfo: { type: mongoose.Schema.Types.Mixed },
  contactSchool: { type: mongoose.Schema.Types.Mixed },
  parentsGuardian: { type: mongoose.Schema.Types.Mixed },
  siblings: { type: [mongoose.Schema.Types.Mixed], default: [] },
  assetsExpenses: { type: mongoose.Schema.Types.Mixed },
  agreement: { type: mongoose.Schema.Types.Mixed },

  // Not written by the submit route yet, but routes/students.js and the
  // frontend's dashboard/explore views expect some notion of application
  // status down the line — default keeps existing submit flow unaffected.
  status: { type: String, enum: ['Under Evaluation', 'Approved', 'Rejected'], default: 'Under Evaluation' },
}, { timestamps: true });

module.exports = mongoose.model('Application', applicationSchema);