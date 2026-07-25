const mongoose = require('mongoose');
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

module.exports = { getBucket };