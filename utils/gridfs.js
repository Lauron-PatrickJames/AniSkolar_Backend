const mongoose = require('mongoose');
const { Readable } = require('stream');
const { GridFSBucket } = require('mongodb');

let bucket;

/**
 * Singleton GridFSBucket bound to the same connection mongoose.connect()
 * already opened in server.js. Lazily created on first use, so it's safe
 * to require this file anywhere — by the time a request comes in, the
 * connection in server.js has long since resolved.
 */
function getBucket() {
  if (!bucket) {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected yet — getBucket() was called before mongoose.connect() resolved.');
    }
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'applicationDocs' });
  }
  return bucket;
}

// Streams every uploaded file (multer memory storage) into GridFS and
// returns one document entry per file. If any upload fails partway through,
// the ones that already succeeded are deleted so no orphaned files are left
// behind, and the error is rethrown. Used by applications and renewals.
async function storeFilesInGridFS(files, labels, meta = []) {
  const bucket = getBucket();
  const uploadedFileIds = [];
  try {
    return await Promise.all(
      files.map(
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
                  slotKey: meta[idx]?.slotKey,
                  variant: meta[idx]?.variant,
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
    throw uploadErr;
  }
}

module.exports = { getBucket, storeFilesInGridFS };