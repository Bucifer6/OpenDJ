import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crossfaderGain, channelLevel, computeLayers, dominantLayer, syncDecision, SYNC, parseYouTube, parseYouTubeTime,
  mapYouTubeSearch, youTubeSearchUrl, decodeEntities, jukeboxVolume, nowPlayingText, lowerThirdAlpha, coverUv, isVideoCandidate,
} from '../public/js/video/video-core.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const L = (volume, xfAssign, active = true) => ({ volume, xfAssign, active });

// ---------------------------------------------------------------- mixer → opacity
test('crossfaderGain matches the engine curves', () => {
  near(crossfaderGain('A', -1), 1); near(crossfaderGain('B', -1), 0);
  near(crossfaderGain('A', 1), 0); near(crossfaderGain('B', 1), 1);
  near(crossfaderGain('A', 0), 1); near(crossfaderGain('B', 0), 1); // smooth curve: both full in the middle
  near(crossfaderGain('THRU', 1), 1);
  near(crossfaderGain('B', -0.9, 'sharp'), 0.625); near(crossfaderGain('B', 0, 'sharp'), 1);
  near(crossfaderGain('A', 0, 'constant'), 1);
  near(crossfaderGain('A', 0.5, 'constant'), 0.5);
});

test('channelLevel = fader² × crossfader gain', () => {
  near(channelLevel(0.5, 'THRU', 0), 0.25);
  near(channelLevel(1, 'A', 1), 0);
  near(channelLevel(0.8, 'B', 1), 0.64);
});

test('crossfade (follow audio): lone layer fades with fader, two full layers blend 50/50', () => {
  let w = computeLayers({ layers: [L(1, 'A'), L(0, 'B')], crossfader: 0 });
  near(w[0].alpha, 1); near(w[1].alpha, 0);
  w = computeLayers({ layers: [L(0.5, 'A'), L(0, 'B')], crossfader: 0 });
  near(w[0].alpha, 0.25);
  w = computeLayers({ layers: [L(1, 'A'), L(1, 'B')], crossfader: 0 });
  near(w[0].alpha, 0.5); near(w[1].alpha, 0.5);
  w = computeLayers({ layers: [L(1, 'A'), L(1, 'B')], crossfader: 1 });
  near(w[0].alpha, 0); near(w[1].alpha, 1);
  w = computeLayers({ layers: [L(1, 'A'), L(1, 'B')], crossfader: -0.5 });
  assert.ok(w[0].alpha > w[1].alpha && w[1].alpha > 0);
  near(w[0].alpha + w[1].alpha, 1);
  // inactive layers (no track / no picture) never count
  w = computeLayers({ layers: [L(1, 'A'), L(1, 'B', false)], crossfader: 0 });
  near(w[0].alpha, 1); near(w[1].alpha, 0);
});

test('cut / dissolve-to-black / wipe / zoom transitions', () => {
  const layers = [L(1, 'A'), L(1, 'B')];
  let w = computeLayers({ layers, crossfader: -0.2, transition: 'cut' });
  near(w[0].alpha, 1); near(w[1].alpha, 0);
  w = computeLayers({ layers, crossfader: 0.2, transition: 'cut' });
  near(w[0].alpha, 0); near(w[1].alpha, 1);
  w = computeLayers({ layers, crossfader: 0, transition: 'black' });
  near(w[0].alpha, 0); near(w[1].alpha, 0); // black in the middle
  w = computeLayers({ layers, crossfader: -0.5, transition: 'black' });
  assert.ok(w[0].alpha > 0 && w[1].alpha === 0);
  w = computeLayers({ layers, crossfader: 0, transition: 'wipeleft' });
  assert.deepEqual(w[0].clip, [0, 0.5]); assert.deepEqual(w[1].clip, [0.5, 1]); near(w[0].alpha, 1); near(w[1].alpha, 1);
  w = computeLayers({ layers, crossfader: -0.5, transition: 'wiperight' });
  assert.deepEqual(w[0].clip, [0.25, 1]); assert.deepEqual(w[1].clip, [0, 0.25]);
  w = computeLayers({ layers, crossfader: -1, transition: 'wiperight' });
  near(w[1].alpha, 0); near(w[0].alpha, 1);
  w = computeLayers({ layers, crossfader: 0, transition: 'zoom' });
  assert.ok(w[0].scale > 1 && w[1].scale < 1); near(w[0].alpha, 0.5); near(w[1].alpha, 0.5);
  // only side A has a picture: transitions don't wipe it to black
  w = computeLayers({ layers: [L(1, 'A'), L(1, 'B', false)], crossfader: 1, transition: 'black' });
  near(w[0].alpha, 1);
  // THRU layers ignore the crossfader
  w = computeLayers({ layers: [L(1, 'THRU'), L(0, 'B')], crossfader: 1, transition: 'cut' });
  near(w[0].alpha, 1);
});

