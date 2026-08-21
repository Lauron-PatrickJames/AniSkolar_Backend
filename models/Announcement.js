const mongoose = require('mongoose');

// Matches frontend/src/types.ts `Announcement` exactly on the required
// fields (title, date, description, content, category), plus two optional
// admin-only extensions (isPinned, status) that the student-facing
// AnnouncementCard simply ignores since it only reads the fields it knows.

const CATEGORIES = ['General', 'Update', 'Deadline', 'Event'];

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150
    },
    // Short teaser shown on the collapsed AnnouncementCard.
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500
    },
    // Full body shown when the card is expanded (whitespace-preserved on
    // the frontend via `whitespace-pre-line`).
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 8000
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: 'General'
    },
    // Admin-only: lets an announcement be written and saved without
    // immediately showing on the student feed. Not part of the frontend
    // Announcement type — GET /feed only returns status: 'published'.
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'draft'
    },
    // Admin-only: surfaces above the regular feed order when true. Not part
    // of the frontend Announcement type.
    isPinned: {
      type: Boolean,
      default: false
    },
    publishedAt: {
      type: Date,
      default: null
    },
    createdBy: {
      type: String, // Clerk user id or admin display name
      required: true
    }
  },
  { timestamps: true }
);

announcementSchema.index({ status: 1, isPinned: -1, publishedAt: -1 });

// Formats a Date the same way the mock data does — "July 01, 2026" — so the
// API's `date` field matches what AnnouncementCard expects without the
// frontend needing any date-parsing logic.
function formatDisplayDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' });
}

// Shapes a Mongoose doc into exactly the frontend Announcement interface
// (id, title, date, description, content, category) plus the two
// admin-only extensions, so routes can just call `.toClientShape()`.
announcementSchema.methods.toClientShape = function toClientShape() {
  return {
    id: this._id.toString(),
    title: this.title,
    date: formatDisplayDate(this.publishedAt || this.createdAt),
    description: this.description,
    content: this.content,
    category: this.category,
    // Admin extensions — present for the admin dashboard, harmless extra
    // keys for the student portal.
    status: this.status,
    isPinned: this.isPinned,
    publishedAt: this.publishedAt,
    createdBy: this.createdBy,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('Announcement', announcementSchema);
module.exports.CATEGORIES = CATEGORIES;