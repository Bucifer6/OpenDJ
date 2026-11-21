// Small JSON persistence for AI MC: config, personas, memory (what the AI has "learned"), chat log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.AIMC_DATA || path.join(ROOT, 'data');
fs.mkdirSync(path.join(DATA, 'audio'), { recursive: true });

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(fallback); }
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const DEFAULT_CONFIG = readJson(path.join(ROOT, 'config.default.json'), {});
const CONFIG_FILE = path.join(DATA, 'config.json');

export function loadConfig() {
  const c = readJson(CONFIG_FILE, {});
  const merged = { ...DEFAULT_CONFIG, ...c, tts: { ...DEFAULT_CONFIG.tts, ...c.tts }, auto: { ...DEFAULT_CONFIG.auto, ...c.auto } };
  if (process.env.OLLAMA_URL) merged.ollamaUrl = process.env.OLLAMA_URL;
  if (process.env.OLLAMA_MODEL) merged.model = process.env.OLLAMA_MODEL;
  return merged;
}
export function saveConfig(c) {
  // values that only came from environment variables are not written into config.json
  const out = { ...c }, prev = readJson(CONFIG_FILE, {});
  if (process.env.OLLAMA_URL && c.ollamaUrl === process.env.OLLAMA_URL) out.ollamaUrl = prev.ollamaUrl ?? DEFAULT_CONFIG.ollamaUrl;
  if (process.env.OLLAMA_MODEL && c.model === process.env.OLLAMA_MODEL) out.model = prev.model ?? DEFAULT_CONFIG.model;
  writeJson(CONFIG_FILE, out);
}

// Personas: built-in ones live in ai-mc/personas, edited copies in data/personas (so updates never overwrite yours).
const BUILTIN_P = path.join(ROOT, 'personas');
const USER_P = path.join(DATA, 'personas');
export function listPersonas() {
  const out = {};
  for (const dir of [BUILTIN_P, USER_P]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) {
      const p = readJson(path.join(dir, f), null);
      if (p?.id) out[p.id] = p;
    }
  }
  return out;
}
export function savePersona(p) {
  const id = String(p.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!id) throw new Error('Persona fără id');
  writeJson(path.join(USER_P, id + '.json'), { ...p, id });
  return { ...p, id };
}

// Memory: facts about friends + liked outputs (the "teaching" data).
const MEM_FILE = path.join(DATA, 'memory.json');
export function loadMemory() { return readJson(MEM_FILE, { friends: '', liked: [] }); }
export function saveMemory(m) { writeJson(MEM_FILE, m); }
