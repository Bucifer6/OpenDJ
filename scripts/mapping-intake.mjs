#!/usr/bin/env node
// Turns controller issues (made by the Controller Mapper or by hand from .github/ISSUE_TEMPLATE/controller-*.yml) into
// changes under mappings/, for the "Controller mapping intake" workflow (.github/workflows/mapping-intake.yml):
//
//   new mapping    → adds mappings/<Brand>/<Brand>-<Model>.opendj-midi.json (status: needs verification)
//   change / fix   → replaces the entries of the existing mapping and clears its verifications (needs verification)
//   problem report → no file change; labelled needs-verification for someone with the controller to confirm
//   verification   → adds the issue author to contributed.verifiedBy (not when they made or changed the mapping)
//   request        → adds the controller to mappings/requested.json ("needs a mapping")
//
// Everything in the issue is untrusted: the mapping is validated with scripts/lib/mapping-schema.mjs and only known
// fields are copied. This script never runs anything from the issue; the workflow commits the files and opens a PR
// that a maintainer reviews and merges.
//
// CLI (in the workflow): node scripts/mapping-intake.mjs <event.json> <result.json>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mappingErrors, cleanEntries, cleanContributed, mappingPath, slug, NAME_RE } from './lib/mapping-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Issue-form body → { 'Heading': 'value' } ("_No response_" becomes ''). */
export function parseForm(body) {
  const out = {};
  const parts = String(body || '').replace(/\r\n/g, '\n').split(/^### +/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    let val = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    if (val === '_No response_') val = '';
    out[head] = val;
  }
  return out;
}

/** Which kind of controller issue this is, from its labels or title (the Mapper sets both). */
export function issueKind(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const t = String(issue.title || '');
  if (labels.includes('controller-request') || /^Add controller:/i.test(t)) return 'request';
  if (labels.includes('controller-verification') || /^Verified mapping:/i.test(t)) return 'verify';
  if (labels.includes('controller-change') || /^Mapping (change|problem):/i.test(t)) return 'change';
  if (labels.includes('controller-mapping') || /^Controller mapping:/i.test(t)) return 'new';
  return null;
}

const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/files\/\d+\/[\w.%-]+\.json/;
/** The mapping JSON from the form: a ```json block, else a .json file attached to the issue. */
export async function mappingFromForm(text, fetchImpl = fetch) {
  if (!text) return null;
  const block = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const raw = block ? block[1] : text.trim().startsWith('{') ? text.trim() : null;
  if (raw) return JSON.parse(raw);
  const url = ATTACHMENT.exec(text)?.[0];
  if (!url) return null;
  const r = await fetchImpl(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`couldn't download the attached file (HTTP ${r.status})`);
  const body = await r.text();
  if (body.length > 1024 * 1024) throw new Error('the attached file is larger than 1 MB');
  return JSON.parse(body);
}

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const field = (form, ...names) => { for (const n of names) if (form[n] != null) return form[n]; return ''; };
const agreed = (form) => /- \[x\]/i.test(field(form, 'Licence', 'License'));
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/** Finds an existing community mapping file for brand + model (any file name). */
function findMapping(root, brand, model, mappingFiles) {
  for (const f of mappingFiles(join(root, 'mappings'))) {
    const c = readJson(f, {}).contributed || {};
    if (slug(c.brand || '', c.model || '') === slug(brand, model)) return f;
  }
  return null;
}

/**
 * Process one issue. Writes files under `root` and returns what the workflow should do:
 * { action: 'pr', branch, title, body, comment } | { action: 'comment', comment, labels? } | { action: 'none' }
 */
