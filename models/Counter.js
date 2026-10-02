const mongoose = require('mongoose');

// Named sequences, incremented atomically. Used for application reference
// numbers (utils/referenceCode.js): one counter per scholarship code and
// academic year, e.g. _id 'ref:ENT:2026'.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

module.exports = mongoose.model('Counter', counterSchema);
