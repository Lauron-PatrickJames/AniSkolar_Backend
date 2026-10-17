const mongoose = require('mongoose');
const { Readable } = require('stream');
const { GridFSBucket, ObjectId } = require('mongodb');

// Uploaded files: application and renewal documents, announcement images.
//
// Where they live:
//   - Azure Blob Storage when AZURE_STORAGE_CONNECTION_STRING is set
//     (production). One private container (AZURE_STORAGE_CONTAINER, default
//     'aniskolar-files'); each file is a blob named after its id. Nothing
//     is public: files are only served through the API's access checks.
//   - Otherwise MongoDB GridFS, bucket 'applicationDocs' (local development,
//     and files uploaded before the move to Azure).
//
// Every file has a MongoDB ObjectId either way, so the records that point
// at files (documents[].fileId, images[].fileId) don't change. Reading tries
// Azure first and falls back to GridFS, so files not yet moved keep working;
// scripts/move-files-to-azure.js copies them over.

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

// --- Azure Blob Storage --------------------------------------------------------

let containerClient;
let containerReady;

function azureEnabled() {
  return !!process.env.AZURE_STORAGE_CONNECTION_STRING;
}

async function getContainer() {
  if (!containerClient) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    containerClient = service.getContainerClient(process.env.AZURE_STORAGE_CONTAINER || 'aniskolar-files');
    // Private: no anonymous access.
    containerReady = containerClient.createIfNotExists();
  }
  await containerReady;
  return containerClient;
}

const toId = id => (id instanceof ObjectId ? id : new ObjectId(String(id)));

// --- The file store ---------------------------------------------------------------

/**
 * Stores one file and returns its id (an ObjectId).
 * metadata is kept with the file (e.g. { docType } or { kind }).
 */
async function putFile({ buffer, filename, mimetype, metadata = {} }) {
  const id = new ObjectId();
  if (azureEnabled()) {
    const container = await getContainer();
    const meta = { filename: encodeURIComponent(filename || ''), ...Object.fromEntries(
      Object.entries(metadata).filter(([, v]) => v != null).map(([k, v]) => [k.toLowerCase(), encodeURIComponent(String(v))])
    ) };
    await container.getBlockBlobClient(String(id)).uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: mimetype || 'application/octet-stream' },
      metadata: meta,
    });
    return id;
  }
  await new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStreamWithId(id, filename, { metadata: { ...metadata, mimetype } });
    Readable.from(buffer).pipe(upload).on('error', reject).on('finish', resolve);
  });
  return id;
}

/**
 * Opens a stored file for reading. Returns { stream, contentType, length }
 * or null when there's no such file in either store.
 */
async function openFile(fileId) {
  const id = toId(fileId);
  if (azureEnabled()) {
    const container = await getContainer();
    try {
      const res = await container.getBlobClient(String(id)).download();
      return { stream: res.readableStreamBody, contentType: res.contentType, length: res.contentLength };
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      // Not moved to Azure yet: fall back to GridFS.
    }
  }
  const [file] = await getBucket().find({ _id: id }).toArray();
  if (!file) return null;
  return { stream: getBucket().openDownloadStream(id), contentType: file.metadata?.mimetype, length: file.length };
}

// A whole file as a Buffer (e.g. to post an image to Facebook).
async function readFile(fileId) {
  const file = await openFile(fileId);
  if (!file) throw new Error(`File ${fileId} not found.`);
  const chunks = [];
  for await (const chunk of file.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Deletes a file from wherever it is. Missing files are ignored.
async function deleteFile(fileId) {
  const id = toId(fileId);
  if (azureEnabled()) {
    const container = await getContainer();
    await container.getBlobClient(String(id)).deleteIfExists();
  }
  try {
    await getBucket().delete(id);
  } catch (err) {
    if (!/FileNotFound|File not found/i.test(err.message)) throw err;
  }
}

// Stores every uploaded file (multer memory storage) and returns one
// document entry per file. If any upload fails partway through, the ones
// that already succeeded are deleted so no orphaned files are left behind,
// and the error is rethrown. Used by applications and renewals.
async function storeFilesInGridFS(files, labels, meta = []) {
  // Wait for every upload to finish either way, so cleanup sees them all.
  const results = await Promise.allSettled(files.map((file, idx) => putFile({
    buffer: file.buffer,
    filename: file.originalname,
    mimetype: file.mimetype,
    metadata: { docType: labels[idx] },
  })));
  const failed = results.find(r => r.status === 'rejected');
  if (failed) {
    await Promise.allSettled(results.filter(r => r.status === 'fulfilled').map(r => deleteFile(r.value)));
    throw failed.reason;
  }
  return files.map((file, idx) => ({
    docType: labels[idx],
    slotKey: meta[idx]?.slotKey,
    variant: meta[idx]?.variant,
    fileId: results[idx].value,
    filename: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  }));
}

module.exports = { getBucket, azureEnabled, getContainer, putFile, openFile, readFile, deleteFile, storeFilesInGridFS, storeFiles: storeFilesInGridFS };
