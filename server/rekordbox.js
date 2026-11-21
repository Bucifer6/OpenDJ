// rekordbox XML import/export: public/js/shared/rekordbox.js (shared with the mobile app), with fast-xml-parser.
import { XMLParser } from 'fast-xml-parser';
import { parseRekordboxXmlWith } from '../public/js/shared/rekordbox.js';

export * from '../public/js/shared/rekordbox.js';
export const parseRekordboxXml = (xmlString) => parseRekordboxXmlWith(XMLParser, xmlString);
