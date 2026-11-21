// Merging cue points imported from other DJ apps into a track's cues. Shared by server/importers.js and the mobile app.

/**
 * Merge cues imported from another DJ app into a track's existing cues.
 * - OpenDJ's automatic cues (auto: true) are replaceable: they are dropped when the import brings any cues.
 * - The user's own hot cues stay; an imported hot cue takes its own pad when that is free, else the next free pad
 *   (0-7); when all pads are taken it is skipped.
 * - Memory cues / loops are added unless one already sits at the same position.
 * @returns {{ cues: object[], added: number, skipped: number }}
 */
export function mergeImportedCues(existing = [], imported = []) {
  if (!imported?.length) return { cues: existing || [], added: 0, skipped: 0 };
  const keep = (existing || []).filter((c) => !c.auto);
  const used = new Set(keep.filter((c) => c.index >= 0).map((c) => c.index));
  const out = [...keep];
  let added = 0, skipped = 0;
  const same = (a, b) => Math.abs((a.position || 0) - (b.position || 0)) < 0.01 && (a.loopEnd ?? null) === (b.loopEnd ?? null);
  // cues whose own pad is free first, so a displaced cue never takes the pad another imported cue needs
  const ordered = [...imported].sort((a, b) => (a.index >= 0 && !used.has(a.index) ? 0 : 1) - (b.index >= 0 && !used.has(b.index) ? 0 : 1));
  for (const c of ordered) {
    if (c.index >= 0) {
      if (keep.some((k) => k.index >= 0 && same(k, c))) { skipped++; continue; } // already there
      let slot = !used.has(c.index) && c.index < 8 ? c.index : [0, 1, 2, 3, 4, 5, 6, 7].find((n) => !used.has(n));
      if (slot == null) { skipped++; continue; }
      used.add(slot); out.push({ ...c, index: slot }); added++;
    } else {
      if (out.some((k) => k.index < 0 && same(k, c))) { skipped++; continue; }
      out.push({ ...c, index: -1 }); added++;
    }
  }
  return { cues: out, added, skipped };
}
