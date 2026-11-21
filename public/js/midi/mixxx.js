// Mixxx controller mapping (.midi.xml) → OpenDJ mapping converter.
//
// Mixxx's community maintains mappings for hundreds of controllers (https://github.com/mixxxdj/mixxx, res/controllers,
// GPL-2.0+). OpenDJ never bundles them: the user fetches or picks a file and we translate it on their machine.
//
// What converts:
//  - plain <control>s: Mixxx [group] + key → OpenDJ target (play, cue, EQ, hot cues, loops, beat jumps, library…)
//  - options: invert, diff / selectknob / herc-jog (two's complement relative), rot64 / spread64 (offset-64 relative),
//    fourteen-bit-msb + fourteen-bit-lsb (combined into one 14-bit entry)
//  - <script-binding/> controls (Mixxx runs a JS function for these): mapped by heuristics on the function name and
//    description (jog wheels, touch, shift, play/cue/sync, pads…). Anything unrecognised is reported as unmapped.
//  - <output>s (LEDs): translated to { state, status, midino, on, off, min, max } entries that MidiManager lights.
import { parseXml, kids, kid, textOf, find } from './xml.js';

export const BEATLOOPS = [0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
export const BEATJUMPS = [0.5, 1, 2, 4, 8, 16, 32, 64];
export const ROLLS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];

const num = (s) => {
  if (s == null || s === '') return null;
  const t = String(s).trim();
  const v = /^0x/i.test(t) ? parseInt(t, 16) : Number(t);
  return Number.isFinite(v) ? v : null;
};
const hex = (n) => '0x' + n.toString(16).padStart(2, '0').toUpperCase();
const msgKey = (type, ch, n) => `${type}:${ch}:${n}`;
const fmtSize = (x) => String(Number(x));

/** MIDI status byte → { type, channel } or null for messages OpenDJ can't map (aftertouch, program change…). */
export function statusType(status) {
  const cmd = status & 0xf0, channel = status & 0x0f;
  if (cmd === 0x90 || cmd === 0x80) return { type: 'note', channel };
  if (cmd === 0xb0) return { type: 'cc', channel };
  if (cmd === 0xe0) return { type: 'pitch', channel };
  return null;
}

const deckOf = (group) => { const m = /^\[Channel(\d+)\]$/i.exec(group || ''); return m ? +m[1] : null; };
const T = (target, kind, extra) => ({ target, kind, ...extra });

