/* Glass Sentry — sky defence for Meta Ray-Ban Display glasses, in AR.
   The real sky is the backdrop: the scene clears to black, which the glasses
   show as see-through, and only the raiders (3D saucers, drone flocks and
   carriers), incoming fire and blasts are drawn, at fixed compass headings.
   A green vector HUD carries the compass arc, target brackets with range and
   azimuth, the reticle, the shield and the weapon strip.
     Left / Right   swing to the next raider left / right (adds to head aim)
     Up             next weapon: Laser · Missile · Flak
     Down           raise the shield for a moment; twice quickly to pause
     Pinch          fire */

import { THREE, makeRenderer, glowSprite, frameClock } from './kit3d.js';

const VERSION = '2.0.0';
const { g, label, clamp, lerp, rand, beep, noise, head, store } = GK;
const D = Math.PI / 180;
const WEAPONS = [
  { name: 'LASER', colour: '#7fffd4', reload: 0.18 },
  { name: 'MISSILE', colour: '#ffd34d', reload: 1.6 },
  { name: 'FLAK', colour: '#ff9f43', reload: 1.0 },
];

let state = 'title';     // title | aim-setup | menu | brief | play | pause | won | lost
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

/* ------------------------------------------------------------------ scene */

// AR: the sky is the real world, so the scene clears to black (transparent on
// the glasses) and only the raiders, shots and blasts are drawn, at their
// compass headings. North is -z and east is +x.
const renderer = makeRenderer(0x000000);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(64, 1, 0.5, 3000);
camera.rotation.order = 'YXZ';
const clock = frameClock();
scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x302020, 1.1));
const keyL = new THREE.DirectionalLight(0xffffff, 1.2);
keyL.position.set(100, 300, 100);
scene.add(keyL);

const dirOf = (h, e, r, out = new THREE.Vector3()) => out.set(Math.sin(h * D) * Math.cos(e * D) * r, Math.sin(e * D) * r, -Math.cos(h * D) * Math.cos(e * D) * r);
const RANGE = { scout: 120, drone: 85, carrier: 420 };

const std = (c, e = 0.2) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.5, roughness: 0.35, emissive: c, emissiveIntensity: e });

function scoutModel() {
  // Saucer: a lathed disc with a glass dome and a ring of lights.
  const gp = new THREE.Group();
  const prof = [[0, -0.25], [0.6, -0.22], [1, -0.05], [1.02, 0], [0.9, 0.12], [0.45, 0.22], [0, 0.24]].map(([x, y]) => new THREE.Vector2(x, y));
  gp.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 28), std(0xb8c0d8, 0.15)));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9be1ff, transparent: true, opacity: 0.7, emissive: 0x3a9adf, emissiveIntensity: 0.5 }));
  dome.position.y = 0.2; gp.add(dome);
  gp.lights = [];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2;
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd34d }));
    l.position.set(Math.cos(a) * 0.92, 0.02, Math.sin(a) * 0.92); gp.add(l); gp.lights.push(l);
  }
  gp.add(glowSprite(0x9be15d, 3.2));
  return gp;
}
function droneModel() {
  const gp = new THREE.Group();
  gp.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.6, 0), std(0xff7ad0, 0.4)));
  for (const s of [-1, 1]) { const w = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.5), std(0xd04aa0, 0.3)); w.position.x = s * 0.9; w.rotation.z = s * 0.25; gp.add(w); }
  gp.add(glowSprite(0xff7ad0, 2.2));
  return gp;
}
function carrierModel() {
  const gp = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), std(0x5a3a6a, 0.15)); hull.scale.set(1, 0.28, 0.55); gp.add(hull);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.05, 8, 48), new THREE.MeshBasicMaterial({ color: 0xff5cc8 })); ring.rotation.x = Math.PI / 2; ring.scale.set(1, 0.58, 1); gp.add(ring);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.2), std(0x8a6aa8)); bridge.position.y = 0.3; gp.add(bridge);
  gp.lights = [];
  for (let i = 0; i < 14; i++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff })); l.position.set(-0.8 + i * 0.12, -0.1, 0.5); gp.add(l); gp.lights.push(l); }
  return gp;
}

