'use strict';

/* Glass Sentry — sky defence for Meta Ray-Ban Display glasses.
   Raiders hold fixed compass headings around you. With head aiming on you
   look at them to aim; otherwise swipes swing the sight from target to target.
     Left / Right   swing to the next raider left / right (adds to head aim)
     Up             next weapon: Laser · Missile · Flak
     Down           raise the shield for a moment (uses shield energy)
     Pinch          fire
     Down twice     pause
   Laser hits instantly and suits drones; missiles need a lock and break
   scouts and carriers; flak bursts where the sight is and clears flocks. */

const VERSION = '1.0.0';
const { g, label, plate, banner, clamp, lerp, rand, beep, noise, head, store } = GK;
const D = Math.PI / 180;
const F = 300 / Math.tan(32 * D);      // 64° wide view
const WEAPONS = [
  { name: 'LASER', colour: '#7fffd4', reload: 0.18 },
  { name: 'MISSILE', colour: '#ffd34d', reload: 1.6 },
  { name: 'FLAK', colour: '#ff9f43', reload: 1.0 },
];

let state = 'menu';      // menu | brief | play | pause | won | lost
let raid, wave, waveT, foes, shots, blasts, view, weapon, reload, lock, lockT, hp, shield, shieldOn, score, time, msg, msgT, downAt = 0;
let aimHead = store.get('sentry.head', false);
let reached = store.get('sentry.reached', 1);
let bests = store.get('sentry.best', {});
let pick = 0;

/* ---------------------------------------------------------------- raids */

// A wave: list of [kind, count, heading spread centre (deg), elevation].
const RAIDS = [
  { name: 'First Contact', waves: [[['scout', 3, 0, 15]], [['scout', 2, 90, 20], ['flock', 1, 200, 25]], [['scout', 4, 300, 15], ['flock', 1, 60, 30]]] },
  { name: 'Swarm Night', waves: [[['flock', 2, 0, 25]], [['flock', 2, 120, 20], ['scout', 2, 240, 15]], [['flock', 3, 0, 30], ['scout', 3, 180, 18]], [['carrier', 1, 90, 22], ['flock', 1, 270, 25]]] },
  { name: 'Mothership', waves: [[['scout', 4, 45, 15], ['flock', 1, 225, 25]], [['carrier', 1, 0, 22], ['scout', 2, 180, 18]], [['carrier', 2, 120, 25], ['flock', 2, 300, 30]], [['carrier', 1, 200, 30], ['flock', 3, 20, 25], ['scout', 3, 110, 15]]] },
];
const ENDLESS = { name: 'Endless', endless: true, waves: [] };

function endlessWave(n) {
  const w = [['scout', 2 + Math.floor(n / 2), rand(0, 360), 15]];
  if (n >= 1) w.push(['flock', 1 + Math.floor(n / 3), rand(0, 360), 25]);
  if (n >= 3 && n % 2 === 1) w.push(['carrier', 1 + Math.floor(n / 6), rand(0, 360), 24]);
  return w;
}

function spawn(kind, centre, elev) {
  const h = (centre + rand(-30, 30) + 360) % 360;
  if (kind === 'scout') {
    foes.push({ kind, h, e: elev + rand(-6, 8), d: 1, hp: 40, max: 40, size: 2.2, vh: rand(-14, 14), fireT: rand(2, 4), dive: 0, t: rand(0, 6) });
  } else if (kind === 'flock') {
    const n = 6;
    const group = { cx: h, ce: elev + rand(-4, 6), vh: rand(-18, 18), t: rand(0, 6) };
    for (let i = 0; i < n; i++) foes.push({ kind: 'drone', group, slot: i, h, e: elev, hp: 10, max: 10, size: 1.1, fireT: rand(3, 6), t: 0 });
  } else if (kind === 'carrier') {
    foes.push({ kind, h, e: elev + rand(0, 6), hp: 420, max: 420, size: 7, vh: rand(-3, 3), fireT: 3, spawnT: 6, t: 0 });
  }
}

