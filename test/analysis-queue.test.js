import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisQueue, needsAnalysis, isUndecodable } from '../public/js/audio/analysis-queue.js';

test('needsAnalysis: skips analysed, locked / imported grids, missing, unreadable and streaming-only tracks', () => {
  assert.equal(needsAnalysis({ id: 'a' }), true);
  assert.equal(needsAnalysis({ analyzed: true }), false);
  assert.equal(needsAnalysis({ bpm: 125, bpmLocked: true }), false);
  assert.equal(needsAnalysis({ bpm: 125, gridLocked: true }), false);
  assert.equal(needsAnalysis({ missing: true }), false);
  assert.equal(needsAnalysis({ unreadable: true }), false);
  assert.equal(needsAnalysis({ unreadable: true }, { explicit: true }), true, 'explicit request re-tries unreadable');
  assert.equal(needsAnalysis({ sourceType: 'remote' }), false, 'no automatic download of every media server track');
  assert.equal(needsAnalysis({ sourceType: 'remote', localPath: '/dl/x.mp3' }), true);
  assert.equal(needsAnalysis({ sourceType: 'remote' }, { explicit: true }), true);
  assert.equal(needsAnalysis({ bpmLocked: true, bpm: 120 }, { explicit: true }), false, 'locked grids are never overwritten');
  assert.equal(needsAnalysis(null), false);
});

test('AnalysisQueue: dedupe, priority, skip and progress label', () => {
  const q = new AnalysisQueue();
  assert.equal(q.add(['a', 'b', 'c']), 3);
  assert.equal(q.add(['b', 'd']), 1);
  assert.equal(q.size, 4); assert.equal(q.total, 4);
  q.add(['c'], { front: true }); // "Analyse selected" jumps the queue
  assert.deepEqual(q.ids, ['c', 'a', 'b', 'd']);
  assert.equal(q.total, 4);
  assert.equal(q.next(), 'c');
  assert.equal(q.label(), 'Analysing 1 / 4');
  q.finished(true);
  assert.equal(q.next((id) => id === 'a'), 'b', 'tracks analysed meanwhile (e.g. on a deck) are skipped');
  assert.equal(q.total, 3);
  q.finished(false);
  assert.equal(q.label(), 'Analysing 3 / 3');
  assert.equal(q.next(), 'd');
  assert.equal(q.next(), null);
  q.clear();
  assert.equal(q.size, 0); assert.equal(q.total, 0); assert.equal(q.done, 0);
  const big = new AnalysisQueue(); big.add(Array.from({ length: 2000 }, (_, i) => String(i))); big.next(); big.finished(true); big.next();
  assert.equal(big.label(), 'Analysing 2 / 2,000');
});

test('isUndecodable: decode errors vs network errors', () => {
  assert.equal(isUndecodable(Object.assign(new Error('x'), { name: 'EncodingError' })), true);
  assert.equal(isUndecodable(new Error('Unable to decode audio data')), true);
  assert.equal(isUndecodable(Object.assign(new Error('HTTP 415'), { undecodable: true })), true);
  assert.equal(isUndecodable(new Error('Failed to fetch')), false);
  assert.equal(isUndecodable(new Error('HTTP 502')), false);
  assert.equal(isUndecodable(null), false);
});
