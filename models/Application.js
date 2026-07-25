const mongoose = require('mongoose');

// --- Sub-schemas mirroring your SfagPersonalInfo, SfagContactSchool, etc. ---

const personalInfoSchema = new mongoose.Schema({
  lastName: String,
  firstName: String,
  middleInitial: String,
  suffix: String,
  studentNumber: String,
  course: String,
  yearLevel: String,
  placeOfBirth: String,
  dateOfBirth: String,
  age: String,
  civilStatus: String,
  gender: String,
  nationality: String,
  isPwd: Boolean,
  religion: String,
  specifyReligion: String,
}, { _id: false });

const contactSchoolSchema = new mongoose.Schema({
  streetAddress: String,
  municipality: String,
  province: String,
  country: String,
  mobileNo: String,
  landlineNo: String,
  email: String,
  secondarySchool: String,
  schoolAddress: String,
  schoolType: String,
}, { _id: false });

const parentInfoSchema = new mongoose.Schema({
  fullName: String,
  occupation: String,
  company: String,
  companyTel: String,
  monthlyIncome: String,
  isSoloParent: Boolean,
}, { _id: false });

const guardianInfoSchema = new mongoose.Schema({
  fullName: String,
  occupation: String,
  monthlyIncome: String,
  relationship: String,
  contactNo: String,
}, { _id: false });

const parentsGuardianSchema = new mongoose.Schema({
  father: parentInfoSchema,
  mother: parentInfoSchema,
  guardian: guardianInfoSchema,
}, { _id: false });

const siblingSchema = new mongoose.Schema({
  id: String,
  fullName: String,
  socialStatus: String,
  civilStatus: String,
  age: String,
  schoolOrCompany: String,
  schoolType: String,
  tuitionOrIncome: String,
  isDlsudScholar: Boolean,
}, { _id: false });

const assetsExpensesSchema = new mongoose.Schema({
  houseAndLot: String,
  automobile: String,
  incomeSources: String,
  combinedNonTaxableIncome: String,
  affidavitNonFilingIncomeTax: String,
  waterBill: String,
  electricityBill: String,
  telephoneBill: String,
  mobilePhoneBill: String,
  internetBill: String,
  amortizationHouse: String,
  amortizationAuto: String,
}, { _id: false });

const agreementSchema = new mongoose.Schema({
  certifyConsulted: Boolean,
  certifyAccuracy: Boolean,
}, { _id: false });

// fileId points at the GridFS file living in the applicationDocs bucket —
// fetch its bytes back via GET /api/applications/documents/:fileId.
// (No more `path`: there's no local disk file anymore, the bytes live in Atlas.)
const documentSchema = new mongoose.Schema({
  docType: { type: String, required: true },
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  filename: String,
  mimetype: String,
  size: Number,
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

// --- Main Application schema ---

const applicationSchema = new mongoose.Schema({
  studentNumber: {
    type: String,
    required: true,
    index: true, // speeds up lookups like "all applications for this student"
  },
  scholarshipId: { type: String, required: true },
  scholarshipName: String,
  applicationFormType: { type: String, enum: ['standard', 'sfag'], default: 'standard' },

  standardInfo: {
    firstName: String,
    lastName: String,
    email: String,
    phone: String,
    studentNumber: String,
    program: String,
    yearLevel: String,
    gpa: String,
  },

  personalInfo: personalInfoSchema,
  contactSchool: contactSchoolSchema,
  parentsGuardian: parentsGuardianSchema,
  siblings: [siblingSchema],
  assetsExpenses: assetsExpensesSchema,
  agreement: agreementSchema,

  documents: [documentSchema],

  status: {
    type: String,
    enum: ['Under Evaluation', 'Approved', 'Rejected', 'Needs Revision'],
    default: 'Under Evaluation',
  },
  referenceCode: String,
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: Date,
  reviewNotes: String,
}, { timestamps: true });

module.exports = mongoose.model('Application', applicationSchema);