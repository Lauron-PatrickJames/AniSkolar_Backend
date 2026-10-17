// Scholarships the AdSO created (ScholarshipSetting with custom: true),
// kept in memory so findScholarship() stays synchronous like the built-in
// list. Loaded at startup (server.js) and reloaded after every create,
// edit or delete (routes/scholarships.js). One server process, so the copy
// can't drift.

let byId = new Map();

function toScholarship(setting) {
  return {
    id: setting.scholarshipId,
    name: setting.name,
    office: setting.office || 'LSO',
    formType: 'standard',
    applicationMode: setting.applicationMode || 'online',
    referenceCode: setting.referenceCode,
    custom: true,
  };
}

async function load() {
  const ScholarshipSetting = require('../models/ScholarshipSetting');
  const settings = await ScholarshipSetting.find({ custom: true }).lean();
  byId = new Map(settings.map(s => [s.scholarshipId, toScholarship(s)]));
  return byId.size;
}

const get = id => byId.get(id);
const list = () => [...byId.values()];

module.exports = { load, get, list };
