#!/usr/bin/env node
// Browser / server mode: `npm run web` then open the printed URL in Chrome/Edge (Web MIDI + audio output selection need Chromium).
//
//   node server/cli.js [port] [--host 0.0.0.0] [--port 7380]
//   HOST, PORT, OPENDJ_DATA, OPENDJ_PASSWORD, OPENDJ_MUSIC_ROOTS, OPENDJ_ALLOWED_HOSTS, OPENDJ_FFMPEG, OPENDJ_AUTH=1
//
// Binding to anything but loopback (e.g. HOST=0.0.0.0 on a NAS) turns on password login.
import { start, isLoopback } from './index.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); if (i >= 0) return args[i + 1]; const eq = args.find((a) => a.startsWith(`--${name}=`)); return eq ? eq.split('=').slice(1).join('=') : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !args[i - 1].includes('=')));

const port = Number(flag('port') || process.env.PORT || positional[0] || 7380);
const host = flag('host') || process.env.HOST || '127.0.0.1';
const app = await start({ port, host, dataDir: process.env.OPENDJ_DATA, auth: args.includes('--auth') || undefined });
console.log(`OpenDJ running at ${app.url}`);
console.log(`Library data: ${app.library.dataDir}`);
if (!isLoopback(host)) console.log('Hosted mode: password login is required; file access is limited to the allowed music folders.');
else if (app.auth.enabled) console.log('Password login is enabled.');
const stop = () => { app.shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
