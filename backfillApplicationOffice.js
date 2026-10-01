// backfillApplicationOffice.js
// Lives in the backend project root (next to server.js).
//
// One-time migration for applications created before the `office` field
// existed on the Application model. Tags each one with the office its
// scholarship belongs to in data/scholarships.js (every scholarship that
// existed before offices did is an LSO one). Office-scoped admins (e.g.
// POLCA staff, see utils/officeScope.js) filter on this field, so this
// keeps the stored data consistent with what new submissions write.
//
// Safe to re-run: only touches documents with no office set.
//
// Usage (run from the AniSkolar_Backend folder):
//   node backfillApplicationOffice.js            # apply changes
//   node backfillApplicationOffice.js --dry-run   # report only

// Same DNS fix as server.js.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const Application = require('./models/Application');
const { SCHOLARSHIPS } = require('./data/scholarships');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('No MONGODB_URI (or MONGO_URI) found in environment. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. ${DRY_RUN ? '[DRY RUN] ' : ''}Tagging applications with no office...`);

  const missing = { $or: [{ office: { $exists: false } }, { office: null }] };
  let total = 0;
  for (const office of [...new Set(SCHOLARSHIPS.map(s => s.office))]) {
    const ids = SCHOLARSHIPS.filter(s => s.office === office).map(s => s.id);
    const filter = { ...missing, scholarshipId: { $in: ids } };
    const count = await Application.countDocuments(filter);
    if (!DRY_RUN && count) await Application.updateMany(filter, { $set: { office } });
    console.log(`  ${office}: ${count}`);
    total += count;
  }
  // Anything left points at a scholarship no longer in the registry.
  const unknown = await Application.countDocuments(missing);
  if (!DRY_RUN && unknown) await Application.updateMany(missing, { $set: { office: 'LSO' } });
  console.log(`  unknown scholarship -> LSO: ${unknown}`);
  console.log(`Updated ${total + unknown}${DRY_RUN ? ' (dry run — no writes made)' : ''}.`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
