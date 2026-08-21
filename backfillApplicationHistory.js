// backfillApplicationHistory.js
// Lives in the backend project root (next to server.js).
//
// One-time backfill for applications created before the `history` field
// existed on the Application model. Synthesizes a best-guess history from
// fields that were already being stored (createdAt, status, reviewNote,
// reviewedBy, reviewedAt), so old records aren't blank in the admin
// Timeline / analytics instead of leaving them empty forever.
//
// What it can and can't reconstruct, honestly:
//   - Always adds a 'Submitted' entry at createdAt (changedBy: 'student') —
//     every application has this, it's just createdAt itself.
//   - If the current status is not 'Under Evaluation' (i.e. an admin has
//     reviewed it at least once) AND reviewedAt/reviewedBy exist, adds ONE
//     entry for that final decision using the CURRENT status, reviewNote,
//     reviewedBy, reviewedAt.
//   - What it CANNOT recover: any intermediate decisions before the current
//     one (e.g. an earlier "Needs Revision" that got superseded by the
//     current "Approved"), or resubmission timestamps — those were never
//     stored anywhere pre-migration, so this script does not invent them.
//     This means avg-processing-time / revision-cycle stats computed from
//     backfilled records will UNDERCOUNT revision loops that happened
//     pre-migration. There's no way around that without the original data.
//   - Applications still 'Under Evaluation' with no review yet just get
//     the single 'Submitted' entry, same as new ones would at this point
//     in their life.
//
// Safe to re-run: only touches documents where history is missing or
// empty, so it will not duplicate entries on a second run or overwrite
// history that real traffic has since written.
//
// Usage (run from the AniSkolar_Backend folder):
//   node backfillApplicationHistory.js            # apply changes
//   node backfillApplicationHistory.js --dry-run   # report only

// Same DNS fix as server.js — some networks (e.g. Globe Broadband) can't
// resolve the mongodb+srv:// SRV record against the ISP's default DNS,
// so point Node's resolver at Google/Cloudflare before connecting.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const Application = require('./models/Application');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('No MONGODB_URI (or MONGO_URI) found in environment. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. ${DRY_RUN ? '[DRY RUN] ' : ''}Scanning for applications with missing/empty history...`);

  const targets = await Application.find({
    $or: [{ history: { $exists: false } }, { history: { $size: 0 } }],
  });

  console.log(`Found ${targets.length} application(s) needing backfill.`);

  let updated = 0;
  let withDecision = 0;
  let submittedOnly = 0;
  let skippedNoCreatedAt = 0;

  for (const app of targets) {
    if (!app.createdAt) {
      // Extremely unlikely given { timestamps: true }, but don't fabricate
      // a submission date out of nowhere if it's somehow missing.
      skippedNoCreatedAt++;
      continue;
    }

    const entries = [
      { status: 'Submitted', changedBy: 'student', changedAt: app.createdAt },
    ];

    const hasBeenReviewed = app.status !== 'Under Evaluation';
    if (hasBeenReviewed && app.reviewedAt) {
      entries.push({
        status: app.status,
        note: app.reviewNote || undefined,
        changedBy: app.reviewedBy || undefined,
        changedAt: app.reviewedAt,
      });
      withDecision++;
    } else {
      submittedOnly++;
    }

    if (!DRY_RUN) {
      app.history = entries;
      await app.save();
    }
    updated++;
  }

  console.log('--- Backfill summary ---');
  console.log(`Total scanned:            ${targets.length}`);
  console.log(`Updated:                  ${updated}${DRY_RUN ? ' (dry run — no writes made)' : ''}`);
  console.log(`  with a decision entry:  ${withDecision}`);
  console.log(`  submitted-only:         ${submittedOnly}`);
  console.log(`Skipped (no createdAt):   ${skippedNoCreatedAt}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});