/* ----------------------------------------------------------------- game */

function start(r) {
  raid = r;
  foes = []; shots = []; blasts = [];
  view = { h: 0, e: 12, off: 0 };
  weapon = 0; reload = 0; lock = null; lockT = 0;
  hp = 100; shield = 100; shieldOn = 0; score = 0; time = 0; wave = 0; waveT = 2; msg = ''; msgT = 0;
  state = 'brief';
  if (aimHead) GK.recentre();
}

function say(t, s = 1.6) { msg = t; msgT = s; }

function aimed() {
  // Heading and elevation the sight points at.
  if (aimHead && GK.headLive()) return { h: (head.yaw + view.off + 360) % 360, e: clamp(12 + head.pitch, -5, 80) };
  return { h: view.h, e: view.e };
}

function rel(o, a) {
  const dh = ((o.h - a.h + 540) % 360) - 180;
  return { dh, de: o.e - a.e, dist: Math.hypot(dh, o.e - a.e) };
}

function underSight(a) {
  let best = null, bd = Infinity;
  for (const f of foes) {
    const r = rel(f, a);
    const reach = f.size * 1.4 + 1.5;
    if (r.dist < reach && r.dist < bd) { bd = r.dist; best = f; }
  }
  return best;
}

function swing(dir) {
  // Next raider to that side of the sight, or 45° if there is none.
  const a = aimed();
  let best = null, bd = Infinity;
  for (const f of foes) {
    const r = rel(f, a);
    const d = r.dh * dir;
    if (d > 3 && d < bd) { bd = d; best = f; }
  }
  const step = best ? bd * dir : 45 * dir;
  if (aimHead && GK.headLive()) view.off = (view.off + step + 360) % 360;
  else { view.h = (view.h + step + 360) % 360; if (best) view.e = best.e; }
  beep(560, 0.03);
}

function fire() {
  if (reload > 0) { beep(140, 0.05); return; }
  const w = WEAPONS[weapon];
  const a = aimed();
  reload = w.reload;
  if (weapon === 0) {
    const t = underSight(a);
    blasts.push({ h: a.h, e: a.e, t: 0.12, r: 0.6, c: w.colour, beam: true });
    beep(1500, 0.06, 'square', 0.2, -900);
    if (t) hit(t, t.kind === 'drone' ? 10 : 6);
  } else if (weapon === 1) {
    if (!lock || lockT < 0.6) { say('NO LOCK', 0.8); reload = 0.2; beep(200, 0.1); return; }
    shots.push({ kind: 'missile', target: lock, h: a.h, e: a.e - 10, t: 0 });
    beep(300, 0.4, 'sawtooth', 0.25, 600);
  } else {
    blasts.push({ h: a.h, e: a.e, t: 0.5, r: 7, c: w.colour });
    noise(0.3, 0.4, 1200);
    for (const f of foes) if (rel(f, a).dist < 7 + f.size) hit(f, f.kind === 'carrier' ? 8 : 25);
  }
}

function hit(f, n) {
  f.hp -= n;
  if (f.hp <= 0 && !f.gone) {
    f.gone = true;
    score += f.kind === 'carrier' ? 500 : f.kind === 'scout' ? 100 : 30;
    blasts.push({ h: f.h, e: f.e, t: 0.6, r: f.size * 2, c: f.kind === 'carrier' ? '#ff5c5c' : '#ffd34d' });
    noise(f.kind === 'carrier' ? 0.8 : 0.25, 0.5, f.kind === 'carrier' ? 300 : 900);
    if (lock === f) { lock = null; lockT = 0; }
  } else beep(900, 0.03, 'square', 0.12);
}

function hurt(n) {
  if (shieldOn > 0) { shield = Math.max(0, shield - n * 0.6); beep(400, 0.1, 'sine', 0.3, 300); return; }
  hp -= n;
  noise(0.3, 0.6, 500);
  say('HIT', 0.6);
}

