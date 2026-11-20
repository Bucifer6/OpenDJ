#!/usr/bin/env node
// Browser mode: `npm run web` then open the printed URL in Chrome/Edge (Web MIDI + audio output selection need Chromium).
import { start } from './index.js';

const port = Number(process.env.PORT || process.argv[2] || 7380);
const app = await start({ port, dataDir: process.env.OPENDJ_DATA });
console.log(`OpenDJ running at ${app.url}`);
console.log(`Library data: ${app.library.dataDir}`);
const stop = () => { app.shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
