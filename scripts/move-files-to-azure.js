// Copies uploaded files (application and renewal documents, announcement
// images) from MongoDB GridFS to Azure Blob Storage, keeping each file's id,
// so nothing that points at them changes. After this the app reads them
// from Azure (utils/gridfs.js). Needs AZURE_STORAGE_CONNECTION_STRING in .env.
//
//   node scripts/move-files-to-azure.js                  # dry run: what would be copied
//   node scripts/move-files-to-azure.js --apply          # copy (and check each copy's size)
//   node scripts/move-files-to-azure.js --apply --delete-from-mongodb
//                                                        # copy, then free the space in MongoDB
//
// Run --apply first and check the app before deleting anything. Files
// already in Azure with the same size are skipped, so it's safe to re-run.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const { getBucket, getContainer, azureEnabled } = require('../utils/gridfs');

const APPLY = process.argv.includes('--apply');
// --db <name>: another database on the same cluster (used for testing).
const dbArg = process.argv.indexOf('--db');
const DB_NAME = dbArg > -1 ? process.argv[dbArg + 1] : undefined;
const DELETE = process.argv.includes('--delete-from-mongodb');

(async () => {
  if (!azureEnabled()) {
    console.error('AZURE_STORAGE_CONNECTION_STRING is not set in .env — nothing to move to.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, DB_NAME ? { dbName: DB_NAME } : {});
  const bucket = getBucket();
  const container = await getContainer();
  const files = await bucket.find({}).toArray();
  const totalMb = files.reduce((n, f) => n + f.length, 0) / 1e6;
  console.log(`${files.length} files in MongoDB (${totalMb.toFixed(1)} MB) → container "${container.containerName}"`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  for (const f of files) {
    const blob = container.getBlockBlobClient(String(f._id));
    const props = await blob.getProperties().catch(err => (err.statusCode === 404 ? null : Promise.reject(err)));
    if (props && props.contentLength === f.length) {
      skipped++;
    } else if (!APPLY) {
      copied++;
    } else {
      try {
        const chunks = [];
        for await (const c of bucket.openDownloadStream(f._id)) chunks.push(c);
        const data = Buffer.concat(chunks);
        await blob.uploadData(data, {
          blobHTTPHeaders: { blobContentType: f.metadata?.mimetype || 'application/octet-stream' },
          metadata: { filename: encodeURIComponent(f.filename || '') },
        });
        const check = await blob.getProperties();
        if (check.contentLength !== f.length) throw new Error(`size mismatch (${check.contentLength} vs ${f.length})`);
        copied++;
      } catch (err) {
        failed++;
        console.error(`  ✗ ${f._id} ${f.filename}: ${err.message}`);
        continue;
      }
    }
    if (APPLY && DELETE) {
      const check = await blob.getProperties().catch(() => null);
      if (check && check.contentLength === f.length) await bucket.delete(f._id);
    }
  }

  console.log(APPLY
    ? `Copied ${copied}, already in Azure ${skipped}, failed ${failed}.${DELETE ? ' Deleted the copied files from MongoDB.' : ''}`
    : `Dry run: would copy ${copied}; ${skipped} already in Azure. Run with --apply to copy.`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
