const mongoose = require('mongoose');

const CIVIL_STATUS_OPTIONS = ['Single', 'Married', 'Widowed', 'Separated', 'Divorced'];
const GUARDIAN_TYPES = ['father', 'mother', 'other'];
const VERIFICATION_GROUPS = ['program', 'enrollment', 'gpa'];
// Correction requests can also be about identity details, which students
// can't change after sign-up (routes/students.js LOCKED_FIELDS).
const CORRECTION_GROUPS = [...VERIFICATION_GROUPS, 'personal'];
const NAME_SUFFIXES = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// Set when an office verifies a group of academic details; absent means
// self-reported.
const verificationSchema = new mongoose.Schema({
    verifiedAt: Date,
    verifiedBy: String,       // admin email
    verifiedByName: String,
    office: String,           // office code: 'LSO' (AdSO), 'POLCA', 'ALUMNI'
}, { _id: false });

// A student asking the office to correct a verified group.
const correctionRequestSchema = new mongoose.Schema({
    group: { type: String, enum: CORRECTION_GROUPS, required: true },
    message: { type: String, trim: true, maxlength: 1000, required: true },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    createdAt: { type: Date, default: Date.now },
    resolvedAt: Date,
    resolvedBy: String,
}, { _id: true });

const studentSchema = new mongoose.Schema({
    studentNumber: { type: String, required: true, unique: true },
    // Links this record to the Clerk user that owns it — this is now the
    // real identity anchor. Everything else here is academic profile data
    // Clerk itself has no concept of.
    clerkId: { type: String, required: true, unique: true, index: true },
    // Full display name, composed from the parts below.
    name: { type: String, required: true },
    // Name parts, kept separately and never split from `name`: first and
    // last come from the Clerk profile (Microsoft sign-in), the middle name
    // is entered by the student. Older records may lack them until
    // scripts/backfill-student-names.js is run (GET /me fills them from
    // Clerk in the meantime).
    firstName: { type: String, trim: true },
    middleName: { type: String, trim: true },
    // When the student confirmed their details at sign-up (identity
    // details are locked from then on).
    profileConfirmedAt: Date,
    nameSuffix: { type: String, enum: [...NAME_SUFFIXES, ''] },
    lastName: { type: String, trim: true },
    // Course name and college are taken from the program list
    // (data/programs.js) by programCode; students pick the program only.
    course: String,
    college: String,
    yearLevel: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Deprecated — Clerk now owns credentials entirely. Kept optional
    // (not required) only so old documents / a rollback don't break;
    // new records created via /api/students/complete-profile never set this.
    passwordHash: { type: String },

    // Cumulative GPA on DLSU-D's scale: 0.00–4.00, higher is better
    // (4.00 highest, 0.00 failed). Same scale as the GPA calculator and
    // the scholarships' GPA rules (frontend src/utils/eligibility.ts).
    gpa: { type: Number, min: 0, max: 4 },

    // --- Personal Details ---
    programCode: String,        // e.g. "BSIT"
    section: String,
    dateOfBirth: Date,
    nationality: String,
    placeOfBirth: String,
    civilStatus: { type: String, enum: CIVIL_STATUS_OPTIONS },

    // --- Contact Information ---
    homeAddress: String,        // complete home address
    cityMunicipality: String,
    province: String,
    zipCode: String,
    country: { type: String, default: 'Philippines' },
    telephoneNumber: String,
    // Philippine mobile, stored as 09XXXXXXXXX (routes/students.js normalizes).
    mobileNumber: String,

    // --- Parents / Guardian Information ---
    fatherName: String,
    fatherContactNo: String,
    fatherDeceased: Boolean,
    motherName: String,
    motherContactNo: String,
    motherDeceased: Boolean,
    // Who the guardian is. 'father' / 'mother' copy that parent into the
    // guardian fields below on save, so readers of guardianName etc. (the
    // application forms) keep working; 'other' is someone else.
    guardianType: { type: String, enum: GUARDIAN_TYPES },
    guardianName: String,
    guardianRelationship: String,
    guardianAddress: String,
    // The guardian lives at the student's home address; guardianAddress is
    // filled from it on save.
    guardianAddressSameAsHome: Boolean,
    guardianContactNo: String,

    // --- Verification of academic details ---
    // Academic details are self-reported until an office verifies them,
    // per group: 'program' (program, course, college), 'enrollment' (year
    // level, section), 'gpa'. A verified group is locked from student
    // edits; the student files a correction request instead.
    verification: {
        program: verificationSchema,
        enrollment: verificationSchema,
        gpa: verificationSchema,
    },
    correctionRequests: { type: [correctionRequestSchema], default: [] },

    profilePicture: {
        filename: String,
        path: String,     // e.g. /uploads/profile-pics/xxx.jpg
        mimetype: String,
        size: Number,
        uploadedAt: Date,
    },
    // Synced from Clerk (clerkUser.imageUrl) at profile completion and on
    // every PATCH /me — this is the Microsoft/Clerk-hosted avatar, distinct
    // from `profilePicture` above which is a manually-uploaded file the
    // student attaches themselves.
    avatarUrl: String,
    fileRequirements: [{
    label: String,        // e.g. "Certificate of Registration", "Income Tax Return"
    filename: String,
    path: String,         // e.g. /uploads/requirements/xxx.jpg
    mimetype: String,
    size: Number,
    uploadedAt: Date,
    }],
    }, { timestamps: true });

module.exports = mongoose.model('Student', studentSchema);
module.exports.CIVIL_STATUS_OPTIONS = CIVIL_STATUS_OPTIONS;
module.exports.GUARDIAN_TYPES = GUARDIAN_TYPES;
module.exports.VERIFICATION_GROUPS = VERIFICATION_GROUPS;
module.exports.CORRECTION_GROUPS = CORRECTION_GROUPS;
module.exports.NAME_SUFFIXES = NAME_SUFFIXES;