/** Translate a (non-scripted) Mixxx [group] key pair to an OpenDJ target. Returns { target, kind } or null. */
export function mixxxTarget(group, key) {
  const g = group || '', k = key || '';
  let m;
  const deck = deckOf(g);
  if (deck) {
    if (deck > 4) return null;
    const P = `deck${deck}`, M = `mixer${deck}`;
    switch (k) {
      case 'play': case 'start_play': case 'play_stutter': case 'cue_play': return T(`${P}.play`, 'button');
      case 'cue_default': case 'cue_cdj': case 'cue_gotoandstop': case 'cue_set': case 'cue_simple': return T(`${P}.cue`, 'button');
      case 'sync_enabled': case 'beatsync': case 'beatsync_tempo': case 'beatsync_phase': return T(`${P}.sync`, 'button');
      case 'sync_leader': case 'sync_master': return T(`${P}.master`, 'button');
      case 'keylock': return T(`${P}.keylock`, 'button');
      case 'slip_enabled': return T(`${P}.slip`, 'button');
      case 'quantize': return T(`${P}.quantize`, 'button');
      case 'rate': return T(`${P}.tempo`, 'abs');
      case 'rate_set_default': case 'rate_set_zero': return T(`${P}.tempoReset`, 'button');
      case 'rate_temp_up': case 'rate_temp_up_small': return T(`${P}.bendUp`, 'button');
      case 'rate_temp_down': case 'rate_temp_down_small': return T(`${P}.bendDown`, 'button');
      case 'rate_perm_up': case 'rate_perm_up_small': return T(`${P}.tempoUp`, 'button');
      case 'rate_perm_down': case 'rate_perm_down_small': return T(`${P}.tempoDown`, 'button');
      case 'volume': return T(`${M}.volume`, 'abs');
      case 'pregain': return T(`${M}.trim`, 'abs');
      case 'pfl': return T(`${M}.cue`, 'button');
      case 'filterLow': return T(`${M}.eqLow`, 'abs');
      case 'filterMid': return T(`${M}.eqMid`, 'abs');
      case 'filterHigh': return T(`${M}.eqHigh`, 'abs');
      case 'LoadSelectedTrack': case 'LoadSelectedTrackAndPlay': return T(`${P}.load`, 'button');
      case 'eject': return T(`${P}.eject`, 'button');
      case 'reverse': return T(`${P}.reverse`, 'button');
      case 'reverseroll': return T(`${P}.censor`, 'button');
      case 'pitch_up': case 'pitch_up_small': return T(`${P}.keyUp`, 'button');
      case 'pitch_down': case 'pitch_down_small': return T(`${P}.keyDown`, 'button');
      case 'pitch': case 'pitch_adjust': return T(`${P}.keyKnob`, 'abs');
      case 'sync_key': return T(`${P}.keySync`, 'button');
      case 'reset_key': return T(`${P}.keyReset`, 'button');
      case 'jog': case 'wheel': return T(`${P}.jog`, 'rel', { rel: 'offset' });
      case 'scratch2': return T(`${P}.jog`, 'rel', { rel: 'auto' });
      case 'scratch2_enable': return T(`${P}.jogTouch`, 'button');
      case 'loop_in': case 'loop_in_goto': return T(`${P}.loopIn`, 'button');
      case 'loop_out': case 'loop_out_goto': return T(`${P}.loopOut`, 'button');
      case 'reloop_toggle': case 'reloop_exit': case 'reloop_andstop': case 'reloop_cue': case 'loop_exit': return T(`${P}.reloop`, 'button');
      case 'loop_halve': case 'beatloop_halve': return T(`${P}.loopHalve`, 'button');
      case 'loop_double': case 'beatloop_double': return T(`${P}.loopDouble`, 'button');
      case 'beatloop_activate': case 'beatloop_toggle': return T(`${P}.loopActivate`, 'button');
      case 'beatjump_forward': return T(`${P}.jumpFwd`, 'button');
      case 'beatjump_backward': return T(`${P}.jumpBack`, 'button');
      default: break;
    }
    if ((m = /^hotcue_(\d+)_(activate|gotoandplay|set|goto|gotoandstop|activatecue)$/.exec(k)) && +m[1] >= 1 && +m[1] <= 8) return T(`${P}.hotcue${m[1]}`, 'button');
    if ((m = /^hotcue_(\d+)_clear$/.exec(k)) && +m[1] >= 1 && +m[1] <= 8) return T(`${P}.hotcueClear${m[1]}`, 'button');
    if ((m = /^beatlooproll_([\d.]+)_activate$/.exec(k))) {
      const i = ROLLS.findIndex((r) => Math.abs(r - Number(m[1])) < 1e-6);
      if (i >= 0) return T(`${P}.roll${i + 1}`, 'button');
      if (BEATLOOPS.includes(Number(m[1]))) return T(`${P}.beatloop.${fmtSize(m[1])}`, 'button');
    }
    if ((m = /^beatloop_([\d.]+)(_toggle|_activate)?$/.exec(k)) && BEATLOOPS.includes(Number(m[1]))) return T(`${P}.beatloop.${fmtSize(m[1])}`, 'button');
    if ((m = /^beatjump_([\d.]+)_(forward|backward)$/.exec(k)) && BEATJUMPS.includes(Number(m[1]))) return T(`${P}.${m[2] === 'forward' ? 'jumpFwd' : 'jumpBack'}.${fmtSize(m[1])}`, 'button');
    return null;
  }
  if (/^\[(Master|Main|Mixer)\]$/i.test(g)) {
    if (k === 'crossfader') return T('mixer.crossfader', 'abs');
    if (k === 'gain' || k === 'volume') return T('master.volume', 'abs');
    if (k === 'headMix') return T('master.cueMix', 'abs');
    if (k === 'headGain' || k === 'headVolume') return T('master.hpVolume', 'abs');
    return null;
  }
  if (/^\[Headphone\]$/i.test(g)) {
    if (k === 'volume' || k === 'gain') return T('master.hpVolume', 'abs');
    if (k === 'mix') return T('master.cueMix', 'abs');
    return null;
  }
  if (/^\[Library\]$/i.test(g)) {
    if (k === 'MoveVertical' || k === 'ScrollVertical') return T('browser.scroll', 'rel', { rel: 'twos' });
    if (k === 'MoveUp' || k === 'ScrollUp') return T('browser.up', 'button');
    if (k === 'MoveDown' || k === 'ScrollDown') return T('browser.down', 'button');
    if (k === 'GoToItem') return T('browser.loadFirstStopped', 'button');
    return null;
  }
  if (/^\[Playlist\]$/i.test(g)) {
    if (k === 'SelectTrackKnob') return T('browser.scroll', 'rel', { rel: 'twos' });
    if (k === 'SelectNextTrack') return T('browser.down', 'button');
    if (k === 'SelectPrevTrack') return T('browser.up', 'button');
    if (k === 'LoadSelectedIntoFirstStopped') return T('browser.loadFirstStopped', 'button');
    return null;
  }
  if ((m = /^\[Sampler(\d+)\]$/i.exec(g))) {
    const n = (+m[1] - 1) % 8 + 1;
    if (/^(cue_gotoandplay|start_play|play|cue_default|hotcue_1_activate|cue_preview|start_stop)$/.test(k)) return T(`deck1.sampler${n}`, 'button');
    return null;
  }
  if ((m = /^\[EqualizerRack1_\[Channel(\d+)\]_Effect1\]$/i.exec(g)) && +m[1] <= 4) {
    const M = `mixer${m[1]}`;
    return { parameter1: T(`${M}.eqLow`, 'abs'), parameter2: T(`${M}.eqMid`, 'abs'), parameter3: T(`${M}.eqHigh`, 'abs') }[k] || null;
  }
  if ((m = /^\[QuickEffectRack1_\[Channel(\d+)\](_Effect1)?\]$/i.exec(g)) && +m[1] <= 4) {
    if (k === 'super1' || (m[2] && k === 'parameter1')) return T(`mixer${m[1]}.filter`, 'abs');
    return null;
  }
  if ((m = /^\[EffectRack1_EffectUnit(\d+)(_Effect\d+)?\]$/i.exec(g))) {
    const unit = +m[1];
    let mm;
    if ((mm = /^group_\[Channel(\d+)\]_enable$/.exec(k)) && +mm[1] <= 4) return T(`mixer${mm[1]}.fxOn`, 'button');
    if (unit > 4) return null;
    const M = `mixer${unit}`;
    if (!m[2]) return { mix: T(`${M}.fxMix`, 'abs'), super1: T(`${M}.fxParam`, 'abs'), enabled: T(`${M}.fxOn`, 'button') }[k] || null;
    return { enabled: T(`${M}.fxOn`, 'button'), meta: T(`${M}.fxParam`, 'abs'), parameter1: T(`${M}.fxParam`, 'abs'), parameter2: T(`${M}.fxParam2`, 'abs') }[k] || null;
  }
  if (/^\[Microphone\d*\]$/i.test(g)) {
    if (k === 'talkover') return T('mic.talkover', 'button');
    if (k === 'volume' || k === 'pregain') return T('mic.volume', 'abs');
    return null;
  }
  if (/^\[AutoDJ\]$/i.test(g) && k === 'enabled') return T('automix.toggle', 'button');
  if (/^\[Recording\]$/i.test(g) && k === 'toggle_recording') return T('record.toggle', 'button');
  return null;
}

