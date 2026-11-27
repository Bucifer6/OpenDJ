// Stem FX: beat-synced dub echo + bleed-masking HPF + Mute FX tails fed by the deck worklet's stem send (output 1).
// Supports per-stem routing (vocals, drums, bass, other) and djay-style Mute FX (brief send pulse when a stem mutes).
// The wet signal goes back into the deck's mixer channel, so channel EQ / filter / fader apply to it.
export class StemEcho {
  constructor(ctx, { beats = 0.75, feedback = 0.5, wet = 0.7, hpFreq = 280 } = {}) {
    this.ctx = ctx; this.beats = beats;
    this.input = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain(); this.fb.gain.value = feedback;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = hpFreq;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 5200;
    this.output = ctx.createGain(); this.output.gain.value = wet;
    // input -> delay -> hp -> lp -> (feedback -> delay) -> output: only echoes, the dry stem stays in the deck output
    this.input.connect(this.delay); this.delay.connect(this.hp); this.hp.connect(this.lp);
    this.lp.connect(this.fb); this.fb.connect(this.delay); this.lp.connect(this.output);
    this.setBeat(0.5);
  }
  /** Seconds per beat at the deck's current tempo. */
  setBeat(sec) {
    const t = Math.min(3.9, Math.max(0.02, sec * this.beats));
    this.delay.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.02);
  }
  setFeedback(fb) {
    this.fb.gain.setTargetAtTime(Math.max(0, Math.min(0.85, fb)), this.ctx.currentTime, 0.02);
  }
  setWet(wet) {
    this.output.gain.setTargetAtTime(Math.max(0, Math.min(1.2, wet)), this.ctx.currentTime, 0.02);
  }
}

/**
 * Stem loudness makeup gain (1.0 .. 1.35, i.e., 0 .. +2.6 dB): when stems are isolated (e.g. acapella or drum bridge),
 * removing the other stems drops perceived loudness by 3-6 dB. Gentle makeup keeps stem transitions full and balanced.
 */
export function stemMakeupGain(gains) {
  if (!gains || gains.length < 4) return 1;
  // Weighted energy share of [vocals, drums, bass, other]
  const w = [0.22, 0.28, 0.28, 0.22];
  let active = 0;
  for (let i = 0; i < 4; i++) active += w[i] * Math.max(0, Math.min(1, Number(gains[i]) || 0));
  if (active >= 0.95 || active <= 0.02) return 1;
  // Up to +2.6 dB compensation when isolated, smooth curve
  return Math.min(1.35, 1 + (1 - active) * 0.42);
}

/** True when vocals are isolated solo (needs bleed-masking HPF ~145 Hz so low-end bleed doesn't rumble). */
export function isVocalSolo(gains) {
  return !!gains && (gains[0] || 0) > 0.3 && (gains[1] || 0) < 0.2 && (gains[2] || 0) < 0.15;
}
