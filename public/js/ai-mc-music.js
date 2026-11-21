// Which tracks the AI DJ may pick: genres, "Romanian only", include / exclude words.
// Shared by the AI MC server (ai-mc/server.js imports it) and the OpenDJ bridge page, so both count the same.
// filter: { genres: ['manele', 'dance'], romanian: bool, include: 'word, word', exclude: 'word, word' }

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[șş]/g, 's').replace(/[țţ]/g, 't');

const words = (s) => norm(s).split(/[,;]+/).map((w) => w.trim()).filter(Boolean);

/** Genre tags of a track: "Pop; Dance / Manele" → ['pop', 'dance', 'manele'] */
export const genresOf = (t) => norm(t.genre).split(/\s*[;,/|]\s*|\s+&\s+/).map((g) => g.trim()).filter((g) => g && g.length < 40);

const RO_GENRE = /manele|lautar|populara|folclor|folk ro|romanian|romaneasc|romanesti|etno|doina|hora|petrecere|muzica usoara/;
const RO_PATH = /[\\/](manele|romanesti?|romaneasca|lautaresti|populara|muzica romaneasca|ro|romania|petrecere)[\\/ _-]/i;
const RO_CHARS = /[ăâîșțşţĂÂÎȘȚŞŢ]/;
// words that are typical for Romanian titles and rare in other languages
const RO_WORDS = /\b(inima|iubire|iubirea|dragoste|dragostea|viata|frate|fratele|suflet|sufletul|noapte|mea|meu|esti|sunt|vreau|fara|pentru|doar|acum|mama|tata|dor|ochii|bani|banii|dusmani|dusmanii|norocul|cand|mult|nimeni|lume|lumea|niciodata|dulce|sarut|sarutul|tau|tale|mele|iti|imi|tine|mine|ochi|lacrimi|inimioara|puiut|iubito|iubita|frumoasa|zi|seara|astazi|maine|nunta|petrecere|lautar|hora|sarba|cantec|dans|tara|casa|drag|draga|doamne|singur|singura|nebun|nebuna|din|pe|nu|sub|dincolo|nori|intre|langa|catre|cum|unde|cine|sau|toata|toate|noi|voi|aici|acolo|ploaia|soare|vara|iarna|vis|visul|cert|ma)\b/;
// Romanian clitics with a hyphen: "Dulce-i", "nu-mi", "ce-ți", "s-a", "m-ai"
const RO_HYPHEN = /\b\w+-(mi|ti|i|l|o|ai|am|a|ti-ai)\b|\b(nu|ce|sa|s|m|v|n|l|i|te|ma)-\w+/;

export function isRomanian(t) {
  if (RO_GENRE.test(norm(t.genre))) return true;
  const text = `${t.artist || ''} ${t.title || ''}`;
  if (RO_CHARS.test(text)) return true;
  if (RO_WORDS.test(norm(text)) || RO_HYPHEN.test(norm(t.title))) return true;
  return RO_PATH.test(String(t.path || t.localPath || t.fileName || ''));
}

