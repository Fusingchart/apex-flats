/* In-car radio: three procedurally sequenced stations (WebAudio), plus the stingers for mission passed / failed and
 * wasted / busted. Loaded before main.js; main.js calls createRadio(audio) once the audio graph exists.
 * Sequencer adapted from Steel Bay Bounty's radio. */
(function () {
  'use strict';
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const STATIONS = [
    { name: 'Ashby FM', genre: 'Synthwave', bpm: 104, style: 'synth', prog: [[57, 'm'], [53, 'M'], [48, 'M'], [55, 'M']] },
    { name: 'Riverside Lo-Fi', genre: 'Late-night beats', bpm: 82, style: 'lofi', prog: [[50, 'm7'], [55, '7'], [48, 'M7'], [57, 'm7']] },
    { name: 'Valley Rock 104', genre: 'Rock', bpm: 132, style: 'rock', prog: [[40, '5'], [36, '5'], [43, '5'], [38, '5']] },
  ];
  const CH = { m: [0, 3, 7], M: [0, 4, 7], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], M7: [0, 4, 7, 11], '5': [0, 7, 12] };

  window.createRadio = function (audio) {
    const R = {
      idx: -1, gain: null, nextT: 0, step: 0, vol: 0, stations: STATIONS,
      get station() { return this.idx < 0 ? null : STATIONS[this.idx]; },
      ensure() {
        const c = audio.ctx;
        if (!c) return false;
        if (this.gain) return true;
        this.c = c;
        this.gain = c.createGain(); this.gain.gain.value = 0;
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60;
        // a car speaker: a little band-limited, a little warm
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500;
        this.bus = c.createGain();
        this.bus.connect(hp); hp.connect(lp); lp.connect(this.gain); this.gain.connect(audio.master);
        const len = c.sampleRate, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
        const dist = c.createWaveShaper(), k = 30, n = 1024, curve = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
        dist.curve = curve;
        this.distIn = c.createGain(); this.distIn.gain.value = 1.6;
        const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 3200;
        this.distIn.connect(dist); dist.connect(dlp); dlp.connect(this.bus);
        // stingers bypass the car speaker and the radio volume
        this.fx = c.createGain(); this.fx.gain.value = 0.5; this.fx.connect(audio.master);
        return true;
      },
      tune(i) {
        if (!this.ensure()) return null;
        this.idx = ((i % (STATIONS.length + 1)) + STATIONS.length + 1) % (STATIONS.length + 1) - 1; // -1 is off
        this.step = 0; this.nextT = this.c.currentTime + 0.08;
        return this.station;
      },
      next() { return this.tune(this.idx + 2); },
      prev() { return this.tune(this.idx); },
      // every frame: in a car (and not muted) the music plays; duck 0..1 lowers it under sirens and menus
      update(inCar, duck) {
        if (!this.gain) return;
        const want = inCar && this.idx >= 0 && !audio.muted ? 0.3 * (1 - 0.6 * (duck || 0)) : 0;
        this.vol += (want - this.vol) * 0.08;
        this.gain.gain.setTargetAtTime(this.vol, this.c.currentTime, 0.05);
        if (this.idx < 0 || this.vol < 0.002) { this.nextT = this.c.currentTime + 0.05; return; }
        const st = STATIONS[this.idx], s16 = 60 / st.bpm / 4;
        if (this.nextT < this.c.currentTime - 0.3) this.nextT = this.c.currentTime + 0.02;
        while (this.nextT < this.c.currentTime + 0.15) { this.play(st, this.step, this.nextT, s16); this.nextT += s16; this.step++; }
      },
      tone(type, f, t, dur, g, dest, cut, q) {
        const c = this.c, o = c.createOscillator(), a = c.createGain();
        o.type = type; o.frequency.setValueAtTime(f, t);
        a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(g, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        let node = o;
        if (cut) { const f2 = c.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.setValueAtTime(cut, t); f2.Q.value = q || 0.8; o.connect(f2); node = f2; }
        node.connect(a); a.connect(dest || this.bus);
        o.start(t); o.stop(t + dur + 0.05);
      },
      kick(t, g, dest) {
        const c = this.c, o = c.createOscillator(), a = c.createGain();
        o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
        a.gain.setValueAtTime(g, t); a.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
        o.connect(a); a.connect(dest || this.bus); o.start(t); o.stop(t + 0.35);
      },
      hiss(t, dur, g, freq, type, dest) {
        const c = this.c, s = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
        s.buffer = this.noise; f.type = type || 'highpass'; f.frequency.value = freq;
        a.gain.setValueAtTime(g, t); a.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        s.connect(f); f.connect(a); a.connect(dest || this.bus);
        s.start(t, Math.random() * 0.5, dur + 0.05);
      },
      snare(t, g) { this.hiss(t, 0.18, g, 1800, 'bandpass'); this.tone('triangle', 190, t, 0.1, g * 0.5); },
      play(st, step, t, s16) {
        const bar = Math.floor(step / 16) % 4, s = step % 16;
        const [root, q] = st.prog[bar], notes = CH[q];
        const fill = Math.floor(step / 64) % 2 === 1 && bar === 3 && s >= 12;
        if (st.style === 'synth') {
          if (s % 4 === 0) this.kick(t, 0.9);
          if (s === 4 || s === 12 || (fill && s % 2 === 0)) this.snare(t, 0.35);
          if (s % 2 === 0) this.hiss(t, 0.05, 0.08, 7000);
          if (s % 2 === 0) this.tone('sawtooth', mtof(root - 12 + (s % 4 === 2 ? 12 : 0)), t, s16 * 1.8, 0.16, null, 700, 4);
          const arp = notes[(s + bar) % notes.length] + 24 + (s % 8 >= 4 ? 12 : 0);
          this.tone('square', mtof(root + arp - 12), t, s16 * 0.9, 0.045, null, 2400);
          if (s === 0) for (const n of notes) {
            this.tone('sawtooth', mtof(root + n + 12) * 1.003, t, s16 * 15, 0.03, null, 1400);
            this.tone('sawtooth', mtof(root + n + 12) * 0.997, t, s16 * 15, 0.03, null, 1400);
          }
        } else if (st.style === 'lofi') {
          const tt = t + (s % 2 === 1 ? s16 * 0.28 : 0);
          if (s === 0 || s === 10 || (s === 7 && bar % 2)) this.kick(tt, 0.7);
          if (s === 4 || s === 12) this.snare(tt, 0.22);
          if (s % 2 === 0 || s === 15) this.hiss(tt, 0.04, 0.05, 6500);
          if (s === 0 || s === 6 || s === 10) for (const n of notes) {
            const f = mtof(root + n + 12);
            this.tone('sine', f, tt + n * 0.006, s16 * (s === 0 ? 6 : 3), 0.05, null, 2000);
            this.tone('sine', f * 2, tt + n * 0.006, s16 * 2, 0.012);
          }
          if (s === 0 || s === 8 || s === 11) this.tone('triangle', mtof(root - 12 + (s === 11 ? 7 : 0)), tt, s16 * 3, 0.2, null, 500);
          if (s === 0) this.hiss(t, s16 * 16, 0.008, 3000, 'bandpass');
        } else {
          if (s === 0 || s === 6 || s === 8 || (s === 14 && bar % 2)) this.kick(t, 1.0);
          if (s === 4 || s === 12 || (fill && s > 12)) this.snare(t, 0.45);
          if (s % 2 === 0) this.hiss(t, 0.06, 0.07, 8000);
          if (bar === 3 && s >= 12) { for (const n of notes) this.tone('sawtooth', mtof(root + n + 12 + (s - 12)), t, s16, 0.05, this.distIn); }
          else if (s % 2 === 0) for (const n of notes) this.tone('sawtooth', mtof(root + n + 12), t, s16 * 1.7, 0.06, this.distIn);
          if (s % 2 === 0) this.tone('sawtooth', mtof(root), t, s16 * 1.8, 0.14, null, 600);
          if (s === 0 && bar === 0) this.hiss(t, 1.2, 0.12, 5000);
        }
      },
      // Stingers: 'passed' (a rising major flourish), 'failed' (falling minor), 'wasted' / 'busted' (a low hit and a slow fall)
      sting(kind) {
        if (!this.ensure() || audio.muted) return;
        const t = this.c.currentTime + 0.03, fx = this.fx;
        if (kind === 'passed') {
          [60, 64, 67, 72].forEach((m, i) => { this.tone('triangle', mtof(m), t + i * 0.11, 0.5, 0.22, fx); this.tone('sawtooth', mtof(m + 12), t + i * 0.11, 0.25, 0.04, fx, 2500); });
          for (const m of [60, 64, 67, 72, 76]) this.tone('sawtooth', mtof(m), t + 0.45, 1.6, 0.05, fx, 1800);
          this.kick(t + 0.45, 0.7, fx); this.hiss(t + 0.45, 1.4, 0.1, 6000, 'highpass', fx);
        } else if (kind === 'failed') {
          [67, 63, 60, 55].forEach((m, i) => this.tone('triangle', mtof(m), t + i * 0.16, 0.6, 0.2, fx));
          for (const m of [48, 51, 55]) this.tone('sawtooth', mtof(m), t + 0.64, 1.6, 0.05, fx, 900);
        } else {
          this.kick(t, 1.2, fx); this.hiss(t, 1.8, 0.18, 300, 'lowpass', fx);
          const c = this.c, o = c.createOscillator(), a = c.createGain(), f = c.createBiquadFilter();
          o.type = 'sawtooth'; o.frequency.setValueAtTime(kind === 'busted' ? 220 : 180, t); o.frequency.exponentialRampToValueAtTime(45, t + 2.4);
          f.type = 'lowpass'; f.frequency.value = 900; a.gain.setValueAtTime(0.0001, t); a.gain.linearRampToValueAtTime(0.16, t + 0.1); a.gain.exponentialRampToValueAtTime(0.0008, t + 2.6);
          o.connect(f); f.connect(a); a.connect(fx); o.start(t); o.stop(t + 2.7);
        }
      },
    };
    return R;
  };
})();
