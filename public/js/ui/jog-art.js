import { clamp } from '../util.js';
import { cssVar } from './themes.js';

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;
const ringRadius = { brushed: .376, digital: .403, vinyl: .447 };

function disc(ctx, radius, fill, x = .5, y = .5) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

function arc(ctx, radius, colour, width, start = 0, end = TAU) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(.5, .5, radius, start, end);
  ctx.stroke();
}

function box(ctx, x, y, w, h, radius, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

function gradient(ctx, stops, y1 = 0, y2 = 1) {
  const paint = ctx.createLinearGradient(0, y1, 0, y2);
  for (const [point, colour] of stops) paint.addColorStop(point, colour);
  return paint;
}

export function paintJogFace(ctx, size, style) {
  ctx.save();
  ctx.scale(size, size);
  if (style === 'vinyl') {
    box(ctx, .018, .018, .964, .964, .075, '#08090a');
    const plinth = gradient(ctx, [[0, cssVar('--platter-rim-1')], [.07, cssVar('--panel-3')], [1, cssVar('--deep')]]);
    box(ctx, .026, .026, .948, .928, .066, plinth);
    disc(ctx, .438, '#08090a');
    disc(ctx, .421, gradient(ctx, [[0, '#a0a5a9'], [.24, '#4a4e51'], [.69, '#777b7d'], [1, '#292a2b']]));
    for (let i = 0; i < 72; i++) {
      const angle = i * TAU / 72;
      disc(ctx, i % 4 === 0 ? .0042 : .0026, i % 4 === 0 ? '#c6c8c8' : '#888d90', .5 + .412 * Math.cos(angle), .5 + .412 * Math.sin(angle));
    }
    disc(ctx, .4, '#08090a');
    disc(ctx, .392, gradient(ctx, [[0, '#202327'], [.43, '#08090b'], [.69, '#171a1d'], [1, '#060708']], .1, .9));
    for (let i = 0; i < 29; i++) {
      arc(ctx, .149 + i * .0084, `rgba(221,230,245,${i % 6 ? .073 : .18})`, i % 6 ? .0014 : .003);
    }
    arc(ctx, .387, '#6a6d73', .0025, TOP - .85, TOP + .44);
  } else if (style === 'digital') {
    disc(ctx, .49, gradient(ctx, [[0, '#636c74'], [.16, '#262d33'], [.72, '#080b0e'], [1, '#353d45']]));
    disc(ctx, .474, '#151a1f');
    for (let i = 0; i < 48; i++) {
      const angle = i * TAU / 48;
      arc(ctx, .454, i % 4 ? '#343e47' : '#858e96', i % 4 ? .012 : .017, angle, angle + .04);
    }
    disc(ctx, .431, '#090d11');
    for (let i = 0; i < 48; i++) {
      const angle = TOP + i * TAU / 48;
      arc(ctx, ringRadius.digital, '#26363e', .015, angle + .014, angle + .097);
    }
    disc(ctx, .378, gradient(ctx, [[0, '#333c45'], [.23, '#222a31'], [1, '#12171b']], .12, .88));
    for (let i = 0; i < 7; i++) arc(ctx, .26 + i * .016, 'rgba(183,203,216,.08)', .002);
    disc(ctx, .226, '#5b676e');
    disc(ctx, .219, '#080d12');
    disc(ctx, .207, gradient(ctx, [[0, '#15222d'], [1, '#090f13']], .3, .68));
  } else {
    disc(ctx, .49, '#101216');
    disc(ctx, .48, gradient(ctx, [[0, '#eff4f6'], [.13, '#7b8790'], [.41, '#a9b3b9'], [.52, '#414c54'], [.84, '#232a30'], [1, '#bbc3c6']]));
    disc(ctx, .458, '#11171c');
    for (let i = 0; i < 60; i++) {
      const angle = i * TAU / 60;
      arc(ctx, .432, i % 5 ? '#6a757c' : '#bdc7cc', .034, angle, angle + .044);
    }
    disc(ctx, .406, gradient(ctx, [[0, '#d6dfe4'], [.52, '#59656e'], [1, '#b1bac0']], .09, .91));
    disc(ctx, .39, '#181d22');
    disc(ctx, .357, gradient(ctx, [[0, '#dde6eb'], [.36, '#98a6b0'], [.57, '#bbc7cf'], [1, '#64747f']], .14, .86));
    for (let i = 0; i < 22; i++) arc(ctx, .158 + i * .009, i % 4 ? '#ffffff20' : '#263f4e38', .0018);
    disc(ctx, .162, '#6f7b83');
    disc(ctx, .155, '#191f24');
  }
  ctx.restore();
}

function paintTonearm(ctx, progress, playing) {
  const x = .86, y = .12;
  const tipX = playing ? .82 - progress * .19 : .935;
  const tipY = playing ? .63 - progress * .035 : .704;
  const bendX = tipX + (playing ? .073 : -.03);
  const bendY = tipY - .14;
  disc(ctx, .058, '#111316', x, y);
  disc(ctx, .048, '#80898d', x, y);
  disc(ctx, .036, '#33393e', x, y);
  ctx.lineCap = 'round';
  for (const [colour, width, offset] of [['#090b0d', .034, .005], ['#9ba4aa', .021, 0], ['#dee4e7', .005, -.005]]) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x + offset, y);
    ctx.quadraticCurveTo(bendX + .055 + offset, bendY - .15, bendX + offset, bendY);
    ctx.lineTo(tipX + offset, tipY);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(-Math.atan2(tipX - bendX, tipY - bendY));
  box(ctx, -.016, -.022, .032, .053, .006, '#101317');
  box(ctx, -.012, .015, .024, .014, .003, '#aeb9bd');
  ctx.restore();
}