// ------------------------------------------------------------------ language guess from title / artist / genre
const NON_LATIN = /[Ͱ-ϿЀ-ӿԀ-ԯ֐-׿؀-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/;
const ES_CHARS = /[ñÑ¿¡]/;                       // only Spanish
const ES_ACCENTS = /[áíóúÁÍÓÚ]/;                  // Spanish (also Portuguese / Italian, weaker hint)
const OTHER_CHARS = /[çßäöüëïøåæœèêàùòõãÿ]/i;     // German, French, Italian, Portuguese, Nordic…
const TURKISH = /[ıİğĞ]/; // Turkish also has ş / Ş like (old) Romanian: decide on these first
const ES_WORDS = new RegExp('\\b(' + [
  'el', 'los', 'las', 'que', 'corazon', 'amor', 'mi', 'por', 'para', 'mucho', 'vida', 'loca', 'loco', 'bonita', 'quiero', 'gente', 'mujer', 'fiesta',
  'noche', 'chica', 'besame', 'tengo', 'contigo', 'como', 'dime', 'baila', 'bailar', 'despacito', 'te quiero', 'mi amor', 'yo', 'esta', 'eres',
  'muchacha', 'caliente', 'sol', 'playa', 'isla', 'cancion', 'corazon', 'sin', 'con', 'una', 'otra', 'vez', 'nada', 'todo', 'siempre', 'nunca',
  'ritmo', 'reggaeton', 'macarena', 'gasolina', 'bamboleo', 'aserejé', 'asereje', 'salsa', 'cumbia', 'bachata', 'senorita', 'hermosa', 'cielo',
].join('|') + ')\\b|\\b\\w+(ando|iendo|ito|ita|ción|cion)\\b');
const FOREIGN_WORDS = new RegExp('\\b(' + [
  // German
  'der', 'die', 'das', 'und', 'nicht', 'ich', 'du', 'hast', 'ein', 'eine', 'mein', 'liebe', 'nein', 'schatz', 'herz', 'luftballons', 'sonne', 'zeit',
  // French
  'je', 'les', 'des', 'une', 'pas', 'moi', 'toi', 'pour', 'encore', 'aime', 'aimes', 'tu m', 'qui', 'oui', 'nous', 'vous', 'mais', 'tout', 'rien', 'alors', 'danse', 'chanson', 'amour', 'mon', 'ma vie', 'tous', 'avec', 'c\'est', 'cest',
  // Italian
  'il', 'che', 'sono', 'della', 'questo', 'bella', 'amore', 'cuore', 'notte', 'ragazza', 'ciao', 'tutto', 'piu', 'cosa', 'sempre',
  // Turkish / Arabic (latin)
  'bir', 'seni', 'sevda', 'olsun', 'habibi', 'yalla',
].join('|') + ')\\b|\\b\\w+(ando|iendo|ito|ita)\\b');
const EN_WORDS = /\b(the|you|love|me|my|i|baby|your|of|and|in|on|for|to|is|it|we|don't|dont|night|heart|girl|boy|dance|feel|time|life|like|all|be|with|what|when|this|that|go|get|let|come|one|no|yeah|oh|up|down|world|tonight|forever|again|never|remix|mix|edit|version|feat)\b/;

/** 'ro' | 'en' | 'es' | 'other' – a best guess from the tags (there is no language field in music files). */
export function languageOf(t) {
  const text = `${t.artist || ''} ${t.title || ''}`;
  if (NON_LATIN.test(text) || TURKISH.test(text)) return 'other';
  if (isRomanian(t)) return 'ro';
  // score the title (the artist name says little about the song's language)
  const title = t.title || text, n = norm(title);
  const count = (re) => (n.match(new RegExp(re.source, 'g')) || []).length;
  const es = count(ES_WORDS) + (ES_CHARS.test(title) ? 2 : 0) + (ES_ACCENTS.test(title) ? 1 : 0);
  const other = count(FOREIGN_WORDS) + (OTHER_CHARS.test(title) ? 2 : 0);
  const en = count(EN_WORDS);
  if (es && es >= other && es >= en) return 'es';
  if (other && other >= en) return 'other';
  return 'en'; // plain Latin letters without foreign marks: most often English
}

/** Does the track fit the DJ's music filter? (empty filter = everything) */
export function musicMatch(t, f) {
  if (!f) return true;
  const hay = norm(`${t.artist || ''} ${t.title || ''} ${t.genre || ''} ${t.album || ''} ${t.path || t.fileName || ''}`);
  const ex = words(f.exclude);
  if (ex.length && ex.some((w) => hay.includes(w))) return false;
  const gs = (f.genres || []).map(norm).filter(Boolean);
  if (gs.length) {
    const tg = genresOf(t), g = norm(t.genre);
    if (!gs.some((x) => tg.includes(x) || g.includes(x))) return false;
  }
  if (f.romanian && !isRomanian(t)) return false;
  const langs = Array.isArray(f.languages) ? f.languages : [];
  if (langs.length && langs.length < 4 && !langs.includes(languageOf(t))) return false;
  const inc = words(f.include);
  if (inc.length && !inc.some((w) => hay.includes(w))) return false;
  return true;
}

const langLimited = (f) => Array.isArray(f?.languages) && f.languages.length > 0 && f.languages.length < 4;
export const filterActive = (f) => !!f && ((f.genres || []).length > 0 || !!f.romanian || langLimited(f) || !!words(f.include).length || !!words(f.exclude).length);

const LANG = { ro: 'română', en: 'engleză', es: 'spaniolă', other: 'alte limbi' };
/** Short human description, e.g. "Manele, Dance · română + engleză · fără: christmas" */
export function describe(f) {
  if (!filterActive(f)) return 'toată colecția';
  return [(f.genres || []).join(', '), f.romanian ? 'doar muzică românească' : '', langLimited(f) ? f.languages.map((l) => LANG[l] || l).join(' + ') : '',
    words(f.include).length ? `cu: ${f.include}` : '', words(f.exclude).length ? `fără: ${f.exclude}` : ''].filter(Boolean).join(' · ');
}