test('dominantLayer', () => {
  assert.equal(dominantLayer([{ alpha: 0.2, clip: [0, 1] }, { alpha: 0.8, clip: [0, 1] }]), 1);
  assert.equal(dominantLayer([{ alpha: 0.3, clip: [0, 1] }, { alpha: 0.3, clip: [0, 1] }]), -1);
  assert.equal(dominantLayer([{ alpha: 1, clip: [0, 0.3] }, { alpha: 1, clip: [0.3, 1] }]), 1);
});

// ---------------------------------------------------------------- drift controller
const base = { rate: 1, playing: true, videoPaused: false, seeking: false, duration: 100 };

test('sync: locked when close, nudges small drift, seeks large drift', () => {
  let d = syncDecision({ ...base, videoTime: 10.005, target: 10 });
  assert.equal(d.action, 'rate'); near(d.playbackRate, 1); assert.equal(d.mode, 'locked');
  d = syncDecision({ ...base, videoTime: 10.05, target: 10, rate: 1.06 }); // video ahead → slow down 3 %
  assert.equal(d.action, 'rate'); near(d.playbackRate, 1.06 * (1 - SYNC.nudge));
  d = syncDecision({ ...base, videoTime: 9.95, target: 10 }); // behind → speed up
  near(d.playbackRate, 1 + SYNC.nudge);
  d = syncDecision({ ...base, videoTime: 12, target: 10, seekLatency: 0.1 });
  assert.equal(d.action, 'seek'); near(d.time, 10.1); // leads by the measured seek latency
  d = syncDecision({ ...base, videoTime: 30, target: 10.5, rate: 2, seekLatency: 0.1 });
  near(d.time, 10.7);
});

test('sync: loop / hot-cue jump → seek; waits while a seek is in flight', () => {
  let d = syncDecision({ ...base, videoTime: 64.2, target: 60 }); // loop wrapped back
  assert.equal(d.action, 'seek');
  d = syncDecision({ ...base, videoTime: 64.2, target: 60, seeking: true });
  assert.equal(d.action, 'none');
});

test('sync: deck paused → pause video, then frame-accurate seeks', () => {
  let d = syncDecision({ ...base, playing: false, videoTime: 10, target: 10 });
  assert.equal(d.action, 'pause');
  d = syncDecision({ ...base, playing: false, videoPaused: true, videoTime: 10, target: 12 });
  assert.equal(d.action, 'seek'); near(d.time, 12);
  d = syncDecision({ ...base, playing: false, videoPaused: true, videoTime: 12.001, target: 12 });
  assert.equal(d.action, 'none');
});

test('sync: scratch / reverse / brake seek every frame; resume plays', () => {
  let d = syncDecision({ ...base, scratching: true, videoPaused: true, videoTime: 10, target: 10.2 });
  assert.equal(d.action, 'seek'); assert.equal(d.mode, 'frame');
  d = syncDecision({ ...base, rate: -1, videoPaused: true, videoTime: 10, target: 9.9 });
  assert.equal(d.action, 'seek');
  d = syncDecision({ ...base, rate: 0.1, videoPaused: false, videoTime: 10, target: 10 });
  assert.equal(d.action, 'pause');
  d = syncDecision({ ...base, videoPaused: true, videoTime: 10.01, target: 10 });
  assert.equal(d.action, 'play'); near(d.playbackRate, 1);
});

test('sync: target clamped to the video length', () => {
  const d = syncDecision({ ...base, duration: 50, videoTime: 20, target: 80 });
  assert.equal(d.action, 'seek'); assert.ok(d.time <= 50);
});

