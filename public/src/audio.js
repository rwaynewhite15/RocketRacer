/* ==========================================================================
 * ROCKET RACER — audio.js
 * A tiny chip-synth on top of WebAudio: pulse/triangle/noise voices for
 * sound effects, a looping 16-bar chiptune, and an engine drone that follows
 * the player's throttle. Nothing is loaded from disk.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR;
  const A = (RR.audio = { muted: false });

  let ctx = null, master, musicBus, sfxBus, noiseBuf, pulse25, pulse12;
  let engOsc, engGain;

  function pulseWave(duty) {
    const N = 32, real = new Float32Array(N), imag = new Float32Array(N);
    for (let n = 1; n < N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    return ctx.createPeriodicWave(real, imag);
  }

  /** Must be called from a user gesture (key / tap) before any sound plays. */
  A.init = function () {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC(); } catch (e) { ctx = null; return; }

    master = ctx.createGain();
    master.gain.value = A.muted ? 0 : 0.55;
    master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.5; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.8; sfxBus.connect(master);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;

    pulse25 = pulseWave(0.25);
    pulse12 = pulseWave(0.125);

    // engine drone
    engOsc = ctx.createOscillator();
    engOsc.type = 'sawtooth';
    engOsc.frequency.value = 50;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 260;
    engGain = ctx.createGain(); engGain.gain.value = 0;
    engOsc.connect(lp); lp.connect(engGain); engGain.connect(sfxBus);
    engOsc.start();

    setInterval(tick, 25);
  };

  A.setMuted = function (m) {
    A.muted = !!m;
    if (ctx) master.gain.setTargetAtTime(A.muted ? 0 : 0.55, ctx.currentTime, 0.02);
  };

  /* ---------------------------------------------------------- primitives */

  function tone(wave, f0, f1, dur, vol, delay, bus) {
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    if (typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(bus || sfxBus);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function noise(dur, vol, f0, f1, delay, type, bus) {
    const t = ctx.currentTime + (delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type || 'lowpass';
    flt.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(flt); flt.connect(g); g.connect(bus || sfxBus);
    src.start(t, Math.random() * 0.9); src.stop(t + dur + 0.03);
  }

  function arp(wave, freqs, step, len, vol) {
    for (let i = 0; i < freqs.length; i++) tone(wave, freqs[i], freqs[i], len, vol, i * step);
  }

  /* ------------------------------------------------------- sound effects */

  const SFX = {
    beep: function (v) { tone('square', 440, 440, 0.13, 0.22 * v); },
    go: function (v) { tone('square', 880, 880, 0.4, 0.22 * v); tone(pulse25, 1320, 1320, 0.4, 0.1 * v); },
    select: function (v) { tone(pulse25, 700, 700, 0.05, 0.16 * v); },
    confirm: function (v) { arp(pulse25, [523, 784, 1047], 0.06, 0.1, 0.18 * v); },
    laser: function (v) { tone(pulse25, 1500, 320, 0.11, 0.17 * v); },
    missile: function (v) { noise(0.45, 0.22 * v, 700, 3200); tone('sawtooth', 180, 620, 0.32, 0.1 * v); },
    mine: function (v) { tone('square', 320, 140, 0.12, 0.16 * v); tone('square', 210, 210, 0.06, 0.12 * v, 0.12); },
    emp: function (v) { tone('sawtooth', 1400, 50, 0.7, 0.2 * v); noise(0.6, 0.2 * v, 4000, 200, 0, 'bandpass'); },
    zap: function (v) { tone(pulse12, 240, 60, 0.3, 0.16 * v); noise(0.25, 0.14 * v, 5000, 800, 0, 'highpass'); },
    boom: function (v) { noise(0.6, 0.55 * v, 1900, 70); tone('triangle', 150, 28, 0.5, 0.5 * v); },
    rock: function (v) { noise(0.28, 0.4 * v, 1300, 180); tone('triangle', 200, 60, 0.15, 0.2 * v); },
    bump: function (v) { noise(0.1, 0.3 * v, 700, 140); tone('triangle', 120, 48, 0.11, 0.32 * v); },
    hit: function (v) { noise(0.14, 0.3 * v, 2600, 400); tone('square', 260, 80, 0.14, 0.14 * v); },
    shield: function (v) { tone('sine', 320, 980, 0.22, 0.2 * v); tone(pulse12, 640, 1960, 0.22, 0.06 * v); },
    weapon: function (v) { arp(pulse25, [392, 523, 784], 0.055, 0.09, 0.17 * v); },
    power: function (v) { arp(pulse25, [523, 659, 784, 1047], 0.05, 0.09, 0.17 * v); },
    nitro: function (v) { noise(0.7, 0.3 * v, 300, 5000, 0, 'bandpass'); tone('sawtooth', 110, 700, 0.6, 0.12 * v); },
    cp: function (v) { tone('square', 988, 988, 0.07, 0.15 * v); tone('square', 1319, 1319, 0.2, 0.15 * v, 0.07); },
    lap: function (v) { arp('square', [523, 659, 784, 1047, 1319], 0.07, 0.14, 0.16 * v); },
    finish: function (v) {
      arp('square', [523, 523, 523, 659, 784, 659, 784, 1047], 0.11, 0.16, 0.17 * v);
      arp('triangle', [131, 131, 131, 165, 196, 165, 196, 262], 0.11, 0.16, 0.3 * v);
    },
    lose: function (v) { arp('square', [392, 330, 262, 196], 0.14, 0.2, 0.16 * v); },
  };

  const lastPlayed = {};
  A.sfx = function (name, vol) {
    if (!ctx || A.muted || ctx.state !== 'running') return;
    const f = SFX[name];
    if (!f) return;
    const now = ctx.currentTime;
    if (lastPlayed[name] && now - lastPlayed[name] < 0.035) return; // de-dupe bursts
    lastPlayed[name] = now;
    f(vol === undefined ? 1 : vol);
  };

  /** Engine drone: `on` gates it, `thrust` 0..~1.6, `speed` in px/s. */
  A.engine = function (on, thrust, speed) {
    if (!ctx) return;
    const t = ctx.currentTime;
    engGain.gain.setTargetAtTime(on ? 0.035 + 0.09 * Math.min(1.6, thrust) : 0, t, 0.06);
    engOsc.frequency.setTargetAtTime(44 + speed * 0.17 + thrust * 22, t, 0.08);
  };

  /* --------------------------------------------------------------- music */

  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(name) {
    const m = /^([A-G])(#?)(\d)$/.exec(name);
    return 12 * (+m[3] + 1) + NOTE[m[1]] + (m[2] ? 1 : 0);
  }
  const BASS = { A: 45, F: 41, C: 48, G: 43, E: 40 };

  // [chord root, minor?, lead line as "note:eighths"] — one entry per bar.
  const SONG = [
    ['A', 1, 'A4:2 C5:1 E5:2 D5:1 C5:2'],
    ['F', 0, 'C5:2 A4:1 F4:2 A4:1 C5:2'],
    ['C', 0, 'E5:2 G5:1 E5:2 D5:1 C5:2'],
    ['G', 0, 'D5:3 B4:1 G4:2 B4:1 D5:1'],
    ['A', 1, 'A4:2 C5:1 E5:2 A5:1 G5:2'],
    ['F', 0, 'F5:2 E5:1 C5:2 A4:1 C5:2'],
    ['G', 0, 'D5:2 G5:1 F5:2 D5:1 B4:2'],
    ['E', 0, 'E5:4 G#4:1 B4:1 E5:2'],
    ['F', 0, 'F5:1 F5:1 C5:1 F5:1 A5:2 G5:1 F5:1'],
    ['G', 0, 'G5:1 G5:1 D5:1 G5:1 B5:2 A5:1 G5:1'],
    ['A', 1, 'A5:3 E5:1 C5:2 E5:2'],
    ['A', 1, 'A5:1 G5:1 E5:1 C5:1 A4:4'],
    ['F', 0, 'F5:1 F5:1 C5:1 F5:1 A5:2 G5:1 F5:1'],
    ['G', 0, 'G5:1 G5:1 D5:1 G5:1 B5:2 C6:1 B5:1'],
    ['C', 0, 'C6:3 G5:1 E5:2 G5:2'],
    ['E', 0, 'E5:1 G#5:1 B5:1 E6:1 B5:1 G#5:1 E5:2'],
  ];
  const DRUMS = 'k.h.s.hkk.h.s.hh';
  const BASS_PAT = [0, 0, 12, 0, 0, 12, 0, 12];

  // Compile to one event record per sixteenth-note step.
  const STEPS = [];
  SONG.forEach(function (bar) {
    const root = BASS[bar[0]], third = bar[1] ? 3 : 4;
    const arpNotes = [root + 12, root + 19, root + 24, root + 19, root + 24 + third, root + 19, root + 24, root + 19];
    const lead = {};
    let pos = 0;
    bar[2].split(' ').forEach(function (tok) {
      const p = tok.split(':'), len = +p[1] * 2;
      if (p[0] !== '-') lead[pos] = [midi(p[0]), len];
      pos += len;
    });
    for (let s = 0; s < 16; s++) {
      STEPS.push({
        lead: lead[s] || null,
        bass: s % 2 === 0 ? [root + BASS_PAT[s / 2], 2] : null,
        arp: arpNotes[s % 8],
        drum: DRUMS[s],
      });
    }
  });

  const STEP_DUR = 60 / 150 / 4; // sixteenth note at 150 BPM
  const music = { on: false, tempo: 1, lead: true, next: 0, step: 0 };

  function voice(wave, m, t, dur, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    if (typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
    o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.setValueAtTime(vol, t + Math.max(0.012, dur * 0.6));
    g.gain.linearRampToValueAtTime(0.0001, t + Math.max(0.03, dur));
    o.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + Math.max(0.03, dur) + 0.03);
  }

  function drum(kind, t) {
    const d = t - ctx.currentTime;
    if (kind === 'k') tone('sine', 150, 42, 0.13, 0.5, d, musicBus);
    else if (kind === 's') { noise(0.11, 0.2, 1400, 1400, d, 'highpass', musicBus); tone('triangle', 200, 120, 0.06, 0.2, d, musicBus); }
    else if (kind === 'h') noise(0.03, 0.07, 7000, 7000, d, 'highpass', musicBus);
  }

  function tick() {
    if (!ctx || !music.on || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (music.next < now - 0.25) music.next = now + 0.06; // resync after a stall
    const dur = STEP_DUR / music.tempo;
    while (music.next < now + 0.14) {
      const s = STEPS[music.step], t = Math.max(music.next, now + 0.005);
      if (s.lead && music.lead) voice(pulse25, s.lead[0], t, s.lead[1] * dur * 0.92, 0.075);
      if (s.bass) voice('triangle', s.bass[0], t, s.bass[1] * dur * 0.9, 0.2);
      voice(pulse12, s.arp, t, dur * 0.9, 0.028);
      drum(s.drum, t);
      music.next += dur;
      music.step = (music.step + 1) % STEPS.length;
    }
  }

  /** opts: { on, tempo, lead, restart } — any subset. */
  A.music = function (opts) {
    if (opts.on !== undefined) music.on = opts.on;
    if (opts.tempo !== undefined) music.tempo = opts.tempo;
    if (opts.lead !== undefined) music.lead = opts.lead;
    if (opts.restart) { music.step = 0; music.next = 0; }
  };
})();
