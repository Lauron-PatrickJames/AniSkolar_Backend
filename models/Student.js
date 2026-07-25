    const mongoose = require('mongoose');

    const studentSchema = new mongoose.Schema({
    studentNumber: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    course: String,
    college: String,
    yearLevel: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    gpa: String,
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