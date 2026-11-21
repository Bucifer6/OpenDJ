// Controllers with their own sound card (bundled preset with `audio.builtIn`, e.g. the DDJ-FLX2): offer once to send
// the master to the controller's outputs 1-2 and the headphone cue to 3-4, or point to split cue when the interface
// only has 2 channels. Never changes anything without the user's click.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** A toast with actions (same look as the "new controller" offer). */
function offer(app, title, textMsg, actions, cls) {
  const host = app.toasts; if (!host || typeof document === 'undefined') return;
  const mk = (tag, c, t, onclick) => { const e = document.createElement(tag); if (c) e.className = c; if (t) e.textContent = t; if (onclick) e.addEventListener('click', onclick); return e; };
  const box = mk('div', `toast ctl-offer ${cls}`);
  const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 400); };
  const row = mk('div', 'ctl-offer-actions');
  for (const [label, fn, primary] of actions) row.append(mk('button', `btn sm${primary ? ' primary' : ''}`, label, () => { close(); fn?.(); }));
  box.append(mk('div', 'ctl-offer-title', title), mk('div', 'ctl-offer-text', textMsg), row);
  host.append(box);
  setTimeout(close, 30000);
}

export function offerControllerAudio(app, device, preset) {
  const key = `opendj.audioOffer.${preset.id}`;
  const s = app.settings || {};
  if (store.get(key) || s.cueMode === 'channels34' || s.cueMode === 'split') return;
  store.set(key, 'asked');
  const useIt = async () => {
    const outs = await app.engine.listOutputs?.() || [];
    const dev = outs.find((o) => preset.audio.deviceLabel?.test?.(o.label));
    if (!dev) {
      app.toast(`Pick "${device}" as the master output and "channels 3-4" for headphones in Settings → Audio (if the names are hidden, press "Show device names" there first).`);
      app.dialogs?.settings?.('audio');
      return;
    }
    await app.setSetting('masterDeviceId', dev.id);
    await app.setSetting('cueMode', 'channels34');
    await app.engine.applyOutputs?.();
    const chs = app.engine.ctx?.destination?.maxChannelCount || 2;
    if (chs < 4) app.toast(`⚠ ${device} offers ${chs} output channels here, so the headphone cue can't use channels 3-4. Use "Split cue" (master left, cue right) or a second sound card in Settings → Audio.`);
    else app.toast(`Master now plays on ${device} outputs 1-2, headphones on 3-4.`);
  };
  offer(app, `${device} has its own sound card`, 'Its MASTER and PHONES jacks play audio from OpenDJ. Send the master to outputs 1-2 and the headphone cue to 3-4?', [
    ['Use controller audio', useIt, true],
    ['Audio settings', () => app.dialogs?.settings?.('audio')],
    ['Not now'],
  ], 'audio-offer');
}