/** Translate a Mixxx <output> (LED) to an OpenDJ state id (a target with LED state, or one of the extra states). */
export function mixxxState(group, key) {
  const deck = deckOf(group);
  let m;
  if (deck && deck <= 4) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    switch (key) {
      case 'play_indicator': case 'play': return `${P}.play`;
      case 'cue_indicator': case 'cue_default': return `${P}.cue`;
      case 'sync_enabled': return `${P}.sync`;
      case 'sync_leader': case 'sync_master': return `${P}.master`;
      case 'keylock': return `${P}.keylock`;
      case 'slip_enabled': return `${P}.slip`;
      case 'quantize': return `${P}.quantize`;
      case 'pfl': return `${M}.cue`;
      case 'loop_enabled': return `${P}.reloop`;
      case 'track_loaded': case 'track_samples': return `${P}.loaded`;
      case 'VuMeter': case 'vu_meter': case 'VuMeterL': case 'VuMeterR': case 'vu_meter_left': case 'vu_meter_right': return `${M}.vu`;
      case 'PeakIndicator': case 'peak_indicator': case 'PeakIndicatorL': case 'PeakIndicatorR': return `${M}.clip`;
      case 'reverse': return `${P}.reverse`;
      default: break;
    }
    if ((m = /^hotcue_(\d+)_(enabled|status|activate)$/.exec(key)) && +m[1] >= 1 && +m[1] <= 8) return `${P}.hotcue${m[1]}`;
    if ((m = /^beatloop_([\d.]+)_enabled$/.exec(key)) && BEATLOOPS.includes(Number(m[1]))) return `${P}.beatloop.${fmtSize(m[1])}`;
    return null;
  }
  if ((m = /^\[Sampler(\d+)\]$/i.exec(group || '')) && key === 'track_loaded') return `sampler${(+m[1] - 1) % 8 + 1}.loaded`;
  if (/^\[(Master|Main)\]$/i.test(group) && /^(VuMeter[LR]?|vu_meter(_left|_right)?)$/.test(key)) return 'master.vu';
  if (/^\[Microphone\d*\]$/i.test(group) && key === 'talkover') return 'mic.talkover';
  if ((m = /^\[EffectRack1_EffectUnit(\d+)\]$/i.exec(group || ''))) {
    let mm;
    if ((mm = /^group_\[Channel(\d+)\]_enable$/.exec(key)) && +mm[1] <= 4) return `mixer${mm[1]}.fxOn`;
    if (key === 'enabled' && +m[1] <= 4) return `mixer${m[1]}.fxOn`;
  }
  if (/^\[AutoDJ\]$/i.test(group) && key === 'enabled') return 'automix.toggle';
  if (/^\[Recording\]$/i.test(group) && key === 'status') return 'record.toggle';
  return null;
}