// ---------------------------------------------------------------- YouTube
test('parseYouTube handles all common URL forms', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    id, `https://www.youtube.com/watch?v=${id}`, `youtube.com/watch?v=${id}&list=PL123`, `https://youtu.be/${id}`,
    `https://m.youtube.com/watch?v=${id}`, `https://music.youtube.com/watch?v=${id}`, `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}?rel=0`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}?si=x`,
  ]) assert.deepEqual(parseYouTube(u), { id, start: 0 }, u);
  assert.deepEqual(parseYouTube(`https://youtu.be/${id}?t=90`), { id, start: 90 });
  assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${id}&t=1m30s`), { id, start: 90 });
  assert.equal(parseYouTube('https://vimeo.com/123'), null);
  assert.equal(parseYouTube('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseYouTube(''), null);
  assert.equal(parseYouTube('hello world'), null);
  assert.equal(parseYouTube('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
});

test('parseYouTubeTime', () => {
  assert.equal(parseYouTubeTime('1h2m3s'), 3723);
  assert.equal(parseYouTubeTime('45'), 45);
  assert.equal(parseYouTubeTime('2m'), 120);
  assert.equal(parseYouTubeTime(null), 0);
});

test('YouTube search URL and response mapping', () => {
  const u = new URL(youTubeSearchUrl('daft punk', 'KEY'));
  assert.equal(u.host, 'www.googleapis.com');
  assert.equal(u.searchParams.get('part'), 'snippet');
  assert.equal(u.searchParams.get('type'), 'video');
  assert.equal(u.searchParams.get('q'), 'daft punk');
  assert.equal(u.searchParams.get('key'), 'KEY');
  const r = mapYouTubeSearch({
    nextPageToken: 'NEXT',
    items: [
      { id: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Rick &amp; Morty&#39;s &quot;Song&quot;', channelTitle: 'Chan', publishedAt: '2020-01-01T00:00:00Z', thumbnails: { default: { url: 'https://i.ytimg.com/vi/x/default.jpg' }, medium: { url: 'https://i.ytimg.com/vi/x/mqdefault.jpg' } }, liveBroadcastContent: 'none' } },
      { id: { kind: 'youtube#channel', channelId: 'UC123' }, snippet: { title: 'channel' } },
      { id: { videoId: 'abcdefghijk' }, snippet: { title: 'Live', liveBroadcastContent: 'live' } },
    ],
  });
  assert.equal(r.next, 'NEXT');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { id: 'dQw4w9WgXcQ', title: 'Rick & Morty\'s "Song"', channel: 'Chan', thumb: 'https://i.ytimg.com/vi/x/mqdefault.jpg', published: '2020-01-01T00:00:00Z', live: false });
  assert.equal(r.items[1].thumb, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  assert.equal(r.items[1].live, true);
  assert.throws(() => mapYouTubeSearch({ error: { code: 403, message: 'x', errors: [{ reason: 'quotaExceeded' }] } }), /quota/);
  assert.throws(() => mapYouTubeSearch({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), /not valid/);
  assert.deepEqual(mapYouTubeSearch({}), { next: null, items: [] });
  assert.equal(decodeEntities('&#x41;&#66;&amp;'), 'AB&');
});

test('jukebox volume follows its crossfader side', () => {
  assert.equal(jukeboxVolume({ level: 1, side: 'B', crossfader: 1 }), 100);
  assert.equal(jukeboxVolume({ level: 1, side: 'B', crossfader: -1 }), 0);
  assert.equal(jukeboxVolume({ level: 0.5, side: 'THRU', crossfader: -1 }), 25);
  assert.equal(jukeboxVolume({ level: 1, side: 'A', crossfader: -1, master: 0.5 }), 50);
});

test('misc helpers', () => {
  assert.equal(nowPlayingText({ artist: 'A', title: 'T' }), 'A – T');
  assert.equal(nowPlayingText({ title: 'T' }), 'T');
  assert.equal(nowPlayingText(null), '');
  near(lowerThirdAlpha(0.3), 0.5); near(lowerThirdAlpha(5), 1); near(lowerThirdAlpha(20), 0); near(lowerThirdAlpha(-1), 0);
  assert.deepEqual(coverUv(1920, 1080, 1280, 720), [1, 1]);
  near(coverUv(1000, 1000, 1600, 900)[1], 900 / 1600);
  assert.equal(isVideoCandidate({ format: 'webm' }), true);
  assert.equal(isVideoCandidate({ format: 'mp3' }), false);
  assert.equal(isVideoCandidate({ format: 'mkv', hasVideo: true }), true);
  assert.equal(isVideoCandidate({ format: 'mp4', hasVideo: false }), false);
});