const foeMeshes = new Map();
function meshFor(f) {
  let m = foeMeshes.get(f);
  if (m) return m;
  m = f.kind === 'scout' ? scoutModel() : f.kind === 'drone' ? droneModel() : carrierModel();
  scene.add(m);
  foeMeshes.set(f, m);
  return m;
}

// Pools for incoming shots, missiles and blasts.
const pool = (make) => { const list = []; return (i) => { if (!list[i]) { list[i] = make(); scene.add(list[i]); } list[i].visible = true; return list[i]; }; };
const shotList = [], blastList = [];
const shotAt = pool(() => { const s = glowSprite(0xff7a4d, 3); shotList.push(s); return s; });
const blastAt = pool(() => { const s = glowSprite(0xffd34d, 10); blastList.push(s); return s; });
const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: 0x7fffd4 })); beam.frustumCulled = false; scene.add(beam);

/* ---------------------------------------------------------------- render */

const _v = new THREE.Vector3();
let menuH = 0;

function render3d(now) {
  const dt = clock(now);
  const a = view ? aimed() : { h: (menuH += dt * 6) % 360, e: 12 };
  camera.rotation.y = -a.h * D;
  camera.rotation.x = a.e * D;
  const live = new Set();
  if (foes) for (const f of foes) {
    live.add(f);
    const m = meshFor(f);
    const r = RANGE[f.kind];
    dirOf(f.h, f.e, r, m.position);
    m.scale.setScalar(Math.tan(f.size * D) * r * (f.kind === 'carrier' ? 1 : 1.2));
    m.rotation.y = -f.h * D + Math.sin(now / 700 + f.t) * 0.3;
    m.rotation.z = Math.sin(now / 500 + f.t) * 0.15;
    if (m.lights) m.lights.forEach((l, i) => l.material.color.setHex((Math.floor(now / 160) + i) % 2 ? 0xffd34d : 0xff5a5a));
  }
  for (const [f, m] of foeMeshes) if (!live.has(f)) { scene.remove(m); foeMeshes.delete(f); }
  let si = 0, bi = 0;
  if (shots) for (const s of shots) {
    const sp = shotAt(si++);
    if (s.kind === 'bolt') {
      // Incoming fire travels from the raider toward you and grows as it comes.
      dirOf(s.h, s.e, 30 + 90 * s.d, sp.position);
      sp.material.color.setHex(s.big ? 0xff5cc8 : 0xff7a4d);
      sp.scale.setScalar((s.big ? 6 : 3.5) * (1.6 - s.d));
    } else { dirOf(s.h, s.e, 70, sp.position); sp.material.color.setHex(0xffd34d); sp.scale.setScalar(3); }
  }
  shotList.slice(si).forEach((s) => (s.visible = false));
  beam.visible = false;
  if (blasts) for (const b of blasts) {
    if (b.beam) {
      beam.visible = true;
      beamGeo.setFromPoints([new THREE.Vector3().copy(camera.position).add(new THREE.Vector3(0, -6, 0).applyEuler(camera.rotation)), dirOf(b.h, b.e, 110, _v.clone())]);
      continue;
    }
    const sp = blastAt(bi++);
    dirOf(b.h, b.e, 110, sp.position);
    sp.material.color.set(b.c);
    sp.scale.setScalar(Math.tan(b.r * D) * 110 * 2 * (1.3 - b.t));
    sp.material.opacity = Math.min(1, b.t * 2);
  }
  blastList.slice(bi).forEach((s) => (s.visible = false));
  renderer.render(scene, camera);
}

function screenOf(h, e) {
  dirOf(h, e, 100, _v).project(camera);
  if (_v.z > 1) return null;
  return { x: (_v.x + 1) * 300, y: (1 - _v.y) * 300 };
}

/* -------------------------------------------------------------------- HUD */

