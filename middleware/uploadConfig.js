const multer = require('multer');
const path = require('path');
const fs = require('fs');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg'];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const isMimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype);
  const isExtAllowed = ALLOWED_EXTENSIONS.includes(ext);
  if (!isMimeAllowed || !isExtAllowed) {
    return cb(new Error(`"${file.fieldname}" must be a JPEG/JPG image.`));
  }
  cb(null, true);
};

// --- Profile picture (existing, unchanged) ---
const PROFILE_DIR = path.join(__dirname, '..', 'uploads', 'profile-pics');
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PROFILE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.studentId || 'student'}-${Date.now()}${ext}`);
  },
});

const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

// --- Application documents (8 required files) ---
const APPLICATION_DIR = path.join(__dirname, '..', 'uploads', 'application-docs');
if (!fs.existsSync(APPLICATION_DIR)) fs.mkdirSync(APPLICATION_DIR, { recursive: true });

const applicationStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, APPLICATION_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const applicationUpload = multer({
  storage: applicationStorage,
  limits: { fileSize: MAX_FILE_SIZE }, // per file
  fileFilter,
});

// The 8 required documents you listed, mapped to form field names
const APPLICATION_DOCUMENT_FIELDS = [
  { name: 'applicationLetter', maxCount: 1 },
  { name: 'recommendationLetter', maxCount: 1 },
  { name: 'personalEssay', maxCount: 1 },
  { name: 'indigency', maxCount: 1 },
  { name: 'itr', maxCount: 1 },
  { name: 'utilityBills', maxCount: 1 },
  { name: 'residencePicture', maxCount: 1 },
  { name: 'vicinitySketch', maxCount: 1 },
];

module.exports = { profileUpload, applicationUpload, APPLICATION_DOCUMENT_FIELDS };