export async function processIssue(issue, { root = ROOT, ids, mappingFiles, fetchImpl = fetch } = {}) {
  const kind = issueKind(issue);
  if (!kind) return { action: 'none' };
  const form = parseForm(issue.body);
  const who = `@${issue.user?.login || 'unknown'}`;
  const login = String(issue.user?.login || '').toLowerCase();
  const brand = cleanName(field(form, 'Brand')), model = cleanName(field(form, 'Model'));
  const n = issue.number;
  const branch = `mapping-intake/issue-${n}`;
  const fail = (why) => ({ action: 'comment', comment: `Thanks! The controller bot couldn't process this yet: ${why}\n\nEdit the issue to fix it and the bot will try again, or a maintainer will help.` });
  if (!NAME_RE.test(brand) || !NAME_RE.test(model)) return fail('the brand and model are missing or contain unusual characters.');
  const name = `${brand} ${model}`;
  const existing = findMapping(root, brand, model, mappingFiles);

  if (kind === 'request') {
    const file = join(root, 'mappings', 'requested.json');
    const req = readJson(file, { controllers: [] });
    if (existing || req.controllers.some((c) => slug(c.brand, c.model) === slug(brand, model))) {
      return { action: 'comment', comment: `${name} is already in the controller list. Thanks!` };
    }
    const midi = cleanName(field(form, 'MIDI name')).slice(0, 80);
    req.controllers.push({ brand, model, midiNames: midi ? [midi] : [], requestedBy: who, issue: n });
    req.controllers.sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`));
    writeJson(file, req);
    return { action: 'pr', branch, title: `Add ${name} to the controller list`, body: `Adds **${name}** to \`mappings/requested.json\` ("needs a mapping"), requested by ${who}.\n\nCloses #${n}`,
      comment: `Thanks ${who}! A pull request adding ${name} to the controller list is open for review.` };
  }

  if (kind === 'verify') {
    if (!existing) return fail(`there is no community mapping for ${name} in mappings/ to verify. (Built-in presets are checked by maintainers.)`);
    const m = readJson(existing, null);
    const c = m.contributed || {};
    const involved = [c.author, ...(c.changedBy || [])].map((x) => String(x || '').replace(/^@/, '').toLowerCase());
    if (involved.includes(login)) return { action: 'comment', comment: `Thanks ${who}! A mapping needs to be verified by someone other than the people who made or changed it, so this doesn't count as a verification. Ask a friend with a ${name}!` };
    c.verifiedBy = [...new Set([...(c.verifiedBy || []), who])];
    const tested = cleanName(field(form, 'Tested on'));
    if (tested && !c.testedOn?.includes(tested)) c.testedOn = c.testedOn ? `${c.testedOn}; ${tested}` : tested;
    m.contributed = cleanContributed(c);
    writeJson(existing, m);
    return { action: 'pr', branch, title: `Verify the ${name} mapping`, body: `${who} tested the **${name}** mapping and reports that it works.\n\nCloses #${n}`,
      comment: `Thanks for testing, ${who}! A pull request marking the ${name} mapping as verified is open for review.` };
  }

  // new mapping, change or problem report
  let m;
  try { m = await mappingFromForm(field(form, 'Mapping', 'Mapping file', 'Files'), fetchImpl); } catch (e) { return fail(`the mapping isn't valid JSON (${e.message}).`); }
  if (!m) {
    if (kind === 'change') return { action: 'comment', labels: ['needs-verification'], comment: `Thanks ${who}! This problem report needs someone else with a ${name} to confirm it. If you can fix it, open the mapping in the Controller Mapper, correct the controls and submit the fix.` };
    return fail('no mapping was found. Paste the mapping into the Mapping box, or attach the .opendj-midi.json file.');
  }
  if (!agreed(form)) return fail('the CC0 licence box is not ticked, so the mapping can\'t be added to OpenDJ.');
  const prev = existing ? readJson(existing, {}) : null;
  const pc = prev?.contributed || {};
  const contributed = existing
    ? cleanContributed({ ...pc, changedBy: [...(pc.changedBy || []), who], verifiedBy: [], notes: pc.notes })
    : cleanContributed({ ...(m.contributed || {}), brand, model, author: who, testedOn: field(form, 'Tested on') || m.contributed?.testedOn,
      notes: field(form, 'Notes') || m.contributed?.notes, midiNames: [field(form, 'MIDI name'), ...(m.contributed?.midiNames || [])], verifiedBy: [] });
  const out = { opendjMidiMapping: 1, device: typeof m.device === 'string' ? m.device.slice(0, 120) : (prev?.device || ''), name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 120) : name,
    contributed, entries: Array.isArray(m.entries) ? m.entries : [] };
  const errs = mappingErrors(out, ids);
  if (errs.length) return fail(`the mapping has problems:\n\n${errs.slice(0, 20).map((e) => `- ${e}`).join('\n')}${errs.length > 20 ? `\n- …and ${errs.length - 20} more` : ''}`);
  out.entries = cleanEntries(out.entries);
  const rel = existing ? existing.slice(join(root, 'mappings').length + 1).replace(/\\/g, '/') : mappingPath(brand, model);
  writeJson(join(root, 'mappings', rel), out);
  const verifyNote = 'It is marked **needs verification** until someone else with this controller tests it (Controller Mapper → *It works: verify it*).';
  return existing
    ? { action: 'pr', branch, title: `Update the ${name} mapping`, body: `Changes to \`mappings/${rel}\` from ${who} (${out.entries.length} controls).\n\n${verifyNote}\n\nCloses #${n}`,
      comment: `Thanks ${who}! A pull request with your changes to the ${name} mapping is open. ${verifyNote}` }
    : { action: 'pr', branch, title: `Add a mapping for ${name}`, body: `New mapping \`mappings/${rel}\` from ${who} (${out.entries.length} controls).\n\n${verifyNote}\n\nCloses #${n}`,
      comment: `Thanks ${who}! A pull request adding your ${name} mapping is open for review. ${verifyNote}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [eventFile, resultFile] = process.argv.slice(2);
  const { targetList, mappingFiles } = await import('./build-controller-mapper.mjs');
  const event = JSON.parse(readFileSync(eventFile, 'utf8'));
  let res;
  try { res = await processIssue(event.issue, { ids: new Set(targetList().map((t) => t.id)), mappingFiles }); } catch (e) { res = { action: 'comment', comment: `The controller bot hit an error: ${e.message}. A maintainer will take a look.` }; }
  writeFileSync(resultFile, JSON.stringify(res, null, 2));
  console.log(res.action, res.title || '');
  if (!existsSync(resultFile)) process.exit(1);
}
