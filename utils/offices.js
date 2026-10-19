const DutySetting = require('../models/DutySetting');

// Duty offices and their heads (DutySetting.officeSlots). Office names are
// matched without regard to case or extra spaces, like the Duty hours page.

const norm = name => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function listOffices() {
  const doc = await DutySetting.findById('duty').select('officeSlots').lean();
  return doc?.officeSlots ?? [];
}

// The office whose head has this email, or null.
async function officeForHead(email) {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  return (await listOffices()).find(o => o.headEmail && o.headEmail === e) ?? null;
}

// Names (normalized) of offices with a head in AniSkolar: their scholars'
// duties count only once the head confirms them.
async function officesWithHeads() {
  return new Set((await listOffices()).filter(o => o.headEmail).map(o => norm(o.office)));
}

module.exports = { norm, listOffices, officeForHead, officesWithHeads };
