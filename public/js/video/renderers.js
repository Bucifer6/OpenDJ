// Compositors for the video mixer. GLRenderer (WebGL2, all FX as fragment shaders) and
// CanvasRenderer (2D fallback with a subset: pulse, strobe, mirror, invert, blur).
// Layers are blended additively with their weight (sum of weights ≤ 1), overlay drawn on top.
import { coverUv } from './video-core.js';

const VS = `#version 300 es
in vec2 p; out vec2 v_uv;
void main() { v_uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS_LAYER = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_uvScale, u_clip, u_res;
uniform float u_alpha, u_scale, u_bright, u_strobe, u_invert, u_mirror, u_blur, u_rgb, u_kaleido, u_time;
in vec2 v_uv; out vec4 o;
vec3 samp(vec2 uv) { return texture(u_tex, (uv - 0.5) * u_uvScale + 0.5).rgb; }
vec2 kal(vec2 uv) {
  float asp = u_res.x / u_res.y;
  vec2 q = uv - 0.5; q.x *= asp;
  float r = length(q), a = atan(q.y, q.x) + u_time * 0.25, seg = 6.2831853 / 6.0;
  a = mod(a, seg); a = abs(a - seg * 0.5);
  q = vec2(cos(a), sin(a)) * r; q.x /= asp;
  return q + 0.5;
}
void main() {
  if (v_uv.x < u_clip.x || v_uv.x > u_clip.y) discard;
  vec2 uv = (v_uv - 0.5) / u_scale + 0.5;
  if (u_kaleido > 0.5) uv = kal(uv);
  if (u_mirror > 0.5 && uv.x > 0.5) uv.x = 1.0 - uv.x;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  vec3 c;
  if (u_blur > 0.0) {
    vec2 d = u_blur / u_res; c = vec3(0.0);
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) c += samp(uv + vec2(float(x), float(y)) * d);
    c /= 9.0;
  } else c = samp(uv);
  if (u_rgb > 0.0) { float d = u_rgb / u_res.x; c.r = samp(uv + vec2(d, 0.0)).r; c.b = samp(uv - vec2(d, 0.0)).b; }
  c *= u_bright;
  if (u_invert > 0.5) c = 1.0 - c;
  c = mix(c, vec3(1.0), u_strobe);
  o = vec4(clamp(c, 0.0, 1.0) * u_alpha, u_alpha);
}`;

const FS_OVERLAY = `#version 300 es
precision mediump float;
uniform sampler2D u_tex; in vec2 v_uv; out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

export class GLRenderer {
  static create(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return null;
    try { return new GLRenderer(canvas, gl); } catch (e) { console.warn('WebGL2 video renderer unavailable', e); return null; }
  }

  constructor(canvas, gl) {
    this.canvas = canvas; this.gl = gl; this.kind = 'webgl2';
    const prog = (fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      return { p, u };
    };
    this.layerProg = prog(FS_LAYER); this.overlayProg = prog(FS_OVERLAY);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.slots = []; // per-layer texture + last uploaded element
    this.overlayTex = this.tex();
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  tex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  supports() { return true; }

  /**
   * @param {Array} items [{slot, src:{el,w,h,fresh}, alpha, scale, clip, fx:{bright,strobe,invert,mirror,blur,rgb,kaleido}, time}]
   * @param {HTMLCanvasElement|null} overlay
   * @param {boolean} overlayDirty
   */
  draw(items, overlay, overlayDirty) {
    if (this.lost) return;
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const { p, u } = this.layerProg;
    gl.useProgram(p);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: weights sum to ≤ 1
    gl.uniform1i(u.u_tex, 0); gl.uniform2f(u.u_res, W, H);
    gl.activeTexture(gl.TEXTURE0);
    for (const it of items) {
      let s = this.slots[it.slot];
      if (!s) s = this.slots[it.slot] = { tex: this.tex(), el: null };
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      if (it.src.fresh || s.el !== it.src.el) {
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, it.src.el); s.el = it.src.el; } catch { continue; }
      }
      const [ux, uy] = coverUv(it.src.w, it.src.h, W, H);
      const f = it.fx;
      gl.uniform2f(u.u_uvScale, ux, uy); gl.uniform2f(u.u_clip, it.clip[0], it.clip[1]);
      gl.uniform1f(u.u_alpha, it.alpha); gl.uniform1f(u.u_scale, it.scale);
      gl.uniform1f(u.u_bright, f.bright); gl.uniform1f(u.u_strobe, f.strobe); gl.uniform1f(u.u_invert, f.invert ? 1 : 0);
      gl.uniform1f(u.u_mirror, f.mirror ? 1 : 0); gl.uniform1f(u.u_blur, f.blur); gl.uniform1f(u.u_rgb, f.rgb);
      gl.uniform1f(u.u_kaleido, f.kaleido ? 1 : 0); gl.uniform1f(u.u_time, it.time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (overlay) {
      gl.useProgram(this.overlayProg.p);
      gl.uniform1i(this.overlayProg.u.u_tex, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
      if (overlayDirty || !this._overlayUploaded) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
        this._overlayUploaded = true;
      }
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.kind = '2d';
    this.g = canvas.getContext('2d', { alpha: false });
  }

  supports(fx) { return fx !== 'rgb' && fx !== 'kaleido'; }

  draw(items, overlay) {
    const g = this.g, W = this.canvas.width, H = this.canvas.height;
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    for (const it of items) {
      const { el, w, h } = it.src, f = it.fx;
      const [ux, uy] = coverUv(w, h, W, H);
      const sw = w * ux, sh = h * uy, sx = (w - sw) / 2, sy = (h - sh) / 2;
      g.save();
      g.beginPath(); g.rect(it.clip[0] * W, 0, (it.clip[1] - it.clip[0]) * W, H); g.clip();
      g.globalAlpha = it.alpha;
      const filters = [];
      if (Math.abs(f.bright - 1) > 0.01) filters.push(`brightness(${f.bright.toFixed(2)})`);
      if (f.invert) filters.push('invert(1)');
      if (f.blur > 0) filters.push(`blur(${(f.blur * 0.8).toFixed(1)}px)`);
      g.filter = filters.length ? filters.join(' ') : 'none';
      g.translate(W / 2, H / 2); g.scale(it.scale, it.scale); g.translate(-W / 2, -H / 2);
      if (f.mirror) {
        g.drawImage(el, sx, sy, sw / 2, sh, 0, 0, W / 2, H);
        g.translate(W, 0); g.scale(-1, 1);
        g.drawImage(el, sx, sy, sw / 2, sh, 0, 0, W / 2, H);
      } else g.drawImage(el, sx, sy, sw, sh, 0, 0, W, H);
      g.restore();
      if (f.strobe > 0) {
        g.save(); g.beginPath(); g.rect(it.clip[0] * W, 0, (it.clip[1] - it.clip[0]) * W, H); g.clip();
        g.globalAlpha = f.strobe * it.alpha; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.restore();
      }
    }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
    if (overlay) g.drawImage(overlay, 0, 0, W, H);
  }
}