const GR = '#7cff9a', GRD = 'rgba(124,255,154,.45)';
const mono = (size, w = 700) => `${w} ${size}px "SF Mono", Menlo, Consolas, monospace`;
function mt(t, x, y, size, colour = GR, align = 'left', w = 700) { g.font = mono(size, w); g.textAlign = align; g.fillStyle = colour; g.fillText(t, x, y); }
function frameBox(x, y, w, h, colour = GR) {
  g.fillStyle = 'rgba(0,12,4,.55)'; g.fillRect(x, y, w, h);
  g.strokeStyle = colour; g.lineWidth = 2; g.strokeRect(x, y, w, h);
}
function notchBox(x, y, w, h, colour = GR, fill = 'rgba(0,12,4,.6)') {
  g.fillStyle = fill; g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w, y + h - 10); g.lineTo(x + w - 10, y + h); g.lineTo(x, y + h); g.closePath(); g.fill();
  g.strokeStyle = colour; g.lineWidth = 2; g.stroke();
}

function hud(a, now) {
  // Compass arc with headings, the current heading in a box.
  g.strokeStyle = GR; g.lineWidth = 3; g.setLineDash([14, 8]);
  g.beginPath(); g.arc(300, 330, 300, Math.PI * 1.28, Math.PI * 1.72); g.stroke(); g.setLineDash([]);
  for (let d = -40; d <= 40; d += 5) {
    const hh = Math.round(a.h / 5) * 5 + d, ang = Math.PI * 1.5 + (hh - a.h) * D * 1.1;
    if (ang < Math.PI * 1.28 || ang > Math.PI * 1.72) continue;
    const n = ((hh % 360) + 360) % 360;
    const x = 300 + Math.cos(ang) * 300, y = 330 + Math.sin(ang) * 300;
    const name = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[n];
    if (name) mt(name, x, y - 14, 15, name === 'N' ? '#ffffff' : GR, 'center');
  }
  // Raiders off to the side: purple carets on the compass arc.
  for (const f of foes) {
    const r = rel(f, a);
    if (Math.abs(r.dh) > 40) continue;
    const ang = Math.PI * 1.5 + r.dh * D * 1.1, x = 300 + Math.cos(ang) * 300, y = 330 + Math.sin(ang) * 300;
    g.fillStyle = f.kind === 'carrier' ? '#ff7ad0' : '#c8a8ff'; g.beginPath(); g.moveTo(x - 6, y + 4); g.lineTo(x + 6, y + 4); g.lineTo(x, y + 13); g.closePath(); g.fill();
  }
  g.fillStyle = GR; g.beginPath(); g.moveTo(300, 40); g.lineTo(294, 52); g.lineTo(306, 52); g.closePath(); g.fill();
  frameBox(258, 60, 84, 34); mt(String(Math.round(a.h) % 360).padStart(3, '0'), 300, 85, 22, '#ffffff', 'center');
  // Wave and score.
  notchBox(18, 104, 150, 34); mt('WAVE', 30, 128, 16); g.fillStyle = GR; g.fillRect(88, 108, 2, 26); mt(wave + '/' + (raid.endless ? '∞' : raid.waves.length), 98, 128, 16, '#fff');
  notchBox(432, 104, 150, 34); mt('SCORE', 444, 128, 16); g.fillRect(508, 108, 2, 26); mt(String(score).padStart(6, '0'), 576, 128, 16, '#fff', 'right');
  // Target bracket with a leader line and label.
  const under = underSight(a);
  const tgt = under || (foes.length ? foes.reduce((b, f) => (Math.abs(rel(f, a).dh) < Math.abs(rel(b, a).dh) ? f : b)) : null);
  if (tgt) {
    const p = screenOf(tgt.h, tgt.e);
    if (p && p.x > 0 && p.x < 600 && p.y > 0 && p.y < 600) {
      const r = Math.max(20, Math.tan(tgt.size * D) * F2 * 1.4);
      g.strokeStyle = weapon === 1 && lock === tgt && lockT >= 0.6 ? '#ff5a5a' : '#c8a8ff'; g.lineWidth = 2;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.moveTo(p.x + sx * r, p.y + sy * r * 0.5); g.lineTo(p.x + sx * r, p.y + sy * r); g.lineTo(p.x + sx * r * 0.5, p.y + sy * r); g.stroke(); }
      g.beginPath(); g.moveTo(p.x + r, p.y + r); g.lineTo(p.x + r + 26, p.y + r + 24); g.lineTo(p.x + r + 70, p.y + r + 24); g.stroke();
      const idx = foes.indexOf(tgt) + 1;
      mt((tgt.kind === 'scout' ? 'S' : tgt.kind === 'drone' ? 'D' : 'C') + idx + ' ' + tgt.kind.toUpperCase(), p.x + r + 30, p.y + r + 18, 14, '#c8d0ff');
      mt('R' + RANGE[tgt.kind] + ' A' + String(Math.round(((tgt.h % 360) + 360) % 360)).padStart(3, '0'), p.x + r + 30, p.y + r + 42, 14, '#c8d0ff');
      if (weapon === 1 && lock === tgt && lockT > 0) { g.strokeStyle = lockT >= 0.6 ? '#ff5a5a' : '#ffd34d'; g.beginPath(); g.arc(p.x, p.y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, lockT / 0.6)); g.stroke(); }
    }
  }
  // Reticle: dashed ring, inner ring, small cross.
  const w = WEAPONS[weapon];
  g.strokeStyle = under ? '#ffffff' : GR; g.lineWidth = 4; g.setLineDash([10, 6]);
  g.beginPath(); g.arc(300, 300, weapon === 2 ? Math.tan(7 * D) * F2 : 54, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  g.lineWidth = 1.5; g.beginPath(); g.arc(300, 300, 38, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(300, 262); g.lineTo(300, 278); g.moveTo(300, 322); g.lineTo(300, 338); g.moveTo(262, 300); g.lineTo(278, 300); g.moveTo(322, 300); g.lineTo(338, 300); g.stroke();
  g.fillStyle = GR; g.fillRect(298, 298, 4, 4);
  mt('SHD ' + Math.round(shield), 300, 392, 16, shieldOn > 0 ? '#ffffff' : GR, 'center');
  // The gun barrel at the bottom and the horizon line.
  g.strokeStyle = 'rgba(255,220,220,.9)'; g.lineWidth = 3; g.beginPath(); g.moveTo(300, 600); g.lineTo(300, 520); g.stroke();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(300, 518, 3, 0, Math.PI * 2); g.fill();
  const hy = screenOf(a.h, 0);
  if (hy && hy.y > 380 && hy.y < 600) { g.strokeStyle = GRD; g.lineWidth = 1.5; g.beginPath(); g.moveTo(30, hy.y); g.lineTo(570, hy.y); g.stroke(); for (let x = 60; x < 560; x += 80) g.fillRect(x, hy.y - 6, 1.5, 6); }
  // Hull as a bar under the shield readout.
  g.fillStyle = 'rgba(124,255,154,.2)'; g.fillRect(240, 400, 120, 5); g.fillStyle = hp > 35 ? GR : '#ff5a5a'; g.fillRect(240, 400, 120 * Math.max(0, hp) / 100, 5);
  // Weapons strip and the shield button.
  notchBox(20, 548, 116, 36, GR, shieldOn > 0 ? 'rgba(124,255,154,.35)' : 'rgba(0,12,4,.6)'); mt('SHIELD', 78, 572, 16, '#fff', 'center');
  mt('‹', 196, 574, 22, GR, 'center'); mt('›', 576, 574, 22, GR, 'center');
  WEAPONS.forEach((wp, i) => {
    const x = 210 + i * 118, on = i === weapon;
    notchBox(x, 548, 108, 36, on ? '#ffffff' : GRD, on ? 'rgba(124,255,154,.18)' : 'rgba(0,12,4,.6)');
    mt(wp.name, x + 54, 572, 14, on ? '#fff' : GR, 'center');
  });
  g.fillStyle = GR; g.fillRect(210 + weapon * 118, 590, 108 * (1 - reload / w.reload), 4);
  // Incoming fire from the side.
  for (const s of shots) {
    if (s.kind !== 'bolt' || s.d > 0.5) continue;
    const r = rel(s, a);
    if (Math.abs(r.dh) < 33) continue;
    g.fillStyle = GK.blink(now, 150) ? '#ff3d3d' : '#ffb35c';
    g.fillRect(r.dh > 0 ? 588 : 0, 150, 12, 300);
  }
  if (msgT > 0) mt(msg, 300, 220, 22, msg === 'HIT' ? '#ff6b6b' : '#ffd34d', 'center');
  if (state === 'play' && time < 8) mt(aimHead ? 'LOOK AT A RAIDER, PINCH TO FIRE' : 'SWIPE LEFT OR RIGHT TO JUMP TO A TARGET', 300, 470, 15, '#ffffff', 'center');
  if (aimHead && !GK.headLive() && GK.blink(now, 800)) mt('HEAD AIM WAITING · SWIPES WORK', 300, 440, 13, '#ffb35c', 'center');
}
const F2 = 300 / Math.tan(32 * D);

function titleArc(text) {
  g.strokeStyle = GR; g.lineWidth = 3; g.setLineDash([16, 8]);
  g.beginPath(); g.arc(300, 330, 300, Math.PI * 1.3, Math.PI * 1.7); g.stroke(); g.setLineDash([]);
  mt(text, 300, 58, 18, GR, 'center');
}

function setupScreen() {
  titleArc('H E A D   T R A C K I N G');
  mt('SENTRY AIMS WHERE YOU LOOK', 300, 110, 17, '#fff', 'center');
  [['ENABLE HEAD TRACKING', 'PINCH TO ENABLE HEAD TRACKING'], ['AIM WITH SWIPES', 'SWIPE TO JUMP BETWEEN TARGETS']].forEach(([t1, t2], i) => {
    const y = 160 + i * 96, on = i === setupI;
    notchBox(on ? 70 : 80, y, on ? 460 : 440, 78, on ? '#ffffff' : GR);
    if (on) { g.fillStyle = GR; g.fillRect(70, y, 6, 78); }
    mt(t1, on ? 96 : 104, y + 36, 22, '#fff'); mt(t2, on ? 96 : 104, y + 62, 13, GR);
  });
  mt('YOU CAN CHANGE THIS IN SETTINGS', 300, 410, 15, GR, 'center');
  mt('STAY AWARE OF YOUR SURROUNDINGS', 300, 448, 15, '#ffb070', 'center');
  mt('SWIPE UP OR DOWN · PINCH TO CHOOSE', 300, 570, 14, GR, 'center');
}
let setupI = 0;

const raidList = () => RAIDS.concat([ENDLESS]);
const MENU = () => [
  { t: 'CAMPAIGN', s: () => { const r = raidList()[pick]; return r.name.toUpperCase() + ' ‹ › · ' + Math.min(reached - 1, 3) + ' OF 3 RAIDS CLEARED'; }, act: () => { const r = raidList()[pick]; if (r.endless || pick + 1 <= reached) start(r); else beep(200, 0.2); }, side: (d) => (pick = (pick + d + 4) % 4) },
  { t: 'AIM', s: () => (aimHead ? 'HEAD TRACKING' : 'SWIPES'), act: () => { aimHead = !aimHead; store.set('sentry.head', aimHead); if (aimHead) GK.askHead(); }, side: () => {} },
  { t: 'RE-CENTER', s: () => 'LOOK AHEAD, THEN PINCH', act: () => { GK.recentre(); beep(800, 0.1); }, side: () => {} },
  { t: 'SOUND', s: () => (GK.sound.on ? 'ON' : 'OFF'), act: () => GK.setSound(!GK.sound.on), side: () => {} },
];
let menuI = 0;
function menuScreen() {
  titleArc('S E N T R Y');
  MENU().forEach((it, i) => {
    const y = 90 + i * 104, on = i === menuI;
    notchBox(on ? 56 : 66, y, on ? 488 : 468, 86, on ? '#ffffff' : GR);
    if (on) { g.fillStyle = GR; g.fillRect(56, y, 6, 86); }
    mt(it.t, on ? 84 : 92, y + 40, 26, '#fff', 'left', 600);
    mt(it.s(), on ? 84 : 92, y + 68, 13, GR);
  });
}

function panel(now, title, lines, prompt, colour = GR) {
  notchBox(70, 180, 460, 120 + lines.length * 26, colour);
  mt(title, 300, 228, 26, '#fff', 'center');
  lines.forEach((t, i) => mt(t, 300, 264 + i * 26, 14, colour, 'center', 600));
  if (GK.blink(now)) mt(prompt, 300, 264 + lines.length * 26 + 20, 15, '#fff', 'center');
}

function render(now) {
  render3d(now);
  g.clearRect(0, 0, 600, 600);
  if (state === 'title') { titleArc('S E N T R Y'); mt('SKY DEFENCE', 300, 260, 40, '#fff', 'center', 800); mt('PINCH TO START', 300, 330, 18, GR, 'center'); return; }
  if (state === 'aim-setup') return setupScreen();
  if (state === 'menu') return menuScreen();
  const a = aimed();
  hud(a, now);
  if (state === 'brief') panel(now, raid.name.toUpperCase(), [aimHead ? 'LOOK AT RAIDERS TO AIM' : 'LEFT / RIGHT: JUMP TO THE NEXT RAIDER', 'UP: WEAPON · DOWN: SHIELD · PINCH: FIRE'], 'PINCH TO BEGIN');
  if (state === 'pause') panel(now, 'PAUSED', ['LEFT: BACK TO THE MENU'], 'PINCH TO CONTINUE');
  if (state === 'won') panel(now, 'SKY CLEAR', ['SCORE ' + score + ' · HULL ' + Math.max(0, Math.round(hp)) + '%'], 'PINCH FOR THE MENU');
  if (state === 'lost') panel(now, 'OVERRUN', [raid.endless ? 'REACHED WAVE ' + wave : 'SCORE ' + score, 'DOWN: BACK TO THE MENU'], 'PINCH TO RETRY', '#ff6b6b');
}

/* ------------------------------------------------------------------ input */

GK.input.onKey = (k) => {
  if (state === 'title') { if (k === 'Enter') state = store.get('sentry.setup', false) ? 'menu' : 'aim-setup'; return; }
  if (state === 'aim-setup') {
    if (k === 'ArrowUp' || k === 'ArrowDown') setupI = 1 - setupI;
    else if (k === 'Enter') { aimHead = setupI === 0; store.set('sentry.head', aimHead); store.set('sentry.setup', true); if (aimHead) GK.askHead(); state = 'menu'; }
    return;
  }
  if (state === 'menu') {
    const items = MENU();
    if (k === 'ArrowUp') menuI = (menuI + items.length - 1) % items.length;
    else if (k === 'ArrowDown') menuI = (menuI + 1) % items.length;
    else if (k === 'ArrowLeft' || k === 'ArrowRight') items[menuI].side(k === 'ArrowLeft' ? -1 : 1);
    else if (k === 'Enter') items[menuI].act();
    beep(560, 0.03);
    return;
  }
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

window.sentry = { get state() { return state; }, set state(x) { state = x; }, start, tick, fire, aimed, rel, RAIDS, ENDLESS, get foes() { return foes; }, get shots() { return shots; }, get view() { return view; }, set weapon(x) { weapon = x; }, get weapon() { return weapon; }, get reload() { return reload; }, get lockT() { return lockT; }, get shield() { return shield; }, get shieldOn() { return shieldOn; }, set shieldOn(x) { shieldOn = x; }, get hp() { return hp; }, get time() { return time; }, get wave() { return wave; }, set lock(x) { lock = x; } };
