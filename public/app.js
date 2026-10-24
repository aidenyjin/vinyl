(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motion.matches;
  motion.addEventListener?.('change', (e) => { reduced = e.matches; });

  // ---------- tonearm geometry, in record radii with the spindle at 0,0 ----------
  const PIVOT = { x: 1.12, y: -0.78 };
  const STYLUS = { x: -0.0752, y: 1.439 }; // stylus tip in the arm's own frame
  const REST = -4;                          // degrees, arm on its rest post
  const OUTER = 0.955;                      // lead-in groove
  const INNER = 0.52;                       // run-out groove
  const SPEED = (100 / 3) * 6;              // 33⅓ rpm in degrees per second

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

  // ---------- elements ----------
  const el = {
    app: $('app'), record: $('record'), spin: $('spin'), strobe: $('strobe'), sheen: $('sheen'),
    arm: $('arm'), armShadow: $('armShadow'), label: $('label'),
    sourceText: $('sourceText'), title: $('title'), artist: $('artist'), album: $('album'), credit: $('credit'),
    scrub: $('scrub'), fill: $('fill'), thumb: $('thumb'), elapsed: $('elapsed'), remaining: $('remaining'),
    prev: $('prev'), play: $('play'), next: $('next'),
    knob: $('knob'), knobLevel: $('knobLevel'), knobValue: $('knobValue'), full: $('fullscreen'),
  };

  // ---------- what is playing ----------
  const model = {
    mode: 'demo',
    status: 'paused',       // playing | paused | idle | permission | error | offline
    track: null,            // { id, title, artist, album, duration, art, credit?, creditUrl? }
    position: 0,
    at: now(),
    volume: 64,
    sourceLabel: '',
  };
  let scrubbing = null;     // seconds while the scrubber is held
  let holdStatusUntil = 0;  // keep an optimistic play/pause until the Mac catches up
  let liftUntil = 0;        // lift the arm early when the user skips

  const isSong = (t) => !!t && !t.status;
  const playing = () => model.status === 'playing' && isSong(model.track);
  function positionNow() {
    if (!isSong(model.track)) return 0;
    if (scrubbing != null) return scrubbing;
    const p = model.position + (playing() ? (now() - model.at) / 1000 : 0);
    return model.track.duration ? clamp(p, 0, model.track.duration) : Math.max(0, p);
  }

  // ---------- physics ----------
  const phys = {
    platter: 0, platterV: 0,
    rec: Math.random() * 360, recV: 0,
    arm: REST, armV: 0,
    lift: 0,
    sheen: 0, sheenV: 0, sheenTarget: 0,
    seated: false,
  };
  const geom = { R: 300, scrubW: 300 };
  let shown = null;         // the record on the platter
  let pending = null;       // the record waiting to go on
  let swapping = false;

  const approach = (v, target, tau, dt) => v + (target - v) * (1 - Math.exp(-dt / tau));

  function step(dt) {
    const motor = playing() && !reduced;
    phys.platterV = approach(phys.platterV, motor ? SPEED : 0, motor ? 0.35 : 0.8, dt);
    phys.platter += phys.platterV * dt;
    phys.recV = phys.seated ? approach(phys.recV, phys.platterV, 0.2, dt) : approach(phys.recV, 0, 1.6, dt);
    phys.rec += phys.recV * dt;

    // Where the needle should be, and whether the cue lever is up.
    let target = REST, lift = 0;
    const onRecord = !swapping && isSong(shown) && shown.id === model.track?.id;
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

    return Math.abs(phys.platterV) > 0.05 || Math.abs(phys.recV) > 0.05 || far ||
      Math.abs(phys.lift - lift) > 0.002 || Math.abs(phys.armV) > 0.01 ||
      Math.abs(phys.sheenTarget - phys.sheen) > 0.01 || Math.abs(phys.sheenV) > 0.01 ||
      playing() || scrubbing != null || swapping;
  }

  function render() {
    const R = geom.R, lift = phys.lift;
    el.spin.style.transform = `rotate(${(phys.rec % 360).toFixed(2)}deg)`;
    el.strobe.style.transform = `rotate(${(phys.platter % 360).toFixed(2)}deg)`;
    el.sheen.style.transform = `rotate(${(-40 + phys.sheen).toFixed(2)}deg)`;
    el.arm.style.transform = `rotate(${phys.arm.toFixed(3)}deg) scale(${(1 + 0.02 * lift).toFixed(4)})`;
    el.armShadow.style.transform =
      `translate(${(R * (0.012 + 0.045 * lift)).toFixed(1)}px, ${(R * (0.02 + 0.07 * lift)).toFixed(1)}px) rotate(${phys.arm.toFixed(3)}deg)`;
    el.armShadow.style.opacity = (0.5 - 0.22 * lift).toFixed(3);
    renderProgress();
  }

  let lastSecond = -1, lastDuration = -1;
  function renderProgress() {
    if (swapping && shown?.id !== model.track?.id) return; // the old song's time stays until its record leaves
    const song = isSong(model.track) ? model.track : null;
    const d = song?.duration || 0;
    const p = positionNow();
    const f = d ? clamp(p / d, 0, 1) : 0;
    el.fill.style.transform = `scaleX(${f.toFixed(4)})`;
    el.thumb.style.transform = `translateX(${(f * geom.scrubW).toFixed(1)}px)`;
    const sec = Math.floor(p);
    if (sec !== lastSecond || d !== lastDuration) {
      lastSecond = sec; lastDuration = d;
      el.elapsed.textContent = song ? clock(p) : '0:00';
      el.remaining.textContent = song && d ? `-${clock(Math.max(0, d - p))}` : song ? 'Live' : '-0:00';
      el.scrub.setAttribute('aria-valuemax', String(Math.round(d)));
      el.scrub.setAttribute('aria-valuenow', String(sec));
      el.scrub.setAttribute('aria-valuetext', d ? `${clock(p)} of ${clock(d)}` : clock(p));
    }
  }
  const clock = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  };

  let rafId = 0, last = 0;
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
    last = t;
    if (model.mode === 'demo') demo.tick();
    const busy = step(dt);
    render();
    rafId = busy ? requestAnimationFrame(frame) : 0;
  }
  function wake() {
    if (!rafId) { last = now(); rafId = requestAnimationFrame(frame); }
  }

  // ---------- colour from the cover ----------
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb(h, s, l) {
    const f = (n) => {
      const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  const luminance = ([r, g, b]) => {
    const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const css = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

  function readCover(img) {
    const size = 48, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    let data;
    try { data = ctx.getImageData(0, 0, size, size).data; } catch { return null; }
    const bins = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      total += l;
      const key = (s < 0.07 ? 12 : Math.floor(h * 12)) * 6 + Math.min(5, Math.floor(l * 6));
      let b = bins.get(key);
      if (!b) bins.set(key, (b = { n: 0, r: 0, g: 0, b: 0, s: 0 }));
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; b.s += s;
    }
    const list = [...bins.entries()].map(([key, b]) => ({
      key, n: b.n, sat: b.s / b.n, rgb: [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round),
    }));
    // The room takes the cover's largest area of real colour, not its greys.
    const main = list.reduce((a, b) => (b.n * (0.3 + b.sat) > a.n * (0.3 + a.sat) ? b : a));
    let accent = null, best = -1;
    for (const c of list) {
      const [, , l] = rgbToHsl(...c.rgb);
      if (c === main || l < 0.1 || l > 0.94) continue;
      const hueApart = Math.floor(c.key / 6) !== Math.floor(main.key / 6);
      const score = Math.sqrt(c.n) * (0.15 + c.sat) * (hueApart ? 1.4 : 0.6);
      if (score > best) { best = score; accent = c; }
    }
    const light = rgbToHsl(...main.rgb)[2] > 0.58 || total / (size * size) > 0.62;
    return theme(main.rgb, (accent || main).rgb, light);
  }

  function theme(mainRgb, accentRgb, light) {
    const [h, s, l] = rgbToHsl(...mainRgb);
    const field = light
      ? hslToRgb(h, Math.min(s, 0.34), clamp(l, 0.8, 0.88))
      : hslToRgb(h, Math.min(s * 0.9, 0.42), clamp(l * 0.7, 0.13, 0.24));
    const ink = light ? hslToRgb(h, Math.min(s, 0.3), 0.11) : hslToRgb(h, Math.min(s, 0.2), 0.94);
    let [ah, as, al] = rgbToHsl(...accentRgb);
    as = Math.min(as, 0.7);
    let accent = hslToRgb(ah, as, al);
    for (let i = 0; i < 40 && contrast(accent, field) < 3.2; i++) {
      al = clamp(al + (light ? -0.02 : 0.02), 0.05, 0.95);
      accent = hslToRgb(ah, as, al);
    }
    const onAccent = contrast(field, accent) >= contrast(ink, accent) ? field : ink;
    return { field: css(field), ink: css(ink), accent: css(accent), onAccent: css(onAccent), light };
  }

  const DEFAULT_THEME = { field: '#1c221f', ink: '#eef1ec', accent: '#d8c46c', onAccent: '#1c221f', light: false };
  function paint(t) {
    t = t || DEFAULT_THEME;
    const s = document.documentElement.style;
    s.setProperty('--field', t.field);
    s.setProperty('--ink', t.ink);
    s.setProperty('--accent', t.accent);
    s.setProperty('--on-accent', t.onAccent);
    s.colorScheme = t.light ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.field);
  }

  const covers = new Map();
  function loadCover(url) {
    if (!url) return Promise.resolve(null);
    if (!covers.has(url)) {
      covers.set(url, new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve({ url, theme: readCover(img) });
        img.onerror = () => { covers.delete(url); resolve(null); };
        img.src = url;
      }));
      if (covers.size > 30) covers.delete(covers.keys().next().value);
    }
    return covers.get(url);
  }
  const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => undefined)]);

  // ---------- the record swap ----------
  function setLabel(cover, fade) {
    const old = [...el.label.querySelectorAll('img')];
    el.label.classList.toggle('has-art', !!cover);
    if (!cover) { old.forEach((n) => n.remove()); return; }
    const img = new Image();
    img.alt = '';
    img.src = cover.url;
    el.label.insertBefore(img, el.label.querySelector('.blank').nextSibling);
    if (fade && !reduced) {
      img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: 'ease' }).finished.then(() => old.forEach((n) => n.remove()));
    } else {
      old.forEach((n) => n.remove());
    }
  }

  let recordAnim = null;
  function offscreen() {
    return -(el.record.offsetLeft + geom.R * 2.1);
  }
  function slideOut() {
    phys.seated = false;
    recordAnim?.cancel();
    if (reduced) {
      recordAnim = el.record.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    } else {
      const x = offscreen(), R = geom.R;
      recordAnim = el.record.animate([
        { transform: 'translate(0, 0) scale(1)' },
        { transform: 'translate(0, 0) scale(1.035)', offset: 0.2 },
        { transform: `translate(${x}px, ${R * 0.06}px) scale(1.035)` },
      ], { duration: 620, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'forwards' });
    }
    return recordAnim.finished.catch(() => {});
  }
  function slideIn() {
    recordAnim?.cancel();
    if (reduced) {
      recordAnim = el.record.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, fill: 'forwards' });
    } else {
      const x = offscreen(), R = geom.R;
      recordAnim = el.record.animate([
        { transform: `translate(${x}px, ${-R * 0.06}px) scale(1.035)` },
        { transform: 'translate(0, 0) scale(1.035)', offset: 0.82 },
        { transform: 'translate(0, 0) scale(1)' },
      ], { duration: 980, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' });
    }
    el.record.style.transform = '';
    return recordAnim.finished.catch(() => {});
  }

  function textOut() {
    for (const n of [el.title, el.artist, el.album, el.credit]) {
      n.getAnimations().forEach((a) => a.cancel());
      n.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)', filter: 'blur(3px)' }],
        { duration: 180, easing: 'ease-out', fill: 'forwards' });
    }
  }
  function textIn() {
    [el.title, el.artist, el.album, el.credit].forEach((n, i) => {
      n.getAnimations().forEach((a) => a.cancel());
      if (reduced) return;
      n.animate([{ opacity: 0, transform: 'translateY(12px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
        { duration: 520, delay: 60 * i, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' });
    });
  }

  function writeText(t) {
    el.title.textContent = t.title;
    el.artist.textContent = t.artist || '';
    el.album.textContent = t.album || '';
    el.credit.replaceChildren();
    if (t.credit) {
      el.credit.append('Cover: ');
      const a = document.createElement('a');
      a.href = t.creditUrl; a.target = '_blank'; a.rel = 'noopener';
      // Keep a date like 1870–90 on one line.
      const m = t.credit.match(/^(.*?)((?:ca\. )?\d{4}(?:–\d{2,4})?)(.*)$/);
      if (m) {
        const date = document.createElement('span');
        date.className = 'nowrap';
        date.textContent = m[2];
        a.append(m[1], date);
        el.credit.append(a, m[3] || '', m[3] && /\.$/.test(m[3]) ? ' The Met, public domain.' : '. The Met, public domain.');
      } else {
        a.textContent = t.credit;
        el.credit.append(a, '. The Met, public domain.');
      }
    }
    document.title = isSong(t) ? `${t.title} · ${t.artist || 'Vinyl'}` : 'Vinyl';
    fitTitle();
  }

  // Largest size that keeps the title to two lines.
  function fitTitle() {
    const t = el.title, w = t.clientWidth;
    if (!w) return;
    const narrow = el.app.clientWidth < 760 || el.app.clientWidth / el.app.clientHeight < 1.15;
    const max = narrow ? Math.min(76, w / 6.5) : clamp(w / 5.4, 40, 112);
    const min = narrow ? 26 : 30;
    const lines = () => Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight));
    t.style.fontSize = `${max}px`;
    if (lines() <= 2) return;
    let lo = min, hi = max;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      t.style.fontSize = `${mid}px`;
      if (lines() <= 2) lo = mid; else hi = mid;
    }
    t.style.fontSize = `${lo}px`;
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
    if (shown) {
      // Never pull a record out from under the needle.
      const t0 = now();
      while (phys.arm > OFF_RECORD && now() - t0 < 1400 && !reduced) await sleep(30);
      textOut();
      await slideOut();
    }
    while (pending) {
      const track = pending;
      const cover = await within(loadCover(track.art), 1600);
      if (pending !== track) continue;
      pending = null;
      shown = track;
      setLabel(cover || null, false);
      paint(cover?.theme);
      writeText(track);
      textIn();
      phys.recV = 0;
      await slideIn();
      phys.seated = true;
      if (cover === undefined) {
        loadCover(track.art).then((c) => { if (c && shown === track) { setLabel(c, true); paint(c.theme); } });
      }
      if (pending) { textOut(); await slideOut(); }
    }
    swapping = false;
    wake();
  }

  // ---------- state in, state out ----------
  function statusTrack(status, message) {
    const copy = {
      idle: ['Nothing playing', 'Start a song in Music or Spotify.', ''],
      permission: ['Allow Vinyl to see your music', 'Open System Settings, then Privacy & Security, then Automation.',
        'Turn on Music and Spotify under the app that runs the helper, such as Terminal.'],
      error: ['Can’t reach your music app', message || 'The helper hit an error talking to Music or Spotify.', ''],
      offline: ['Lost the helper', 'Reconnecting to your Mac…', 'Keep the Terminal window with npm start open.'],
    }[status];
    return { id: `status:${status}`, status, title: copy[0], artist: copy[1], album: copy[2], duration: 0 };
  }

  function sync() {
    el.app.dataset.playing = String(playing());
    el.app.dataset.mode = model.mode;
    el.play.setAttribute('aria-label', playing() ? 'Pause' : 'Play');
    const disabled = !isSong(model.track);
    [el.prev, el.play, el.next].forEach((b) => { b.disabled = disabled && model.mode === 'live'; });
    renderVolume();
    renderSource();
    if (model.track) want(model.track);
    wake();
  }

  function renderSource() {
    const t = el.sourceText;
    t.replaceChildren();
    if (model.mode === 'demo') {
      const a = document.createElement('a');
      a.href = 'https://github.com/aidenyjin/vinyl#readme'; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Show what your Mac is playing';
      t.append('Demo playlist. ', a);
      return;
    }
    const label = model.sourceLabel || 'your Mac';
    t.textContent = {
      playing: `Playing from ${label}`,
      paused: `Paused in ${label}`,
      idle: 'Connected to your Mac',
      permission: 'Waiting for permission',
      error: 'Something went wrong',
      offline: 'Reconnecting…',
    }[model.status] || '';
  }

  function renderVolume() {
    const v = Math.round(model.volume);
    el.knobLevel.style.strokeDasharray = `${(94.25 * v) / 100} 125.66`;
    el.knobValue.textContent = String(v);
    el.knob.setAttribute('aria-valuenow', String(v));
  }

  // ---------- the demo source ----------
  const demo = {
    list: (window.VINYL_DEMO || []).map((t, i) => ({ ...t, id: `demo:${i}` })),
    i: 0,
    start() {
      model.mode = 'demo';
      model.status = 'playing';
      model.sourceLabel = 'Demo';
      this.load(0, 74);
    },
    load(i, at = 0) {
      if (!this.list.length) return;
      this.i = (i + this.list.length) % this.list.length;
      model.track = this.list[this.i];
      model.position = at;
      model.at = now();
      sync();
    },
    tick() {
      if (playing() && model.track.duration && positionNow() >= model.track.duration) this.load(this.i + 1);
    },
    // act() has already flipped play/pause and moved the position.
    send(action, value) {
      if (action === 'next') this.load(this.i + 1);
      else if (action === 'previous') this.load(this.i - 1);
      else if (action === 'volume') model.volume = value;
      sync();
      return Promise.resolve();
    },
  };

  // ---------- the live source ----------
  const live = {
    events: null,
    connect() {
      model.mode = 'live';
      this.events = new EventSource('api/events');
      this.events.onmessage = (e) => { try { this.apply(JSON.parse(e.data)); } catch {} };
      this.events.onerror = () => {
        if (model.status === 'offline') return;
        model.status = 'offline';
        model.track = statusTrack('offline');
        sync();
      };
    },
    apply(s) {
      if (!s.available) { this.events?.close(); demo.start(); return; }
      model.sourceLabel = s.sourceLabel || '';
      if (!s.track) {
        model.status = s.status === 'permission' || s.status === 'error' ? s.status : 'idle';
        model.track = statusTrack(model.status, s.message);
        return sync();
      }
      const same = model.track?.id === s.track.id;
      const status = s.status === 'playing' ? 'playing' : 'paused';
      if (now() > holdStatusUntil || status === model.status) model.status = status;
      if (!same) model.track = { ...s.track };
      else Object.assign(model.track, { duration: s.track.duration });
      if (scrubbing == null) {
        const predicted = positionNow();
        if (!same || Math.abs(predicted - s.position) > 0.75 || model.status !== 'playing') {
          model.position = s.position;
          model.at = now();
        }
      }
      if (!knobDrag) model.volume = s.volume ?? model.volume;
      sync();
    },
    send(action, value) {
      return fetch('api/control', {
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
    if (action === 'next' || action === 'previous') liftUntil = now() + 1800;
    if (action === 'previous' && positionNow() > 3) { action = 'seek'; value = 0; liftUntil = 0; }
    if (action === 'seek') {
      value = clamp(value, 0, model.track.duration || value);
      model.position = value; model.at = now();
    }
    wake();
    source().send(action, value);
  }

  el.play.addEventListener('click', () => act('playpause'));
  el.next.addEventListener('click', () => act('next'));
  el.prev.addEventListener('click', () => act('previous'));

  // Scrubbing cues the tonearm across the record as you drag.
  function fractionAt(e) {
    const r = el.scrub.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }
  el.scrub.addEventListener('pointerdown', (e) => {
    if (!isSong(model.track) || !model.track.duration) return;
    el.scrub.setPointerCapture(e.pointerId);
    el.scrub.classList.add('dragging');
    scrubbing = fractionAt(e) * model.track.duration;
    wake();
  });
  el.scrub.addEventListener('pointermove', (e) => {
    if (scrubbing == null) return;
    scrubbing = fractionAt(e) * model.track.duration;
  });
  const endScrub = () => {
    if (scrubbing == null) return;
    const to = scrubbing;
    scrubbing = null;
    el.scrub.classList.remove('dragging');
    act('seek', to);
  };
  el.scrub.addEventListener('pointerup', endScrub);
  el.scrub.addEventListener('pointercancel', endScrub);
  el.scrub.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }[e.key];
    if (step == null && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    if (!isSong(model.track)) return;
    const d = model.track.duration || 0;
    act('seek', e.key === 'Home' ? 0 : e.key === 'End' ? Math.max(0, d - 1) : positionNow() + step);
  });

  // The volume knob: drag up or down, scroll, or use the arrow keys.
  let knobDrag = null, volumeTimer = 0;
  function setVolume(v) {
    model.volume = clamp(Math.round(v), 0, 100);
    renderVolume();
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => source().send('volume', model.volume), 90);
  }
  el.knob.addEventListener('pointerdown', (e) => {
    el.knob.setPointerCapture(e.pointerId);
    knobDrag = { y: e.clientY, v: model.volume };
  });
  el.knob.addEventListener('pointermove', (e) => {
    if (knobDrag) setVolume(knobDrag.v + (knobDrag.y - e.clientY) * 0.5);
  });
  const endKnob = () => { knobDrag = null; };
  el.knob.addEventListener('pointerup', endKnob);
  el.knob.addEventListener('pointercancel', endKnob);
  el.knob.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(model.volume - e.deltaY * 0.06); }, { passive: false });
  el.knob.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 2, ArrowRight: 2, ArrowDown: -2, ArrowLeft: -2, PageUp: 10, PageDown: -10 }[e.key];
    if (step == null && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    setVolume(e.key === 'Home' ? 0 : e.key === 'End' ? 100 : model.volume + step);
  });

  // Keyboard shortcuts. Icons switch instantly for keys; you press these a lot.
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const onButton = e.target.closest?.('button, a, input');
    const instant = () => {
      el.app.dataset.instant = '';
      requestAnimationFrame(() => requestAnimationFrame(() => delete el.app.dataset.instant));
    };
    if (e.key === ' ' && !onButton) { e.preventDefault(); instant(); act('playpause'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? act('seek', positionNow() + 10) : act('next'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? act('seek', positionNow() - 10) : act('previous'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(model.volume + 5); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(model.volume - 5); }
    else if (e.key === 'f' || e.key === 'F') toggleFull();
  });

  // ---------- full screen, idle cursor, light ----------
  let wakeLock = null;
  async function holdScreen(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }
  function toggleFull() {
    const doc = document;
    const active = doc.fullscreenElement || doc.webkitFullscreenElement;
    const req = el.app.requestFullscreen || el.app.webkitRequestFullscreen;
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    try {
      const p = active ? exit?.call(doc) : req?.call(el.app);
      p?.catch?.(() => {});
    } catch {}
  }
  el.full.addEventListener('click', toggleFull);
  const onFull = () => {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (on) el.app.dataset.full = ''; else delete el.app.dataset.full;
    el.full.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    holdScreen(on);
  };
  document.addEventListener('fullscreenchange', onFull);
  document.addEventListener('webkitfullscreenchange', onFull);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el.app.dataset.full != null) holdScreen(true); });

  let idleTimer = 0;
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      delete el.app.dataset.idle;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { el.app.dataset.idle = ''; }, 2600);
    }
    // The light on the vinyl follows the pointer a little.
    if (!reduced) {
      phys.sheenTarget = (e.clientX / innerWidth - 0.5) * 16 + (e.clientY / innerHeight - 0.5) * -6;
      wake();
    }
  }, { passive: true });

  // ---------- layout ----------
  function measure() {
    geom.R = el.record.offsetWidth / 2 || geom.R;
    geom.scrubW = el.scrub.clientWidth || geom.scrubW;
    fitTitle();
    renderProgress();
  }
  new ResizeObserver(measure).observe(el.app);
  document.fonts?.ready.then(fitTitle);

  // ---------- start ----------
  async function start() {
    measure();
    el.record.style.transform = `translateX(${offscreen()}px)`;
    let s = null;
    try {
      const res = await within(fetch('api/state', { cache: 'no-store' }), 1500);
      if (res && res.ok && (res.headers.get('content-type') || '').includes('json')) s = await res.json();
    } catch {}
    if (s && s.ok && s.available) live.connect();
    else demo.start();
  }
  start();
})();
