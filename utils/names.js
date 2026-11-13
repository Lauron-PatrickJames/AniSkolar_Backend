// Names as people write them: "PATRICK JAMES Secuya LAURON" (the
// Microsoft account's capitals with a typed middle name) becomes "Patrick
// James Secuya Lauron". A name all in capitals (or lowercase) is title-cased
// as a whole; in a mixed one only the words in capitals change, so "dela
// Cruz" and "McDonald" stay as typed. Same as titleCaseName() in the
// frontend's src/utils/names.ts.

const ROMAN = /^(II|III|IV|VI|VII|VIII)$/;

function fix(text) {
  return text
    .toLowerCase()
    .replace(/(^|[\s\-'’(])([a-zà-ÿ])/g, (_m, before, ch) => before + ch.toUpperCase())
    .replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii)\b/g, m => m.toUpperCase());
}

function properName(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!letters) return s;
  if (letters === letters.toUpperCase() || letters === letters.toLowerCase()) return fix(s);
  return s.split(' ').map(word => {
    const w = word.replace(/[^A-Za-zÀ-ÿ]/g, '');
    return w.length >= 2 && w === w.toUpperCase() && !ROMAN.test(w) ? fix(word) : word;
  }).join(' ');
}

module.exports = { properName };