function tick(dt) {
  if (state !== 'play') return;
  time += dt; msgT -= dt;
  reload = Math.max(0, reload - dt);
  if (shieldOn > 0) { shieldOn -= dt; shield = Math.max(0, shield - 18 * dt); if (shield <= 0) shieldOn = 0; }
  else shield = Math.min(100, shield + 7 * dt);

  // Waves.
  if (!foes.length) {
    const list = raid.endless ? null : raid.waves;
    if (list && wave >= list.length) return end('won');
    waveT -= dt;
    if (waveT <= 0) {
      const w = raid.endless ? endlessWave(wave) : list[wave];
      wave++;
      // Crews patch the hull between waves.
      if (wave > 1) hp = Math.min(100, hp + 20);
      say(raid.endless ? 'WAVE ' + wave : 'WAVE ' + wave + ' / ' + list.length);
      for (const [kind, n, c, e] of w) for (let i = 0; i < n; i++) spawn(kind, c, e);
      waveT = 3;
      beep(330, 0.3, 'triangle', 0.4); beep(440, 0.3, 'triangle', 0.3);
    }
  }

  for (const f of foes) {
    f.t += dt;
    if (f.kind === 'scout') {
      f.h = (f.h + f.vh * dt + 360) % 360;
      f.e = clamp(f.e + Math.sin(f.t * 1.3) * 6 * dt, 3, 60);
      f.fireT -= dt;
      if (f.fireT <= 0) { shots.push({ kind: 'bolt', h: f.h, e: f.e, d: 1, speed: 0.4, dmg: 9 }); f.fireT = rand(3, 5); }
    } else if (f.kind === 'drone') {
      const gp = f.group;
      if (f.slot === 0) { gp.cx = (gp.cx + gp.vh * dt + 360) % 360; gp.t += dt; if (Math.random() < 0.004) gp.vh = rand(-22, 22); }
      const a = gp.t * 1.6 + f.slot / 6 * Math.PI * 2;
      f.h = (gp.cx + Math.cos(a) * 6 + 360) % 360;
      f.e = clamp(gp.ce + Math.sin(a) * 4, 3, 70);
      f.fireT -= dt;
      if (f.fireT <= 0) { shots.push({ kind: 'bolt', h: f.h, e: f.e, d: 1, speed: 0.55, dmg: 4 }); f.fireT = rand(5, 8); }
    } else if (f.kind === 'carrier') {
      f.h = (f.h + f.vh * dt + 360) % 360;
      f.spawnT -= dt;
      if (f.spawnT <= 0 && foes.filter((o) => o.kind === 'drone').length < 18) { spawn('flock', f.h, f.e - 4); f.spawnT = 10; }
      f.fireT -= dt;
      if (f.fireT <= 0) { shots.push({ kind: 'bolt', h: f.h, e: f.e - 2, d: 1, speed: 0.3, dmg: 16, big: true }); f.fireT = 5; }
    }
  }

  for (const s of shots) {
    if (s.kind === 'bolt') { s.d -= s.speed * dt; if (s.d <= 0) { s.done = true; hurt(s.dmg); } }
    else {
      s.t += dt;
      if (s.target.gone) { s.done = true; continue; }
      const r = rel(s.target, s);
      const step = 90 * dt;
      if (r.dist < step + 1) { s.done = true; hit(s.target, 90); continue; }
      s.h = (s.h + r.dh / r.dist * step + 360) % 360;
      s.e += r.de / r.dist * step;
      if (s.t > 4) s.done = true;
    }
  }
  shots = shots.filter((s) => !s.done);
  for (const b of blasts) b.t -= dt;
  blasts = blasts.filter((b) => b.t > 0);
  foes = foes.filter((f) => !f.gone);

  // Lock: the missile needs the same raider under the sight for a moment.
  const a = aimed();
  const under = underSight(a);
  if (weapon === 1 && under) {
    if (under === lock) { const b = lockT; lockT += dt; if (b < 0.6 && lockT >= 0.6) beep(1400, 0.08, 'sine', 0.3); }
    else { lock = under; lockT = 0; }
  } else if (!under) lockT = Math.max(0, lockT - dt * 2);

  if (hp <= 0) end('lost');
}

