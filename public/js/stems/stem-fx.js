// Stem FX: a beat-synced dub echo fed by the deck worklet's stem send (output 1), e.g. vocals only.
// The wet signal goes back into the deck's mixer channel, so channel EQ / filter / fader apply to it.
export class StemEcho {
  constructor(ctx, { beats = 0.75, feedback = 0.5, wet = 0.7 } = {}) {
    this.ctx = ctx; this.beats = beats;
    this.input = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain(); this.fb.gain.value = feedback;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 280;
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
}
