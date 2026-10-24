// Vinyl: the record, the tonearm, the music source and the controls.
// The markup in index.html supplies the elements by id; the styles place them.
(() => {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

  // ---------- tonearm geometry, in record radii with the spindle at 0,0 ----------
  const PIVOT = { x: 1.12, y: -0.78 };
  const STYLUS = { x: -0.0752, y: 1.439 }; // stylus tip in the arm's own frame
  const REST = -4;                          // degrees, arm on its rest post
  const OUTER = 0.955;                      // lead-in groove
  const INNER = 0.52;                       // run-out groove
  const SPEED = 80;                         // degrees per second; true 33⅓ (200) looks frantic on a screen

  function stylusRadius(deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return Math.hypot(PIVOT.x + STYLUS.x * c - STYLUS.y * s, PIVOT.y + STYLUS.x * s + STYLUS.y * c);
  }
  const TABLE = [];
  for (let d = REST; d <= 60; d += 0.05) TABLE.push([d, stylusRadius(d)]);
  function angleFor(r) {
    for (let i = 1; i < TABLE.length; i++) {
      const [d0, r0] = TABLE[i - 1], [d1, r1] = TABLE[i];
      if (r <= r0 && r >= r1) return d0 + ((r0 - r) / (r0 - r1)) * (d1 - d0);
    }
    return TABLE[TABLE.length - 1][0];
  }
  const armFor = (progress) => angleFor(OUTER - (OUTER - INNER) * clamp(progress, 0, 1));
  const OFF_RECORD = angleFor(1.04);

  // ---------- covers: pixels in, light out ----------
  const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const covers = new Map();
  function loadCover(url) {
    if (!url) return Promise.resolve(null);
    if (!covers.has(url)) {
      covers.set(url, new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(readCover(url, img));
        img.onerror = () => { covers.delete(url); resolve(null); };
        img.src = url;
      }));
      if (covers.size > 30) covers.delete(covers.keys().next().value);
    }
    return covers.get(url);
  }
  function readCover(url, img) {
    const cover = { url, img, avg: [58, 60, 66], lum: null };
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 12;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 12, 12);
      const d = ctx.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      cover.avg = [r / n, g / n, b / n].map(Math.round);
      cover.lum = lum(cover.avg);
      cover.frame = findFrame(img);
    } catch { /* a cover from file:// can't be read back; it still draws */ }
    return cover;
  }

  // Some covers are printed inside a frame, like a photo's white edge, which shows as a rim on
  // the round label. The frame is every row and column in from each edge that is mostly the
  // corners' colour. Returns the picture inside it, in fractions of the cover, or null.
  function findFrame(img) {
    const N = 100;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const at = (x, y) => (y * N + x) * 4;
    const corners = [at(0, 0), at(N - 1, 0), at(0, N - 1), at(N - 1, N - 1)];
    const edge = [0, 1, 2].map((k) => corners.reduce((sum, i) => sum + d[i + k], 0) / 4);
    const near = (i) => Math.abs(d[i] - edge[0]) + Math.abs(d[i + 1] - edge[1]) + Math.abs(d[i + 2] - edge[2]) < 48;
    if (!corners.every(near)) return null;
    // Writing on the frame (a title, a name) can cover nearly half a line.
    const line = (fn) => { let k = 0; for (let j = 0; j < N; j++) if (near(fn(j))) k++; return k / N >= 0.5; };
    const inset = (fn) => { let n = 0; while (n < 16 && line((j) => fn(n, j))) n++; return n; };
    const top = inset((n, j) => at(j, n)), bottom = inset((n, j) => at(j, N - 1 - n));
    const left = inset((n, j) => at(n, j)), right = inset((n, j) => at(N - 1 - n, j));
    // A frame is thin on every side; anything wider is the cover's own background.
    if (Math.min(top, bottom, left, right) < 1 || Math.max(top, bottom, left, right) >= 16) return null;
    const pad = 1; // clear the soft edge where frame meets picture
    return { x: (left + pad) / N, y: (top + pad) / N, w: (N - left - right - 2 * pad) / N, h: (N - top - bottom - 2 * pad) / N };
  }

  // The ambient light is the cover itself: drawn small, blurred, saturated, then shown huge.
  // A tiny canvas scaled up by the compositor is nearly free to rotate.
  function paintAmbient(canvas, cover, flip, tone) {
    const S = canvas.width, ctx = canvas.getContext('2d');
    const base = tone === 'light' ? [238, 235, 229] : [22, 23, 26];
    ctx.fillStyle = cover ? `rgb(${cover.avg.join(' ')})` : `rgb(${base.join(' ')})`;
    ctx.fillRect(0, 0, S, S);
    if (cover) {
      ctx.save();
      if (flip) { ctx.translate(S / 2, S / 2); ctx.rotate(Math.PI * 0.75); ctx.translate(-S / 2, -S / 2); }
      if ('filter' in ctx) {
        ctx.filter = `blur(${S / 12}px) saturate(${tone === 'light' ? 1.3 : 1.7})`;
        ctx.drawImage(cover.img, -S * 0.2, -S * 0.2, S * 1.4, S * 1.4);
      } else {
        // No canvas filters: a tiny draw scaled back up is a blur of its own.
        const t = document.createElement('canvas');
        t.width = t.height = 6;
        t.getContext('2d').drawImage(cover.img, 0, 0, 6, 6);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(t, -S * 0.2, -S * 0.2, S * 1.4, S * 1.4);
      }
      ctx.restore();
      ctx.filter = 'none';
    }
    if (tone === 'light') {
      // Paper: the cover's colour, washed toward white.
      ctx.fillStyle = 'rgba(247, 245, 240, 0.62)';
    } else {
      // Bring every cover to the same dim light, so white text always reads.
      const l = cover?.lum ?? 0.5;
      ctx.fillStyle = `rgba(0, 0, 0, ${clamp(1 - 0.2 / Math.max(l, 0.01), 0.18, 0.72).toFixed(3)})`;
    }
    ctx.fillRect(0, 0, S, S);
  }

  function mount(root, options = {}) {
    const o = {
      tone: 'dark',            // ambient light: 'dark' (under white text) or 'light' (paper, under dark text)
      restWhenPaused: false,   // the arm goes home when the music stops
      armDelay: 0,             // ms the arm waits after play before swinging in
      arrowKeys: true,         // ←/→ skip songs
      apiBase: '',
      assetBase: '',
      ...options,
    };
    const $ = (id) => root.querySelector('#' + id);
    const el = {
      record: $('record'), spin: $('spin'), sheen: $('sheen'), label: $('label'),
      arm: $('arm'), armShadow: $('armShadow'), sleeve: $('sleeve'), ambient: $('ambient'),
      title: $('title'), sub: $('sub'), artist: $('artist'), album: $('album'), source: $('source'), credit: $('credit'),
      scrub: $('scrub'), fill: $('fill'), elapsed: $('elapsed'), remaining: $('remaining'),
      prev: $('prev'), play: $('play'), next: $('next'), vol: $('vol'), volFill: $('volFill'), full: $('fullscreen'),
    };
    let alive = true;
    const cleanups = [];
    const on = (target, type, fn, opts) => {
      if (!target) return;
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };

    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motion.matches;
    on(motion, 'change', (e) => { reduced = e.matches; });

    // ---------- what is playing ----------
    const model = { mode: 'demo', status: 'paused', track: null, position: 0, at: now(), volume: 64, sourceLabel: '' };
    let scrubbing = null;     // seconds while the scrubber is held
    let holdStatusUntil = 0;  // keep an optimistic play/pause until the Mac catches up
    let liftUntil = 0;        // lift the arm early when the user skips
    let quickUntil = 0;       // a skip the user asked for swaps briskly
    let dir = 1;              // +1 forward (next arrives from the right), -1 back
    let playSince = 0;

    const isSong = (t) => !!t && !t.status;
    const playing = () => model.status === 'playing' && isSong(model.track);
    function positionNow() {
      if (!isSong(model.track)) return 0;
      if (scrubbing != null) return scrubbing;
      const p = model.position + (playing() ? (now() - model.at) / 1000 : 0);
      return model.track.duration ? clamp(p, 0, model.track.duration) : Math.max(0, p);
    }

    // ---------- physics ----------
    const phys = { platterV: 0, rec: Math.random() * 360, recV: 0, arm: REST, armV: 0, lift: 0, sheen: 0, sheenV: 0, sheenTarget: 0, seated: false, look: 0, lookPhase: 0 };
    const geom = { R: 300, scrubW: 300 };
    let shown = null, pending = null, swapping = false;
    const approach = (v, target, tau, dt) => v + (target - v) * (1 - Math.exp(-dt / tau));

    function step(dt) {
      const motor = playing() && !reduced;
      phys.platterV = approach(phys.platterV, motor ? SPEED : 0, motor ? 0.9 : 1.6, dt);
      phys.recV = phys.seated ? approach(phys.recV, phys.platterV, 0.2, dt) : approach(phys.recV, 0, 1.6, dt);
      phys.rec += phys.recV * dt;

      let target = REST, lift = 0;
      const home = o.restWhenPaused && (!playing() || now() - playSince < o.armDelay);
      const onRecord = !swapping && !home && isSong(shown) && shown.id === model.track?.id;
      if (onRecord) {
        target = armFor(shown.duration ? positionNow() / shown.duration : 0);
        lift = playing() && scrubbing == null ? 0 : 1;
      }
      if (now() < liftUntil) lift = 1;
      const far = Math.abs(target - phys.arm) > 0.3;
      if (far) lift = 1;

      if (reduced) {
        phys.arm = target; phys.armV = 0; phys.lift = lift;
      } else {
        phys.lift = approach(phys.lift, lift, 0.09, dt);
        if (!far && phys.lift < 0.5) {
          phys.arm = target; phys.armV = 0;
        } else if (!far || phys.lift > 0.75) {
          // A critically damped spring: no bounce, settles in about 0.6s.
          const k = 55, c = 2 * Math.sqrt(k);
          phys.armV += (k * (target - phys.arm) - c * phys.armV) * dt;
          phys.arm += phys.armV * dt;
        }
      }

      const k = 18, c = 2 * Math.sqrt(k) * 0.85;
      phys.sheenV += (k * (phys.sheenTarget - phys.sheen) - c * phys.sheenV) * dt;
      phys.sheen += phys.sheenV * dt;

      // While a song plays, the view into the cover circles slowly, once every 16s, so its
      // depth shows; on pause it comes to rest.
      phys.look = approach(phys.look, playing() && !reduced ? 1 : 0, 1.5, dt);
      if (phys.look > 0.001) phys.lookPhase += dt * (2 * Math.PI / 16);

      return phys.look > 0.001 || Math.abs(phys.platterV) > 0.05 || Math.abs(phys.recV) > 0.05 || far ||
        Math.abs(phys.lift - lift) > 0.002 || Math.abs(phys.armV) > 0.01 ||
        Math.abs(phys.sheenTarget - phys.sheen) > 0.01 || Math.abs(phys.sheenV) > 0.01 ||
        playing() || scrubbing != null || swapping || home;
    }

    function render() {
      const R = geom.R, lift = phys.lift;
      if (el.spin) el.spin.style.transform = `rotate(${(phys.rec % 360).toFixed(2)}deg)`;
      if (el.sheen) el.sheen.style.transform = `rotate(${(-40 + phys.sheen).toFixed(2)}deg)`;
      if (el.arm) el.arm.style.transform = `rotate(${phys.arm.toFixed(3)}deg) scale(${(1 + 0.02 * lift).toFixed(4)})`;
      if (el.armShadow) {
        el.armShadow.style.transform =
          `translate(${(R * (0.012 + 0.045 * lift)).toFixed(1)}px, ${(R * (0.02 + 0.07 * lift)).toFixed(1)}px) rotate(${phys.arm.toFixed(3)}deg)`;
        el.armShadow.style.opacity = (0.45 - 0.2 * lift).toFixed(3);
      }
      depth.draw(0.75 * phys.look * Math.cos(phys.lookPhase), 0.5 * phys.look * Math.sin(phys.lookPhase));
      renderProgress();
    }

    let lastSecond = -1, lastDuration = -1;
    function renderProgress() {
      if (swapping && shown?.id !== model.track?.id) return;
      const song = isSong(model.track) ? model.track : null;
      const d = song?.duration || 0;
      const p = positionNow();
      const f = d ? clamp(p / d, 0, 1) : 0;
      if (el.fill) el.fill.style.transform = `scaleX(${f.toFixed(4)})`;
      const sec = Math.floor(p);
      if (sec !== lastSecond || d !== lastDuration) {
        lastSecond = sec; lastDuration = d;
        if (el.elapsed) el.elapsed.textContent = song ? clock(p) : '0:00';
        if (el.remaining) el.remaining.textContent = song && d ? `-${clock(Math.max(0, d - p))}` : song ? 'Live' : '-0:00';
        if (el.scrub) {
          el.scrub.setAttribute('aria-valuemax', String(Math.round(d)));
          el.scrub.setAttribute('aria-valuenow', String(sec));
          el.scrub.setAttribute('aria-valuetext', d ? `${clock(p)} of ${clock(d)}` : clock(p));
        }
      }
    }
    const clock = (s) => {
      s = Math.max(0, Math.floor(s));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
    };

    let rafId = 0, last = 0;
    function frame(t) {
      if (!alive) return;
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
      last = t;
      if (model.mode === 'demo') demo.tick();
      const busy = step(dt);
      render();
      rafId = busy ? requestAnimationFrame(frame) : 0;
    }
    function wake() {
      if (alive && !rafId) { last = now(); rafId = requestAnimationFrame(frame); }
    }

    // ---------- light ----------
    function showAmbient(cover) {
      if (!el.ambient) return;
      const slot = document.createElement('div');
      slot.className = 'amb-slot';
      for (let i = 0; i < 2; i++) {
        const c = document.createElement('canvas');
        c.className = `amb-layer l${i + 1}`;
        c.width = c.height = 96;
        paintAmbient(c, cover, i === 1, o.tone);
        slot.append(c);
      }
      el.ambient.append(slot);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta && cover) {
        const k = o.tone === 'light' ? 0 : 0.35;
        meta.setAttribute('content', o.tone === 'light' ? '#efece6' : `rgb(${cover.avg.map((v) => Math.round(v * k)).join(' ')})`);
      }
      slot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 300 : 1200, easing: 'ease', fill: 'forwards' })
        .finished.then(() => { while (el.ambient.firstChild && el.ambient.firstChild !== slot) el.ambient.firstChild.remove(); })
        .catch(() => {});
    }

    function setArt(holder, cover, fade) {
      if (!holder) return;
      const old = [...holder.querySelectorAll('img')];
      holder.classList.toggle('has-art', !!cover);
      if (!cover) { old.forEach((n) => n.remove()); return; }
      const img = new Image();
      img.alt = '';
      img.src = cover.url;
      // On the label, a framed cover is shown from inside its frame.
      const f = holder === el.label && cover.frame;
      if (f) {
        const k = 100 / Math.min(f.w, f.h);
        Object.assign(img.style, {
          width: `${k}%`, height: `${k}%`,
          left: `${50 - (f.x + f.w / 2) * k}%`, top: `${50 - (f.y + f.h / 2) * k}%`,
        });
      }
      holder.append(img);
      if (fade && !reduced) {
        img.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 300, easing: EASE_OUT })
          .finished.then(() => old.forEach((n) => n.remove())).catch(() => {});
      } else {
        old.forEach((n) => n.remove());
      }
    }

    // ---------- depth ----------
    // The cover's subject lifts off the sleeve. The helper finds the subject (api/depth); here
    // it becomes a soft depth map, nearer toward the bottom, and a WebGL layer over the cover
    // shifts each pixel by its depth as the view circles. Until then the plain cover shows.
    const depth = (() => {
      const VERT = 'attribute vec2 p; varying vec2 uv; void main() { uv = vec2(p.x, -p.y) * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
      // Each pixel looks back along its shift a few times, so the subject's edge stays clean.
      // The cover's own edges hold still, so nothing past them is ever shown.
      const FRAG = `precision mediump float;
        uniform sampler2D art, dep; uniform vec2 shift; varying vec2 uv;
        void main() {
          vec2 e = min(uv, 1.0 - uv);
          vec2 s = shift * smoothstep(0.0, 0.1, min(e.x, e.y));
          vec2 q = uv;
          for (int i = 0; i < 5; i++) q = uv - s * (texture2D(dep, q).r - 0.2);
          gl_FragColor = texture2D(art, clamp(q, 0.0, 1.0));
        }`;
      let canvas = null, gl = null, ready = false, token = 0, drawn = '';

      function setup() {
        canvas = document.createElement('canvas');
        canvas.className = 'depth';
        gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false });
        if (!gl) return false;
        const prog = gl.createProgram();
        for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
          const sh = gl.createShader(type);
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          gl.attachShader(prog, sh);
        }
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        [['art', 0], ['dep', 1]].forEach(([name, unit]) => {
          gl.uniform1i(gl.getUniformLocation(prog, name), unit);
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        });
        canvas.shift = gl.getUniformLocation(prog, 'shift');
        el.sleeve.append(canvas);
        return true;
      }

      // Depth from the mask: the ground comes nearer toward the bottom; the subject stands in front.
      function depthMap(mask) {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, 256);
        g.addColorStop(0, '#000');
        g.addColorStop(1, '#5a5a5a');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 256, 256);
        if (mask) {
          ctx.globalCompositeOperation = 'lighten';
          ctx.filter = 'blur(5px)';
          ctx.globalAlpha = 0.9;
          ctx.drawImage(mask, 0, 0, 256, 256);
        }
        return c;
      }

      function hide() {
        token++;
        ready = false;
        if (canvas) canvas.style.opacity = '0';
      }

      async function show(track, cover) {
        hide();
        const mine = token;
        if (reduced || model.mode !== 'live' || !cover?.img || !el.sleeve) return;
        let mask;
        try {
          const res = await fetch(`${o.apiBase}api/depth/${encodeURIComponent(track.id)}`);
          // 204: no clear subject, so the cover gets only the ground.
          if (res.status === 200) mask = await createImageBitmap(await res.blob());
          else if (res.status !== 204) return;
        } catch { return; }
        if (mine !== token || !alive) return;
        if (!canvas && !setup()) { canvas = null; return; }
        const S = Math.min(1600, Math.round(el.sleeve.offsetWidth * (devicePixelRatio || 1)));
        canvas.width = canvas.height = S;
        gl.viewport(0, 0, S, S);
        gl.activeTexture(gl.TEXTURE0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cover.img);
        gl.activeTexture(gl.TEXTURE1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depthMap(mask));
        el.sleeve.append(canvas); // on top of the cover
        ready = true;
        drawn = '';
        draw(0.75 * phys.look * Math.cos(phys.lookPhase), 0.5 * phys.look * Math.sin(phys.lookPhase));
        canvas.style.opacity = '1';
      }

      function draw(x, y) {
        if (!ready) return;
        const key = x.toFixed(4) + y.toFixed(4);
        if (key === drawn) return;
        drawn = key;
        gl.uniform2f(canvas.shift, x * 0.035, y * 0.035);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      return { show, hide, draw };
    })();

    // ---------- the record swap ----------
    // A short, direction-aware slide: next arrives from the right, previous from the left.
    // Exits are quicker than entrances; a skip you asked for is quicker than a song ending.
    let recordAnim = null, sleeveAnim = null;
    function moveOut(quick) {
      phys.seated = false;
      const out = reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 14}%) scale(0.94)` }];
      const opts = { duration: reduced ? 160 : quick ? 220 : 380, easing: EASE_OUT, fill: 'forwards' };
      recordAnim?.cancel();
      recordAnim = el.record?.animate(out, opts);
      sleeveAnim?.cancel();
      sleeveAnim = el.sleeve?.animate(reduced ? out : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 6}%) scale(0.97)` }], opts);
      return Promise.all([recordAnim?.finished, sleeveAnim?.finished].map((p) => p?.catch(() => {})));
    }
    function moveIn(quick) {
      const inn = reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: `translateX(${dir * 14}%) scale(0.94)` }, { opacity: 1, transform: 'none' }];
      const opts = { duration: reduced ? 220 : quick ? 420 : 640, easing: EASE_OUT, fill: 'forwards' };
      recordAnim?.cancel();
      recordAnim = el.record?.animate(inn, { ...opts, delay: el.sleeve && !reduced ? 60 : 0 });
      sleeveAnim?.cancel();
      sleeveAnim = el.sleeve?.animate(reduced ? inn : [{ opacity: 0, transform: `translateX(${dir * 6}%) scale(0.97)` }, { opacity: 1, transform: 'none' }], opts);
      return Promise.all([recordAnim?.finished, sleeveAnim?.finished].map((p) => p?.catch(() => {})));
    }

    const TEXT = () => [el.title, el.sub, el.artist, el.album, el.credit].filter(Boolean);
    function textOut() {
      for (const n of TEXT()) {
        n.getAnimations().forEach((a) => a.cancel());
        n.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }]
          : [{ opacity: 1 }, { opacity: 0, transform: `translateX(${-dir * 6}px)`, filter: 'blur(4px)' }],
        { duration: 150, easing: EASE_OUT, fill: 'forwards' });
      }
    }
    function textIn() {
      TEXT().forEach((n, i) => {
        n.getAnimations().forEach((a) => a.cancel());
        n.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ opacity: 0, transform: `translateX(${dir * 10}px)`, filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
        { duration: reduced ? 200 : 360, delay: reduced ? 0 : 40 * i, easing: EASE_OUT, fill: 'backwards' });
      });
    }

    function writeText(t) {
      const by = [t.artist, t.album].filter(Boolean).join(' — ');
      if (el.title) { el.title.textContent = t.title; el.title.title = t.title; }
      if (el.sub) { el.sub.textContent = by; el.sub.title = by; }
      if (el.artist) el.artist.textContent = t.artist || '';
      if (el.album) el.album.textContent = t.album || '';
      if (el.credit) {
        el.credit.replaceChildren();
        if (t.credit) {
          const a = document.createElement('a');
          a.href = t.creditUrl; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = t.credit;
          el.credit.append('Cover: ', a, '. The Met, public domain.');
        }
      }
      document.title = isSong(t) ? `${t.title} · ${t.artist || 'Vinyl'}` : 'Vinyl';
    }

    function want(track) {
      if (pending) { pending = track; return; }
      if (shown && shown.id === track.id) { shown = track; return; }
      pending = track;
      if (!swapping) swap();
    }

    async function swap() {
      swapping = true;
      wake();
      const quick = () => now() < quickUntil;
      let textFor = null;
      if (shown) {
        // A skip you asked for answers at once in the words; the record waits for the needle.
        if (quick() && pending) {
          textOut();
          await sleep(150);
          if (!alive) return;
          textFor = pending;
          writeText(textFor);
          textIn();
        }
        const t0 = now();
        while (alive && phys.arm > OFF_RECORD && now() - t0 < (quick() ? 300 : 900) && !reduced) await sleep(20);
        if (!textFor) textOut();
        await moveOut(quick());
      }
      while (alive && pending) {
        const track = pending;
        const cover = await Promise.race([loadCover(track.art), sleep(1600).then(() => undefined)]);
        if (!alive) return;
        if (pending !== track) continue;
        pending = null;
        shown = track;
        setArt(el.label, cover || null, false);
        setArt(el.sleeve, cover || null, false);
        showAmbient(cover || null);
        depth.show(track, cover);
        if (textFor !== track) { writeText(track); textIn(); }
        textFor = null;
        phys.recV = 0;
        await moveIn(quick());
        if (!alive) return;
        phys.seated = true;
        if (cover === undefined) {
          loadCover(track.art).then((c) => {
            if (c && alive && shown === track) { setArt(el.label, c, true); setArt(el.sleeve, c, true); showAmbient(c); depth.show(track, c); }
          });
        }
        if (pending) {
          textOut();
          await sleep(150);
          if (pending) { textFor = pending; writeText(textFor); textIn(); }
          await moveOut(true);
        }
      }
      swapping = false;
      wake();
    }

    // ---------- state in, state out ----------
    function statusTrack(status, message) {
      const copy = {
        idle: ['Nothing playing', 'Start a song in Music or Spotify.'],
        permission: ['Allow Vinyl to see your music', 'System Settings → Privacy & Security → Automation'],
        error: ['Can’t reach your music app', message || 'The helper hit an error talking to Music or Spotify.'],
        offline: ['Lost the helper', 'Reconnecting… keep npm start running.'],
      }[status];
      return { id: `status:${status}`, status, title: copy[0], artist: copy[1], album: '', duration: 0 };
    }

    function sync() {
      const was = root.dataset.playing === 'true';
      root.dataset.playing = String(playing());
      if (playing() && !was) playSince = now();
      root.dataset.mode = model.mode;
      el.play?.setAttribute('aria-label', playing() ? 'Pause' : 'Play');
      if (el.play) el.play.title = playing() ? 'Pause (Space)' : 'Play (Space)';
      const disabled = !isSong(model.track) && model.mode === 'live';
      [el.prev, el.play, el.next].forEach((b) => { if (b) b.disabled = disabled; });
      renderVolume();
      renderSource();
      if (model.track) want(model.track);
      wake();
    }

    function renderSource() {
      if (!el.source) return;
      el.source.replaceChildren();
      if (model.mode === 'demo') {
        el.source.append('Demo');
        return;
      }
      const label = model.sourceLabel || 'your Mac';
      el.source.textContent = {
        playing: label, paused: label, idle: 'Connected', permission: 'Waiting for permission',
        error: 'Something went wrong', offline: 'Reconnecting…',
      }[model.status] || '';
    }

    function renderVolume() {
      const v = Math.round(model.volume);
      if (el.volFill) el.volFill.style.transform = `scaleX(${v / 100})`;
      el.vol?.setAttribute('aria-valuenow', String(v));
    }

    // ---------- sources ----------
    const demo = {
      list: (window.VINYL_DEMO || []).map((t, i) => ({ ...t, art: o.assetBase + t.art, id: `demo:${i}` })),
      i: 0,
      start() { model.mode = 'demo'; model.status = 'playing'; model.sourceLabel = 'Demo'; this.load(0, 74); },
      load(i, at = 0) {
        if (!this.list.length) return;
        this.i = (i + this.list.length) % this.list.length;
        model.track = this.list[this.i];
        model.position = at;
        model.at = now();
        sync();
      },
      tick() {
        if (playing() && model.track.duration && positionNow() >= model.track.duration) { dir = 1; this.load(this.i + 1); }
      },
      send(action, value) {
        if (action === 'next') this.load(this.i + 1);
        else if (action === 'previous') this.load(this.i - 1);
        else if (action === 'volume') model.volume = value;
        sync();
        return Promise.resolve();
      },
    };

    const live = {
      events: null,
      connect() {
        model.mode = 'live';
        this.events = new EventSource(o.apiBase + 'api/events');
        this.events.onmessage = (e) => { try { this.apply(JSON.parse(e.data)); } catch {} };
        this.events.onerror = () => {
          if (model.status === 'offline') return;
          model.status = 'offline';
          model.track = statusTrack('offline');
          sync();
        };
      },
      apply(s) {
        if (!alive) return;
        if (!s.available) { this.events?.close(); demo.start(); return; }
        model.sourceLabel = s.sourceLabel || '';
        if (!s.track) {
          model.status = s.status === 'permission' || s.status === 'error' ? s.status : 'idle';
          model.track = statusTrack(model.status, s.message);
          return sync();
        }
        const same = model.track?.id === s.track.id;
        if (!same && now() > quickUntil) dir = 1;
        const status = s.status === 'playing' ? 'playing' : 'paused';
        if (now() > holdStatusUntil || status === model.status) model.status = status;
        if (!same) model.track = { ...s.track, art: o.apiBase + s.track.art };
        else Object.assign(model.track, { duration: s.track.duration });
        if (scrubbing == null) {
          const predicted = positionNow();
          if (!same || Math.abs(predicted - s.position) > 0.75 || model.status !== 'playing') {
            model.position = s.position;
            model.at = now();
          }
        }
        if (!volDrag) model.volume = s.volume ?? model.volume;
        sync();
      },
      send(action, value) {
        return fetch(o.apiBase + 'api/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-vinyl': '1' },
          body: JSON.stringify({ action, value }),
        }).then((r) => (r.ok ? r.json() : null)).then((s) => s && this.apply(s)).catch(() => {});
      },
    };
    const source = () => (model.mode === 'live' ? live : demo);

    // ---------- controls ----------
    function act(action, value) {
      if (!isSong(model.track)) return;
      if (action === 'playpause') {
        model.position = positionNow(); model.at = now();
        model.status = playing() ? 'paused' : 'playing';
        holdStatusUntil = now() + 1500;
        sync();
      }
      if (action === 'next' || action === 'previous') {
        dir = action === 'next' ? 1 : -1;
        liftUntil = now() + 1200;
        quickUntil = now() + 1500;
      }
      if (action === 'previous' && positionNow() > 3) { action = 'seek'; value = 0; liftUntil = 0; quickUntil = 0; }
      if (action === 'seek') {
        value = clamp(value, 0, model.track.duration || value);
        model.position = value; model.at = now();
      }
      wake();
      source().send(action, value);
    }

    on(el.play, 'click', () => act('playpause'));
    on(el.next, 'click', () => act('next'));
    on(el.prev, 'click', () => act('previous'));
    // Touching the record stops it, the way it would on a real deck.
    on(el.record, 'click', () => act('playpause'));

    // A slider you can grab anywhere: the value jumps to the pointer and follows it 1:1.
    function slider(node, { get, set, end, keys }) {
      if (!node) return;
      const at = (e) => { const r = node.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
      let held = false;
      on(node, 'pointerdown', (e) => {
        if (e.button > 0) return;
        held = true;
        node.setPointerCapture(e.pointerId);
        node.classList.add('dragging');
        set(at(e));
      });
      on(node, 'pointermove', (e) => { if (held) set(at(e)); });
      const stop = () => { if (!held) return; held = false; node.classList.remove('dragging'); end?.(); };
      on(node, 'pointerup', stop);
      on(node, 'pointercancel', stop);
      on(node, 'keydown', (e) => {
        const step = keys[e.key];
        if (step == null) return;
        e.preventDefault();
        e.stopPropagation();
        set(clamp(get() + step, 0, 1));
        end?.();
      });
    }

    slider(el.scrub, {
      get: () => (model.track?.duration ? positionNow() / model.track.duration : 0),
      set: (f) => { if (isSong(model.track) && model.track.duration) { scrubbing = f * model.track.duration; wake(); } },
      end: () => { if (scrubbing == null) return; const to = scrubbing; scrubbing = null; act('seek', to); },
      keys: { ArrowRight: 0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1, Home: -1, End: 1 },
    });

    let volDrag = false, volumeTimer = 0;
    function setVolume(v) {
      model.volume = clamp(Math.round(v), 0, 100);
      renderVolume();
      clearTimeout(volumeTimer);
      volumeTimer = setTimeout(() => source().send('volume', model.volume), 90);
    }
    slider(el.vol, {
      get: () => model.volume / 100,
      set: (f) => { volDrag = true; setVolume(f * 100); },
      end: () => { volDrag = false; },
      keys: { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05, Home: -1, End: 1 },
    });
    on(el.vol, 'wheel', (e) => {
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY;
      setVolume(model.volume + d * 0.06);
    }, { passive: false });

    // Keyboard shortcuts switch state instantly: they are pressed far too often to animate.
    on(window, 'keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const onButton = e.target.closest?.('button, a');
      const instant = () => {
        root.dataset.instant = '';
        requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.instant));
      };
      if (e.key === ' ' && !onButton) { e.preventDefault(); instant(); act('playpause'); }
      else if (o.arrowKeys && e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? act('seek', positionNow() + 10) : act('next'); }
      else if (o.arrowKeys && e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? act('seek', positionNow() - 10) : act('previous'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(model.volume + 5); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(model.volume - 5); }
      else if (e.key === 'f' || e.key === 'F') toggleFull();
    });

    // ---------- full screen, idle, light ----------
    let wakeLock = null;
    async function holdScreen(want) {
      try {
        if (want && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
        if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
      } catch { wakeLock = null; }
    }
    function toggleFull() {
      const d = document;
      const active = d.fullscreenElement || d.webkitFullscreenElement;
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      try { (active ? exit?.call(d) : req?.call(root))?.catch?.(() => {}); } catch {}
    }
    on(el.full, 'click', toggleFull);
    const onFull = () => {
      const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFull) root.dataset.full = ''; else delete root.dataset.full;
      el.full?.setAttribute('aria-label', isFull ? 'Exit full screen' : 'Full screen');
      holdScreen(isFull);
    };
    on(document, 'fullscreenchange', onFull);
    on(document, 'webkitfullscreenchange', onFull);

    let idleTimer = 0;
    on(window, 'pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        delete root.dataset.idle;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { root.dataset.idle = ''; }, 2600);
      }
      // The light on the vinyl leans toward the pointer, on a spring.
      if (!reduced) {
        phys.sheenTarget = (e.clientX / innerWidth - 0.5) * 16 + (e.clientY / innerHeight - 0.5) * -6;
        wake();
      }
    }, { passive: true });

    // ---------- layout ----------
    function measure() {
      geom.R = (el.record?.offsetWidth || 600) / 2;
      geom.scrubW = el.scrub?.clientWidth || geom.scrubW;
      renderProgress();
    }
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    cleanups.push(() => ro.disconnect());

    // ---------- start ----------
    (async () => {
      measure();
      showAmbient(null);
      let s = null;
      try {
        const res = await Promise.race([fetch(o.apiBase + 'api/state', { cache: 'no-store' }), sleep(1500).then(() => null)]);
        if (res && res.ok && (res.headers.get('content-type') || '').includes('json')) s = await res.json();
      } catch {}
      if (!alive) return;
      if (s && s.ok && s.available) live.connect();
      else demo.start();
    })();

    return {
      destroy() {
        alive = false;
        cleanups.forEach((f) => f());
        cancelAnimationFrame(rafId);
        clearTimeout(idleTimer);
        clearTimeout(volumeTimer);
        live.events?.close();
        holdScreen(false);
      },
    };
  }

  mount(document.getElementById('app'), { tone: 'light', restWhenPaused: true, armDelay: 520 });
})();