/**
 * Heuristics for <script-binding/> controls. `fn` is the script function (e.g. "PioneerDDJ400.jogTurn"), `desc` the
 * mapping's <description>. Returns { target, kind, rel?, part?: 'msb'|'lsb', indexed?: base } or null.
 * `indexed` targets get their pad number from the control's position among siblings sharing group+function.
 */
export function scriptTarget(group, fn, desc, type, channel) {
  const raw = String(fn || '').split('.').pop();
  const k = words(raw); // "PioneerDDJ400.tempoSliderMSB" → "tempo slider msb"
  const d = String(desc || '').toLowerCase();
  const w = `${k} ${d}`;
  let deck = deckOf(group);
  const samplerGroup = /^\[Sampler(\d+)\]$/i.exec(group || '');
  if (!deck && !samplerGroup && channel != null && channel < 4 && !/^\[(Master|Main|Mixer|Library|Playlist|Headphone|EffectRack|Microphone|AutoDJ|Recording)/i.test(group || '')) deck = channel + 1;
  if (deck > 4) return null;
  const P = deck ? `deck${deck}` : null, M = deck ? `mixer${deck}` : null;
  const isCtl = type === 'cc' || type === 'pitch';
  const part = /\bmsb\b/.test(k) ? 'msb' : /\blsb\b/.test(k) ? 'lsb' : undefined;
  const numIn = (s) => { const mm = /(\d+)(?!.*\d)/.exec(s); return mm ? +mm[1] : null; };
  const has = (re) => re.test(k);

  if (has(/\bshift\b/) && !has(/\b(jog|wheel|pads?|play|cue|sync|hot ?cues?|load|browse|loop|sampler)\b/)) return T('global.shift', 'button');
  if (has(/\b(jog|wheel|platter|scratch|turntable)\b/)) {
    if (!P) return null;
    if (has(/\btouch/) || (!isCtl && !has(/\b(turn|move|spin|rotat\w*)\b/))) return T(`${P}.jogTouch`, 'button');
    if (/\bsearch\b/.test(w)) return T(`${P}.jogSearch`, 'rel', { rel: 'auto' });
    if (/\b(ring|side|outer|edge)\b/.test(w) || (/pitch ?bend/.test(d) && !/platter/.test(d))) return T(`${P}.jogRing`, 'rel', { rel: 'auto' });
    return T(`${P}.jog`, 'rel', { rel: 'auto' });
  }
  if (isCtl && has(/\b(cross ?fader|xfader|crossfader)\b/)) return T('mixer.crossfader', 'abs', { part });
  if (isCtl && (has(/\b(tempo|rate|pitch)\b.*\b(slider|fader|msb|lsb)\b/) || has(/^(tempo|rate|pitch)$/))) return P ? T(`${P}.tempo`, 'abs', { part }) : null;
  if (has(/\b(browse|browser|library|tracklist|scroll)\b/) || (has(/\bselect\b/) && has(/\b(knob|encoder|turn|rotate)\b/))) {
    if (isCtl) return T('browser.scroll', 'rel', { rel: 'auto' });
    if (has(/\bload\b/)) return T('browser.loadFirstStopped', 'button');
    return null;
  }
  const fxGroup = /^\[EffectRack1_EffectUnit(\d+)/i.exec(group || '');
  if (fxGroup && +fxGroup[1] <= 4) {
    const FM = `mixer${fxGroup[1]}`;
    if (!isCtl && has(/\b(on off|onoff|enable|enabled|on)\b/)) return T(`${FM}.fxOn`, 'button');
    if (isCtl && has(/\b(level|depth|mix|dry wet|wet)\b/)) return T(`${FM}.fxMix`, 'abs', { part });
    if (isCtl && has(/\b(param|parameter|super|meta)\b/)) return T(`${FM}.fxParam`, 'abs', { part });
    return null;
  }
  if (samplerGroup && has(/\b(play|pads?|trigger|press(ed)?|sampler)\b/)) return T(`deck1.sampler${(+samplerGroup[1] - 1) % 8 + 1}`, 'button');
  if (!P) return null;
  if (has(/\bload\b/)) return T(`${P}.load`, 'button');
  if (has(/\bhot ?cues?\d*\b/)) { const n = numIn(k); return n && n <= 8 ? T(`${P}.hotcue${n}`, 'button') : T(`${P}.hotcue`, 'button', { indexed: true }); }
  if (has(/\bsampler\b/) && has(/\b(pads?|press(ed)?)\b/)) return T(`${P}.sampler`, 'button', { indexed: true });
  if (has(/\b(beat ?jump|beatjump|jump)\b/) && has(/\bpads?\b/)) return T(`${P}.beatjump`, 'button', { indexed: true });
  if (has(/\broll\b/) && has(/\bpads?\b/)) return T(`${P}.roll`, 'button', { indexed: true });
  if (has(/\bslicer\b/) && has(/\bpads?\b/)) return T(`${P}.slice`, 'button', { indexed: true });
  if (has(/\bpads?\d*\b/) && !isCtl) { const n = numIn(k); return n && n <= 8 ? T(`${P}.pad${n}`, 'button') : T(`${P}.pad`, 'button', { indexed: true }); }
  if (has(/\bplay\b/)) return T(`${P}.play`, 'button');
  if (has(/\bsync\b/)) return has(/\blong\b/) ? T(`${P}.master`, 'button') : T(`${P}.sync`, 'button');
  if (has(/\b(pfl|headphones?|phones)\b/)) return T(`${M}.cue`, 'button');
  if (has(/\bcue\b/) && !has(/\b(loop|call|point|mem|memory)\b/)) return T(`${P}.cue`, 'button');
  if (has(/\b(keylock|key lock|master tempo)\b/)) return T(`${P}.keylock`, 'button');
  if (has(/\bslip\b/)) return T(`${P}.slip`, 'button');
  if (has(/\bquantize\b/)) return T(`${P}.quantize`, 'button');
  if (has(/\b(reloop|loop exit|loop toggle)\b/)) return T(`${P}.reloop`, 'button');
  if (has(/\bloop in\b/)) return T(`${P}.loopIn`, 'button');
  if (has(/\bloop out\b/)) return T(`${P}.loopOut`, 'button');
  if (has(/\bloop\b/) && has(/\b(halve|half)\b/)) return T(`${P}.loopHalve`, 'button');
  if (has(/\bloop\b/) && has(/\bdouble\b/)) return T(`${P}.loopDouble`, 'button');
  if (isCtl && has(/\b(volume|ch fader|channel fader|line fader)\b/)) return T(`${M}.volume`, 'abs', { part });
  if (isCtl && has(/\bfilter\b/)) return T(`${M}.filter`, 'abs', { part });
  if (isCtl && has(/\b(trim|gain)\b/)) return T(`${M}.trim`, 'abs', { part });
  if (isCtl && has(/\b(eq )?(high|treble|hi)\b/)) return T(`${M}.eqHigh`, 'abs', { part });
  if (isCtl && has(/\b(eq )?mid\b/)) return T(`${M}.eqMid`, 'abs', { part });
  if (isCtl && has(/\b(eq )?(low|bass)\b/)) return T(`${M}.eqLow`, 'abs', { part });
  return null;
}

/** "tempoSliderMSB" → "tempo slider msb", "wheel_turn" → "wheel turn". */
export const words = (s) => String(s || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_\-.\s]+/g, ' ').trim().toLowerCase();

const OPTION_REL = { diff: 'twos', selectknob: 'twos', 'herc-jog': 'twos', 'herc-jog-fast': 'twos', rot64: 'offset', rot64inv: 'offset', rot64fast: 'offset', spread64: 'offset' };

/**
 * Convert a Mixxx .midi.xml mapping. Returns
 *   { name, author, description, forums, controllerId, source: 'mixxx', entries, outputs,
 *     unmapped: [{ group, key, midi, reason }], stats: { controls, mapped, scripted, scriptedMapped, unmapped, outputs, outputsMapped } }
 */
export function convertMixxx(xmlText) {
  const doc = parseXml(String(xmlText));
  const root = doc.children.find((c) => /^Mixxx(MIDI|Controller)Preset$/i.test(c.name));
  if (!root) throw new Error('Not a Mixxx controller mapping (.midi.xml)');
  const info = kid(root, 'info');
  const controller = kid(root, 'controller');
  if (!controller) throw new Error('Mapping has no <controller> section');
  if (find(controller, 'controls') == null && find(controller, 'outputs') == null) throw new Error('Mapping has no MIDI controls (HID mappings are not supported, use HID Learn instead)');
  const out = {
    name: textOf(info, 'name') || controller.attrs.id || 'Mixxx mapping',
    author: textOf(info, 'author') || '', description: textOf(info, 'description') || '', forums: textOf(info, 'forums') || '',
    controllerId: controller.attrs.id || '', source: 'mixxx', entries: [], outputs: [], unmapped: [],
    stats: { controls: 0, mapped: 0, scripted: 0, scriptedMapped: 0, unmapped: 0, outputs: 0, outputsMapped: 0 },
  };
  const controls = kids(kid(controller, 'controls'), 'control').map((c) => {
    const opts = new Set(kids(kid(c, 'options')).map((o) => o.name.toLowerCase()));
    return { group: textOf(c, 'group') || '', key: textOf(c, 'key') || '', desc: textOf(c, 'description') || '', status: num(textOf(c, 'status')), midino: num(textOf(c, 'midino')) ?? 0, opts };
  });
  const describe = (status, midino) => (status == null ? '?' : `${hex(status)} ${hex(midino)}`);

  // 1) resolve each control to a target spec
  const resolved = [];
  const seen = new Set(); // dedupe note-on/note-off pairs that Mixxx lists separately
  for (const c of controls) {
    out.stats.controls++;
    const st = c.status == null ? null : statusType(c.status);
    const script = c.opts.has('script-binding') || (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$.]*$/.test(c.key) && !mixxxTarget(c.group, c.key));
    if (script) out.stats.scripted++;
    if (!st) { out.unmapped.push({ group: c.group, key: c.key, midi: describe(c.status, c.midino), reason: 'unsupported message type' }); continue; }
    const key = msgKey(st.type, st.channel, st.type === 'pitch' ? 0 : c.midino);
    const dedupe = `${key}|${c.group}|${c.key}|${[...c.opts].sort().join(',')}`;
    if (seen.has(dedupe)) { out.stats.controls--; if (script) out.stats.scripted--; continue; }
    seen.add(dedupe);
    let spec = script ? scriptTarget(c.group, c.key, c.desc, st.type, st.channel) : mixxxTarget(c.group, c.key);
    if (!spec) { out.unmapped.push({ group: c.group, key: c.key, midi: describe(c.status, c.midino), reason: script ? 'script function' : 'no OpenDJ equivalent' }); continue; }
    spec = { ...spec };
    if (c.opts.has('fourteen-bit-msb')) spec.part = 'msb';
    if (c.opts.has('fourteen-bit-lsb')) spec.part = 'lsb';
    for (const [o, r] of Object.entries(OPTION_REL)) if (c.opts.has(o)) spec.rel = r;
    if (c.opts.has('invert') || c.opts.has('rot64inv')) spec.invert = true;
    resolved.push({ c, st, key, spec, script });
  }

  // 2) give indexed script pads a number from their position among siblings (same group + function), by MIDI number
  const groups = new Map();
  for (const r of resolved) if (r.spec.indexed) {
    const g = `${r.c.group}|${r.c.key}|${r.st.channel}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const list of groups.values()) {
    const nums = [...new Set(list.map((r) => r.c.midino))].sort((a, b) => a - b);
    for (const r of list) {
      const i = nums.indexOf(r.c.midino) % 8;
      r.spec.target = `${r.spec.target}${i + 1}`;
      delete r.spec.indexed;
    }
  }

  // 3) pair 14-bit MSB/LSB controls (same target; for scripts, same function minus the MSB/LSB suffix)
  const lsbs = resolved.filter((r) => r.spec.part === 'lsb');
  const used = new Set();
  const entries = [];
  const entryKeys = new Set();
  const push = (e, r) => {
    const id = `${e.key}|${e.target}`;
    if (entryKeys.has(id)) return;
    entryKeys.add(id); entries.push(e);
    out.stats.mapped++; if (r.script) out.stats.scriptedMapped++;
  };
  for (const r of resolved) {
    if (r.spec.part === 'lsb') continue;
    const e = { key: r.key, target: r.spec.target };
    if (r.spec.kind === 'rel' || r.spec.rel) { if (r.spec.kind !== 'button') e.rel = r.spec.rel || 'auto'; }
    if (r.spec.invert) e.invert = true;
    if (r.spec.part === 'msb') {
      const l = lsbs.find((x) => !used.has(x) && x.spec.target === r.spec.target && x.st.channel === r.st.channel);
      if (l) { used.add(l); e.lsbKey = l.key; out.stats.mapped++; if (l.script) out.stats.scriptedMapped++; }
    }
    push(e, r);
  }
  for (const l of lsbs) if (!used.has(l)) out.unmapped.push({ group: l.c.group, key: l.c.key, midi: describe(l.c.status, l.c.midino), reason: '14-bit LSB without MSB' });

  // 4) outputs (LEDs)
  for (const o of kids(kid(controller, 'outputs'), 'output')) {
    out.stats.outputs++;
    const group = textOf(o, 'group') || '', key = textOf(o, 'key') || '';
    const status = num(textOf(o, 'status')), midino = num(textOf(o, 'midino')) ?? 0;
    const state = mixxxState(group, key);
    if (!state || status == null) { out.unmapped.push({ group, key, midi: describe(status, midino), reason: 'LED output without OpenDJ equivalent' }); continue; }
    const led = { state, status, midino, on: num(textOf(o, 'on')) ?? 0x7f, off: num(textOf(o, 'off')) ?? 0 };
    const min = num(textOf(o, 'minimum')), max = num(textOf(o, 'maximum'));
    if (min != null) led.min = min;
    if (max != null) led.max = max;
    out.outputs.push(led); out.stats.outputsMapped++;
  }
  out.entries = entries;
  out.stats.unmapped = out.unmapped.length;
  return out;
}

/** Turn a converted mapping into the object MidiManager stores (keeps a compact import report). */
export function toStoredMapping(conv, file) {
  return {
    name: conv.name, source: 'mixxx', file: file || '', entries: conv.entries, outputs: conv.outputs,
    importInfo: { author: conv.author, stats: conv.stats, unmapped: conv.unmapped.slice(0, 300).map((u) => `${u.group} ${u.key} (${u.midi}): ${u.reason}`) },
  };
}
