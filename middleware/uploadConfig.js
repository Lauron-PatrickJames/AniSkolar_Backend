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

// --- Profile picture (unchanged — still disk storage) ---
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

// --- Application documents ---
// Switched from diskStorage to memoryStorage: files are buffered in RAM
// just long enough for the route handler to stream them into GridFS, so
// they end up living in MongoDB Atlas instead of the server's local disk.
// (This is *why* they weren't showing up in Atlas before — diskStorage
// never sends the bytes to Mongo at all, only the route's own DB writes did.)
const applicationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }, // per file
  fileFilter,
});

// The 8 required documents you listed, mapped to form field names
// (kept for reference — the applications route currently uses a single
// "documents" array field paired with a "documentLabels" JSON array instead).
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