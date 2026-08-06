const mongoose = require('mongoose');

const CIVIL_STATUS_OPTIONS = ['Single', 'Married', 'Widowed', 'Separated', 'Divorced'];

const studentSchema = new mongoose.Schema({
    studentNumber: { type: String, required: true, unique: true },
    // Links this record to the Clerk user that owns it — this is now the
    // real identity anchor. Everything else here is academic profile data
    // Clerk itself has no concept of.
    clerkId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    course: String,
    college: String,
    yearLevel: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Deprecated — Clerk now owns credentials entirely. Kept optional
    // (not required) only so old documents / a rollback don't break;
    // new records created via /api/students/complete-profile never set this.
    passwordHash: { type: String },

    // GPA is numeric now instead of free text, so bad input ("asdf") can't
    // get stored. Bounds are set wide (1.0–5.0) to cover either a
    // 4.0-high or 1.0-high grading scale — tighten these to match
    // DLSU-D's actual scale once you confirm which direction it runs.
    gpa: { type: Number, min: 1.0, max: 5.0 },

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
    mobileNumber: String,

    // --- Parents / Guardian Information ---
    fatherName: String,
    motherName: String,
    guardianName: String,
    guardianRelationship: String,
    guardianAddress: String,
    guardianContactNo: String,

    profilePicture: {
        filename: String,
        path: String,     // e.g. /uploads/profile-pics/xxx.jpg
        mimetype: String,
        size: Number,
        uploadedAt: Date,
    },
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