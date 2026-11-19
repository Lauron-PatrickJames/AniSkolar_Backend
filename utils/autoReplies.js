const AutoReply = require('../models/AutoReply');
const Message = require('../models/Message');
const { OFFICES } = require('../data/offices');

// Automatic replies (models/AutoReply.js): what to send after a student's
// message, and the settings as the office edits them.

const WELCOME_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const AWAY_EVERY_MS = 12 * 60 * 60 * 1000;
const ADSO = 'LSO';

const inboxOf = code => (code === ADSO ? { inbox: { $in: [null, ADSO] } } : { inbox: code });
const shortName = code => OFFICES.find(o => o.code === code)?.short ?? 'AdSO';

// Office hours: Monday to Friday, 8 AM to 5 PM, Manila time.
function inOfficeHours(now = new Date()) {
  const manila = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = manila.getUTCDay();
  const minutes = manila.getUTCHours() * 60 + manila.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 8 * 60 && minutes < 17 * 60;
}

// Settings as the office page shows them.
function settingsView(doc) {
  return {
    welcome: { enabled: !!doc?.welcome?.enabled, text: doc?.welcome?.text ?? '' },
    away: { enabled: !!doc?.away?.enabled, mode: doc?.away?.mode ?? 'outsideHours', text: doc?.away?.text ?? '' },
    faqs: (doc?.faqs ?? []).map(f => ({ _id: String(f._id), question: f.question, answer: f.answer })),
    updatedAt: doc?.updatedAt ?? null,
  };
}

// Checks the office's settings. Returns { value } or { error }.
function parseSettings(body) {
  const b = body || {};
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const welcome = { enabled: b.welcome?.enabled === true, text: text(b.welcome?.text, 1000) };
  if (welcome.enabled && !welcome.text) return { error: 'Write the welcome message, or turn it off.' };
  const away = { enabled: b.away?.enabled === true, mode: b.away?.mode === 'always' ? 'always' : 'outsideHours', text: text(b.away?.text, 1000) };
  if (away.enabled && !away.text) return { error: 'Write the away message, or turn it off.' };
  const list = Array.isArray(b.faqs) ? b.faqs : [];
  if (list.length > AutoReply.MAX_FAQS) return { error: `Add at most ${AutoReply.MAX_FAQS} quick questions.` };
  const faqs = [];
  for (const f of list) {
    const question = text(f?.question, 150);
    const answer = text(f?.answer, 2000);
    if (!question && !answer) continue;
    if (!question || !answer) return { error: 'Each quick question needs a question and its answer.' };
    faqs.push({ ...(typeof f._id === 'string' && /^[a-f\d]{24}$/i.test(f._id) ? { _id: f._id } : {}), question, answer });
  }
  return { value: { welcome, away, faqs } };
}

// The reply is timed just after the message it answers (`after`), so it
// always comes right below it, never above.
const autoMessage = (inbox, studentNumber, kind, body, after) => {
  const at = new Date(Math.max(Date.now(), new Date(after?.createdAt ?? 0).getTime() + 1));
  return Message.create({
    studentNumber, inbox, from: 'adso', auto: kind, body,
    authorName: `${shortName(inbox)} · automatic reply`,
    createdAt: at, updatedAt: at,
  });
};

// A typed message that asks one of the quick questions (panel, Nov 2026):
// the words that matter (not "the", "how", "po"…) mostly the same as the
// question's. Short messages only, so a long message about something else
// never gets a canned answer. Returns the matching FAQ or null.
const STOP_WORDS = new Set('a an the is are am i my me you your we our it its to of for in on at and or do does did can could will would how what when where who which why there this that be with po ba ko ang ng sa mga na hello hi good morning afternoon evening please pls thanks thank'.split(' '));
const words = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
function matchFaq(body, faqs) {
  const asked = words(body);
  if (!asked.length || asked.length > 15) return null;
  let best = null;
  for (const f of faqs || []) {
    const q = new Set(words(f.question));
    if (!q.size) continue;
    const shared = asked.filter(w => q.has(w)).length;
    // Most of the question's words, and most of what was asked.
    const score = Math.min(shared / q.size, shared / asked.length);
    if (score >= 0.6 && (!best || score > best.score)) best = { faq: f, score };
  }
  return best?.faq ?? null;
}

// After a student's message `sent` in `inbox`: the answer to a quick
// question they typed, or else the welcome or away reply, if one is due.
// Returns the messages created (none, or one).
async function replyAfter(inbox, studentNumber, sent, now = new Date()) {
  const settings = await AutoReply.findById(inbox).lean();
  if (!settings) return [];
  const faq = matchFaq(sent.body, settings.faqs);
  if (faq) return [await autoMessage(inbox, studentNumber, 'faq', faq.answer, sent)];
  if (!settings.welcome?.enabled && !settings.away?.enabled) return [];
  const thread = { studentNumber, ...inboxOf(inbox), _id: { $ne: sent._id } };
  if (settings.away?.enabled && (settings.away.mode === 'always' || !inOfficeHours(now))) {
    const recent = await Message.exists({ ...thread, auto: 'away', createdAt: { $gt: new Date(now.getTime() - AWAY_EVERY_MS) } });
    if (!recent) return [await autoMessage(inbox, studentNumber, 'away', settings.away.text, sent)];
    return [];
  }
  if (settings.welcome?.enabled) {
    const previous = await Message.findOne(thread).sort({ createdAt: -1 }).select('createdAt').lean();
    if (!previous || now.getTime() - new Date(previous.createdAt).getTime() > WELCOME_AFTER_MS) {
      return [await autoMessage(inbox, studentNumber, 'welcome', settings.welcome.text, sent)];
    }
  }
  return [];
}

// The quick questions a student sees (no answers until they tap one).
async function quickQuestions(inbox) {
  const settings = await AutoReply.findById(inbox).select('faqs').lean();
  return (settings?.faqs ?? []).map(f => ({ _id: String(f._id), question: f.question }));
}

// A tapped quick question: the question as the student's message and the
// office's saved answer right after. Returns [question, answer] or null.
async function askQuickQuestion(inbox, student, faqId, now = new Date()) {
  const settings = await AutoReply.findById(inbox).select('faqs').lean();
  const faq = (settings?.faqs ?? []).find(f => String(f._id) === String(faqId));
  if (!faq) return null;
  const question = await Message.create({ studentNumber: student.studentNumber, inbox, from: 'student', authorEmail: student.email, authorName: student.name, body: faq.question, readAt: now });
  const answer = await autoMessage(inbox, student.studentNumber, 'faq', faq.answer, question);
  return [question, answer];
}

module.exports = { matchFaq, replyAfter, quickQuestions, askQuickQuestion, parseSettings, settingsView, inOfficeHours };