export function paintJogOverlay(ctx, size, style, { angle, progress, colour, signal, bpm, playing, touched }) {
  ctx.save();
  ctx.scale(size, size);
  const k = clamp(progress, 0, 1);
  const r = ringRadius[style];
  if (k > 0) {
    if (style === 'digital') {
      ctx.lineCap = 'butt';
      for (let i = 0; i < 48 * k; i++) {
        const a = TOP + i * TAU / 48;
        arc(ctx, r, signal, .015, a + .014, a + .097);
      }
    } else {
      ctx.lineCap = 'round';
      arc(ctx, r, signal, style === 'vinyl' ? .009 : .011, TOP, TOP + k * TAU);
    }
  }
  if (style === 'vinyl') {
    disc(ctx, .136, '#060709');
    disc(ctx, .129, colour);
    disc(ctx, .104, '#11151a');
    arc(ctx, .119, '#11151a', .014, angle + TOP, angle + TOP + .54);
    disc(ctx, .019, '#090b0c');
    disc(ctx, .01, '#e9ecea');
    paintTonearm(ctx, k, playing);
  } else {
    const digital = style === 'digital';
    const marker = angle + TOP;
    ctx.lineCap = 'round';
    arc(ctx, digital ? .336 : .319, colour, digital ? .023 : .017, marker - .09, marker + .09);
    const markRadius = digital ? .291 : .278;
    disc(ctx, .009, digital ? '#e6f7ff' : '#172029', .5 + markRadius * Math.cos(marker), .5 + markRadius * Math.sin(marker));
    if (playing || touched) arc(ctx, digital ? .215 : .157, colour, .004);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f2f6f8';
    ctx.font = `600 ${digital ? .101 : .077}px ${cssVar('--mono')}`;
    ctx.fillText(bpm, .5, .479);
    ctx.fillStyle = colour;
    ctx.font = `700 ${digital ? .043 : .035}px ${cssVar('--font')}`;
    ctx.fillText('BPM', .5, .565);
  }
  ctx.restore();
}