function end(r) {
  state = r;
  const key = raid.name;
  const prev = bests[key] || 0;
  const val = raid.endless ? wave : score;
  if (val > prev) { bests[key] = val; store.set('sentry.best', bests); }
  const i = RAIDS.indexOf(raid);
  if (r === 'won' && i >= 0 && i + 2 > reached) { reached = Math.min(RAIDS.length + 1, i + 2); store.set('sentry.reached', reached); }
  if (r === 'won') { beep(523, 0.2, 'triangle', 0.4); setTimeout(() => beep(784, 0.4, 'triangle', 0.4), 200); }
}

/* -------------------------------------------------------------- drawing */

function toScreen(h, e, a) {
  const dh = ((h - a.h + 540) % 360) - 180;
  if (Math.abs(dh) > 80) return null;
  return { x: 300 + Math.tan(dh * D) * F, y: 300 - Math.tan(clamp(e - a.e, -80, 80) * D) * F };
}

function drawWorld(a, now) {
  // Stars fixed to the sky.
  for (let i = 0; i < 160; i++) {
    const h = (i * 137.508) % 360, e = 5 + ((i * 53.3) % 70);
    const p = toScreen(h, e, a);
    if (!p || p.y < 0 || p.y > 600) continue;
    g.fillStyle = i % 9 === 0 ? '#fff' : '#6d7c96';
    g.fillRect(p.x, p.y, i % 9 === 0 ? 2 : 1, i % 9 === 0 ? 2 : 1);
  }
  // Moon at a fixed heading.
  const m = toScreen(130, 40, a);
  if (m) { g.fillStyle = '#c9d4e6'; g.beginPath(); g.arc(m.x, m.y, 26, 0, Math.PI * 2); g.fill(); g.fillStyle = '#000'; g.beginPath(); g.arc(m.x + 10, m.y - 6, 22, 0, Math.PI * 2); g.fill(); }
  // City skyline at the horizon, the same buildings at the same headings.
  const hy = toScreen(a.h, 0, a).y;
  g.fillStyle = '#0a0f17';
  g.fillRect(0, hy, 600, 600);
  for (let b = 0; b < 180; b++) {
    const h = b * 2;
    const p = toScreen(h, 0, a);
    if (!p) continue;
    const tall = 3 + ((b * 7919) % 13);
    const top = toScreen(h, tall * 0.55, a);
    const w = Math.tan(2 * D) * F + 1;
    g.fillStyle = b % 3 ? '#0f1622' : '#141d2c';
    g.fillRect(p.x - w / 2, top.y, w, hy - top.y + 1);
    if ((b * 31) % 5 === 0) { g.fillStyle = '#ffd96b'; g.fillRect(p.x - 2, top.y + (hy - top.y) * 0.4, 3, 3); }
  }
  g.strokeStyle = '#3a5a80'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, hy); g.lineTo(600, hy); g.stroke();
}

