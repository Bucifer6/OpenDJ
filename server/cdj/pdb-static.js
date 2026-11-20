// Fixed content that rekordbox writes into every export.pdb, independent of the music.
// Values observed in rekordbox-generated exports (an empty export and a two-track export written by
// rekordbox 6 are byte-identical in these tables). They configure the player's browse menus:
// table 16 names the categories (GENRE, ARTIST, ALBUM, TRACK, KEY, PLAYLIST, HISTORY, SEARCH, FOLDER…),
// tables 17 and 18 say which categories / sort columns are shown and in which order.

/** Table type numbers (Kaitai `page_type`). */
export const T = {
  tracks: 0, genres: 1, artists: 2, albums: 3, labels: 4, keys: 5, colors: 6, playlistTree: 7, playlistEntries: 8,
  unknown9: 9, unknown10: 10, historyPlaylists: 11, historyEntries: 12, artwork: 13, unknown14: 14, unknown15: 15,
  columns: 16, menu17: 17, menu18: 18, history: 19,
};
export const TABLE_COUNT = 20;

/** Track colour labels: row id = colour shown on rekordbox / CDJs (1 pink … 8 purple). */
export const COLORS = [
  [1, 'Pink'], [2, 'Red'], [3, 'Orange'], [4, 'Yellow'], [5, 'Green'], [6, 'Aqua'], [7, 'Blue'], [8, 'Purple'],
];

/** Table 16 ("columns"): [id, code, label]. Labels are wrapped in U+FFFA … U+FFFB by rekordbox. */
export const COLUMNS = [
  [1, 128, 'GENRE'], [2, 129, 'ARTIST'], [3, 130, 'ALBUM'], [4, 131, 'TRACK'], [5, 133, 'BPM'], [6, 134, 'RATING'],
  [7, 135, 'YEAR'], [8, 136, 'REMIXER'], [9, 137, 'LABEL'], [10, 138, 'ORIGINAL ARTIST'], [11, 139, 'KEY'],
  [12, 141, 'CUE'], [13, 142, 'COLOR'], [14, 146, 'TIME'], [15, 147, 'BITRATE'], [16, 148, 'FILE NAME'],
  [17, 132, 'PLAYLIST'], [18, 152, 'HOT CUE BANK'], [19, 149, 'HISTORY'], [20, 145, 'SEARCH'], [21, 150, 'COMMENTS'],
  [22, 140, 'DATE ADDED'], [23, 151, 'DJ PLAY COUNT'], [24, 144, 'FOLDER'], [25, 161, 'DEFAULT'], [26, 162, 'ALPHABET'],
  [27, 170, 'MATCHING'],
];

/** Table 17: browse menu items, four u16 each. */
export const MENU17 = [
  [1, 1, 355, 0], [5, 6, 261, 0], [6, 7, 355, 0], [7, 8, 355, 0], [8, 9, 355, 0], [9, 10, 355, 0], [10, 11, 355, 0],
  [13, 15, 355, 0], [14, 19, 260, 0], [15, 20, 262, 0], [16, 21, 355, 0], [18, 23, 355, 0], [2, 2, 2, 1], [3, 3, 3, 2],
  [4, 4, 1, 3], [11, 12, 99, 4], [17, 5, 99, 5], [19, 22, 99, 6], [20, 18, 99, 7], [27, 26, 611, 8], [24, 17, 99, 9],
  [22, 27, 99, 10],
];

/** Table 18: track list sort / info columns, four u16 each. */
export const MENU18 = [
  [1, 6, 1, 0], [21, 7, 1, 0], [14, 8, 1, 0], [8, 9, 1, 0], [9, 10, 1, 0], [10, 11, 1, 0], [15, 13, 1, 0], [13, 15, 1, 0],
  [23, 16, 1, 0], [22, 17, 1, 0], [25, 0, 256, 0], [26, 1, 512, 0], [2, 2, 768, 0], [3, 3, 1024, 0], [5, 4, 1280, 0],
  [6, 5, 1536, 0], [11, 12, 1792, 0],
];

/**
 * Table 19 ("history" sync data): rekordbox writes one 40-byte row holding the export date and "1000".
 * Layout not documented; reproduced as observed, with today's date. Bytes 0x0c..0x16 hold the date string.
 */
export function historyRow(date) {
  const b = Buffer.from('80020000000000000000000017323032322d30322d3032191e0b3130303003000000000000000000', 'hex');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '2000-01-01';
  b.write(d, 0x0d, 'latin1');
  return b;
}
