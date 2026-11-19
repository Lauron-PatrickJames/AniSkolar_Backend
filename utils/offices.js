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

// Office heads' leave, by normalized office name: { onLeave, since,
// returnsOn, endedAt } (DutySetting.leaves).
async function officeLeaves() {
  const doc = await DutySetting.findById('duty').select('leaves').lean();
  return new Map((doc?.leaves ?? []).map(l => [l.office, { onLeave: !l.endedAt, since: l.since ?? null, returnsOn: l.returnsOn ?? null, endedAt: l.endedAt ?? null }]));
}

// Starts or ends a head's leave. `returnsOn` is optional (YYYY-MM-DD).
async function setOfficeLeave(office, onLeave, { returnsOn = null, by = null, now = new Date() } = {}) {
  const key = norm(office);
  const doc = await DutySetting.findById('duty').select('leaves').lean();
  const others = (doc?.leaves ?? []).filter(l => l.office !== key);
  const prev = (doc?.leaves ?? []).find(l => l.office === key);
  const entry = onLeave
    ? { office: key, since: prev && !prev.endedAt ? prev.since : now, ...(returnsOn ? { returnsOn } : {}), setBy: by }
    : { office: key, since: prev?.since ?? now, endedAt: now, setBy: by };
  if (!onLeave && (!prev || prev.endedAt)) return;   // not on leave
  await DutySetting.updateOne({ _id: 'duty' }, { $set: { leaves: [...others, entry] } }, { upsert: true });
}

module.exports = { norm, listOffices, officeForHead, officesWithHeads, officeLeaves, setOfficeLeave };