function drawFoe(f, a, now) {
  const p = toScreen(f.h, f.e, a);
  if (!p) return;
  const s = Math.tan(f.size * D) * F;
  if (f.kind === 'scout') {
    g.fillStyle = '#9be15d';
    g.beginPath(); g.ellipse(p.x, p.y, s, s * 0.35, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d7ffb0';
    g.beginPath(); g.ellipse(p.x, p.y - s * 0.25, s * 0.45, s * 0.35, 0, Math.PI, 0); g.fill();
    for (let i = -2; i <= 2; i++) { g.fillStyle = Math.floor(now / 150 + i) % 2 ? '#ff5c5c' : '#ffd34d'; g.fillRect(p.x + i * s * 0.35 - 2, p.y - 1, 4, 3); }
  } else if (f.kind === 'drone') {
    g.fillStyle = '#ff9be0';
    g.beginPath(); g.moveTo(p.x, p.y - s); g.lineTo(p.x + s, p.y); g.lineTo(p.x, p.y + s); g.lineTo(p.x - s, p.y); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  } else if (f.kind === 'carrier') {
    g.fillStyle = '#5a3a5c';
    g.beginPath(); g.ellipse(p.x, p.y, s, s * 0.32, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#8a5a8c'; g.fillRect(p.x - s * 0.6, p.y - s * 0.42, s * 1.2, s * 0.18);
    for (let i = 0; i < 7; i++) { g.fillStyle = Math.floor(now / 300 + i) % 3 ? '#ff5cc8' : '#fff'; g.fillRect(p.x - s * 0.8 + i * s * 0.26, p.y + s * 0.12, 4, 4); }
    // Health bar under the carrier.
    g.fillStyle = 'rgba(255,255,255,.2)'; g.fillRect(p.x - 40, p.y + s * 0.4 + 8, 80, 5);
    g.fillStyle = '#ff5cc8'; g.fillRect(p.x - 40, p.y + s * 0.4 + 8, 80 * f.hp / f.max, 5);
  }
}

function render(now) {
  g.fillStyle = '#000'; g.fillRect(0, 0, 600, 600);
  if (!view) view = { h: 0, e: 12, off: 0 };
  if (state === 'menu') view.h = (now / 100) % 360;
  const a = aimed();
  drawWorld(a, now);
  if (state === 'menu') return GK.drawMenu(menu, now, 150);

  for (const f of foes) drawFoe(f, a, now);
  for (const s of shots) {
    if (s.kind === 'bolt') {
      const p = toScreen(s.h, s.e * s.d, a);
      if (!p) continue;
      const r = (1 - s.d) * (s.big ? 40 : 22) + 3;
      g.fillStyle = s.big ? 'rgba(255,92,200,.85)' : 'rgba(255,110,80,.85)';
      g.beginPath(); g.arc(p.x, p.y + (1 - s.d) * 140, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(p.x, p.y + (1 - s.d) * 140, r * 0.4, 0, Math.PI * 2); g.fill();
    } else {
      const p = toScreen(s.h, s.e, a);
      if (p) { g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill(); }
    }
  }
  for (const b of blasts) {
    const p = toScreen(b.h, b.e, a);
    if (!p) continue;
    if (b.beam) {
      g.strokeStyle = b.c; g.lineWidth = 3; g.globalAlpha = b.t / 0.12;
      g.beginPath(); g.moveTo(240, 600); g.lineTo(p.x, p.y); g.moveTo(360, 600); g.lineTo(p.x, p.y); g.stroke();
      g.globalAlpha = 1;
    } else {
      g.globalAlpha = Math.min(1, b.t * 2);
      g.strokeStyle = b.c; g.lineWidth = 4;
      g.beginPath(); g.arc(p.x, p.y, Math.tan(b.r * D) * F * (1.2 - b.t), 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }
  }
  if (shieldOn > 0) {
    g.strokeStyle = 'rgba(127,216,255,.55)'; g.lineWidth = 10;
    g.beginPath(); g.arc(300, 900, 640, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  }
  hud(a, now);
  if (state === 'brief') banner(now, raid.name.toUpperCase(), '#ff6b6b', 'Pinch to begin', [
    aimHead ? 'Look at raiders to aim. Swipes swing the sight.' : 'Left / Right: swing to the next raider',
    'Up: weapon  ·  Down: shield  ·  Pinch: fire',
  ]);
  if (state === 'pause') banner(now, 'PAUSED', '#fff', 'Pinch to continue', ['Left: back to the menu']);
  if (state === 'won') banner(now, 'SKY CLEAR', '#9be15d', 'Pinch for the menu', ['Score ' + score + '  ·  hull ' + Math.max(0, Math.round(hp)) + '%']);
  if (state === 'lost') banner(now, 'OVERRUN', '#ff6b6b', 'Pinch to retry', [raid.endless ? 'Reached wave ' + wave : 'Score ' + score, 'Down: back to the menu']);
}

function hud(a, now) {
  const under = underSight(a);
  // Sight.
  const w = WEAPONS[weapon];
  g.strokeStyle = under ? '#ff5c5c' : w.colour; g.lineWidth = 2;
  g.beginPath(); g.arc(300, 300, weapon === 2 ? Math.tan(7 * D) * F : 16, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(300, 270); g.lineTo(300, 284); g.moveTo(300, 316); g.lineTo(300, 330); g.moveTo(270, 300); g.lineTo(284, 300); g.moveTo(316, 300); g.lineTo(330, 300); g.stroke();
  if (weapon === 1 && lock && !lock.gone) {
    const p = toScreen(lock.h, lock.e, a);
    if (p) {
      g.strokeStyle = lockT >= 0.6 ? '#ff3d3d' : '#ffd34d';
      g.beginPath(); g.arc(p.x, p.y, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, lockT / 0.6)); g.stroke();
      if (lockT >= 0.6 && GK.blink(now, 200)) label('LOCK', p.x, p.y + 44, 14, '#ff3d3d', 'center');
    }
  }
  // Raiders off screen: arrows on the left or right edge, with how far round they are.
  for (const f of foes) {
    const r = rel(f, a);
    if (Math.abs(r.dh) < 33) continue;
    const x = r.dh > 0 ? 584 : 16;
    const y = clamp(300 - r.de * 4, 90, 520);
    g.fillStyle = f.kind === 'carrier' ? '#ff5cc8' : f.kind === 'scout' ? '#9be15d' : '#ff9be0';
    g.beginPath();
    if (r.dh > 0) { g.moveTo(x + 8, y); g.lineTo(x - 6, y - 7); g.lineTo(x - 6, y + 7); }
    else { g.moveTo(x - 8, y); g.lineTo(x + 6, y - 7); g.lineTo(x + 6, y + 7); }
    g.closePath(); g.fill();
  }
  // Incoming fire warning on the edge it comes from.
  for (const s of shots) {
    if (s.kind !== 'bolt' || s.d > 0.5) continue;
    const r = rel(s, a);
    if (Math.abs(r.dh) < 33) continue;
    g.fillStyle = GK.blink(now, 150) ? '#ff3d3d' : '#ffb35c';
    g.fillRect(r.dh > 0 ? 588 : 0, 0, 12, 600);
  }
  // Compass tape.
  plate(150, 8, 300, 34, 10);
  for (let d = -40; d <= 40; d += 5) {
    const hh = Math.round(a.h / 5) * 5 + d;
    const x = 300 + (hh - a.h) * 3.4;
    if (x < 158 || x > 442) continue;
    const n = ((hh % 360) + 360) % 360;
    const name = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n];
    g.fillStyle = '#a9adb3'; g.fillRect(x, 34, 1, n % 15 === 0 ? 6 : 3);
    if (name) label(name, x, 29, 14, name === 'N' ? '#ff6b6b' : '#fff', 'center');
    else if (n % 30 === 0) label(String(n), x, 28, 11, '#a9adb3', 'center', 600);
  }
  // Hull, shield, weapon.
  plate(12, 520, 170, 66);
  label('HULL', 24, 540, 12, '#a9adb3'); label('SHIELD', 24, 568, 12, '#a9adb3');
  g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(80, 532, 90, 8); g.fillRect(80, 560, 90, 8);
  g.fillStyle = hp > 35 ? '#9be15d' : '#ff6b6b'; g.fillRect(80, 532, 90 * Math.max(0, hp) / 100, 8);
  g.fillStyle = shieldOn > 0 ? '#ffffff' : '#7fd8ff'; g.fillRect(80, 560, 90 * shield / 100, 8);
  plate(418, 520, 170, 66);
  label(w.name, 576, 546, 20, w.colour, 'right');
  g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(430, 562, 146, 6);
  g.fillStyle = w.colour; g.fillRect(430, 562, 146 * (1 - reload / w.reload), 6);
  plate(12, 8, 120, 50); plate(468, 8, 120, 50);
  label('WAVE ' + wave, 24, 40, 16, '#fff');
  label(String(score), 576, 40, 18, '#ffd34d', 'right');
  if (msgT > 0) label(msg, 300, 130, 26, msg === 'HIT' ? '#ff6b6b' : '#ffb35c', 'center');
  if (aimHead && !GK.headLive() && GK.blink(now, 800)) label('Head aiming waiting — swipes still work', 300, 500, 14, '#ffb35c', 'center');
}

/* ----------------------------------------------------------------- menu */

const raidList = () => RAIDS.concat([ENDLESS]);
const menu = GK.menu('GLASS SENTRY', '#ff6b6b', [
  { text: () => { const r = raidList()[pick]; return 'Raid · ' + r.name + (pick + 1 > reached && !r.endless ? ' (locked)' : ''); },
    hint: () => { const r = raidList()[pick]; const b = bests[r.name]; return (b ? (r.endless ? 'Best wave ' + b : 'Best ' + b) + ' · ' : '') + 'Left / Right: raid'; },
    left: () => { pick = (pick + 3) % 4; }, right: () => { pick = (pick + 1) % 4; },
    act: () => { const r = raidList()[pick]; if (r.endless || pick + 1 <= reached) start(r); else beep(200, 0.2); } },
  { text: () => 'Aiming · ' + (aimHead ? 'Head' : 'Swipe'), hint: 'Head aiming asks for motion access once',
    act: () => { aimHead = !aimHead; store.set('sentry.head', aimHead); if (aimHead) GK.askHead(); } },
  { text: () => 'Invert head · ' + (head.invert ? 'on' : 'off'), act: () => GK.setInvert(!head.invert) },
  { text: () => 'Sound · ' + (GK.sound.on ? 'on' : 'off'), act: () => GK.setSound(!GK.sound.on) },
]);

/* ---------------------------------------------------------------- input */

GK.input.onKey = (k) => {
  if (state === 'menu') { if (aimHead && head.state === 'off') GK.askHead(); return GK.menuKey(menu, k); }
  if (state === 'brief') { if (k === 'Enter') { state = 'play'; if (aimHead) { GK.recentre(); view.off = 0; } } else if (k === 'ArrowDown') state = 'menu'; return; }
  if (state === 'won') { if (k === 'Enter') state = 'menu'; return; }
  if (state === 'lost') { if (k === 'Enter') start(raid); else if (k === 'ArrowDown') state = 'menu'; return; }
  if (state === 'pause') { if (k === 'Enter') state = 'play'; else if (k === 'ArrowLeft') state = 'menu'; return; }
  if (k === 'Enter') fire();
  else if (k === 'ArrowLeft') swing(-1);
  else if (k === 'ArrowRight') swing(1);
  else if (k === 'ArrowUp') { weapon = (weapon + 1) % 3; lock = null; lockT = 0; beep(700, 0.05); }
  else if (k === 'ArrowDown') {
    const now = performance.now();
    if (now - downAt < 400) { state = 'pause'; shieldOn = 0; return; }
    downAt = now;
    if (shield > 15) { shieldOn = 1.6; beep(500, 0.25, 'sine', 0.3, 300); }
  }
};

GK.loop.onHidden = () => { if (state === 'play') state = 'pause'; };
GK.run(tick, render);
