// Explicit words in messages (English and Filipino / Taglish). A message
// with one isn't sent; the sender is told which word to remove (shown as
// "f***"). Mirrors src/utils/profanity.ts in the frontend (which warns while
// typing) — keep the two lists the same.
//
// Matching ignores case and catches common disguises: repeated letters
// ("fuuuck"), look-alike characters ("sh1t", "@ss") and dots / dashes /
// stars between letters ("f.u.c.k"). Each word only matches on its own, so
// "class", "computation", "leche flan" and "cum laude" are fine.
//
// Each entry: [word, how it may extend]
//   'word'   only on its own ("ass", not "class")
//   'start'  may have more letters after ("fucking", "bitches")
//   'any'    may also sit inside a longer word ("motherfucker")
// A space in a word also matches no space ("tang ina", "tangina").

const WORDS = [
  // English
  ['fuck', 'any'], ['fck', 'start'], ['fuk', 'start'], ['wtf', 'word'], ['stfu', 'word'],
  ['shit', 'start'], ['bullshit', 'start'], ['bitch', 'start'], ['bastard', 'start'],
  ['asshole', 'start'], ['ass', 'word'], ['dumbass', 'word'], ['jackass', 'word'],
  ['cunt', 'start'], ['dickhead', 'word'], ['cock', 'word'], ['pussy', 'word'],
  ['slut', 'start'], ['whore', 'start'], ['porn', 'start'], ['nigger', 'start'], ['nigga', 'start'],
  ['faggot', 'start'], ['retard', 'word'], ['retarded', 'word'], ['motherfucker', 'start'],
  // Filipino / Taglish
  ['putangina', 'start'], ['putang ina', 'start'], ['tangina', 'start'], ['tang ina', 'word'],
  ['pukinangina', 'start'], ['puta', 'word'], ['putragis', 'start'], ['punyeta', 'start'],
  ['pakyu', 'start'], ['pakshet', 'start'], ['gago', 'start'], ['ulol', 'word'], ['olol', 'word'],
  ['tarantado', 'start'], ['bobo', 'word'], ['tanga', 'word'], ['kupal', 'start'], ['pokpok', 'start'],
  ['kantot', 'start'], ['jakol', 'start'], ['hindot', 'start'], ['burat', 'word'], ['pekpek', 'start'],
  ['puke', 'word'], ['tite', 'word'], ['inamo', 'word'], ['bwakanangina', 'start'],
];

// Look-alikes for each letter.
const LOOKALIKE = { a: 'a4@', e: 'e3', i: 'i1!', o: 'o0', s: 's5$', t: 't7', g: 'g9' };
const SEP = '[._*\\-]*';

function letterPattern(ch) {
  if (ch === ' ') return '[\\s._*\\-]*';
  const set = LOOKALIKE[ch] ?? ch; // nothing in these sets needs escaping inside [ ]
  return `[${set}]+`;
}

const PATTERNS = WORDS.map(([word, extend]) => {
  const body = [...word].map((ch, i) => (i && ch !== ' ' && word[i - 1] !== ' ' ? SEP : '') + letterPattern(ch)).join('');
  const before = extend === 'any' ? '' : '(?<![\\p{L}\\p{N}])';
  const after = extend === 'word' ? '(?![\\p{L}\\p{N}])' : '';
  return { word, re: new RegExp(`${before}${body}${after}`, 'iu') };
});

// Innocent words that look like one of the above ("shiitake"), removed
// before checking. "Dick" alone isn't listed at all (Senator Dick Gordon).
const ALLOWED = /(?<![\p{L}])(shiitake|shitake)(?![\p{L}])/giu;

const mask = word => word.replace(/ /g, '').replace(/^(.)(.*)$/, (m, a, rest) => a + '*'.repeat(rest.length));

// The explicit words in a text, masked ("f***"), or [] when there are none.
function findExplicitWords(text) {
  const t = String(text || '').normalize('NFKC').replace(ALLOWED, ' ');
  if (!t.trim()) return [];
  return [...new Set(PATTERNS.filter(p => p.re.test(t)).map(p => mask(p.word)))];
}

module.exports = { findExplicitWords };
