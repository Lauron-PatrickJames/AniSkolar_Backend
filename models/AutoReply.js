const mongoose = require('mongoose');

// An office's automatic replies to students (panel, Nov 2026: "like a
// Facebook business page"), set on its Messages page. One per office inbox
// (_id = the office code, 'LSO' for the AdSO). utils/autoReplies.js sends:
//   welcome  when a student starts a conversation (or writes after a week
//            without messages)
//   away     when a student writes outside office hours (weekdays 8 AM to
//            5 PM, Manila) or while the office is set as away; at most once
//            every 12 hours per conversation. Sent instead of the welcome.
//   faqs     quick questions students tap; the answer comes back at once.

const faqSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true, maxlength: 150 },
  answer: { type: String, required: true, trim: true, maxlength: 2000 },
});

const autoReplySchema = new mongoose.Schema({
  _id: { type: String },          // office code
  welcome: {
    enabled: { type: Boolean, default: false },
    text: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  away: {
    enabled: { type: Boolean, default: false },
    // 'outsideHours' (automatic) or 'always' (the office is away now).
    mode: { type: String, enum: ['outsideHours', 'always'], default: 'outsideHours' },
    text: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  faqs: { type: [faqSchema], default: [] },
  updatedBy: String,
}, { timestamps: true });

module.exports = mongoose.model('AutoReply', autoReplySchema);
module.exports.MAX_FAQS = 10;
