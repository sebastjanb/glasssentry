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

import { THREE, makeRenderer, glowSprite, glowTexture, canvasTexture, frameClock } from './kit3d.js';

const VERSION = '3.0.0';
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
const fx = [];            // effects for the renderer: kills, hits, flak bursts

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
    fx.push({ type: 'flak', h: a.h, e: a.e });
    noise(0.3, 0.4, 1200);
    for (const f of foes) if (rel(f, a).dist < 7 + f.size) hit(f, f.kind === 'carrier' ? 8 : 25);
  }
}

function hit(f, n) {
  f.hp -= n;
  if (f.hp <= 0 && !f.gone) {
    f.gone = true;
    fx.push({ type: 'boom', h: f.h, e: f.e, kind: f.kind });
    score += f.kind === 'carrier' ? 500 : f.kind === 'scout' ? 100 : 30;
    blasts.push({ h: f.h, e: f.e, t: 0.6, r: f.size * 2, c: f.kind === 'carrier' ? '#ff5c5c' : '#ffd34d' });
    noise(f.kind === 'carrier' ? 0.8 : 0.25, 0.5, f.kind === 'carrier' ? 300 : 900);
    if (lock === f) { lock = null; lockT = 0; }
  } else { beep(900, 0.03, 'square', 0.12); fx.push({ type: 'spark', h: f.h, e: f.e, kind: f.kind }); }
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

// Reflections: a small studio sky baked once, so the metal hulls catch light.
{
  const envScene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vP; void main(){ float y = vP.y; vec3 c = mix(vec3(0.10,0.07,0.06), vec3(0.35,0.45,0.7), smoothstep(-0.2,0.8,y)); c += vec3(1.0,0.85,0.6) * pow(max(dot(vP, normalize(vec3(0.5,0.6,0.4))),0.0), 40.0) * 3.0; c += vec3(0.9,0.4,0.8) * pow(max(dot(vP, normalize(vec3(-0.7,0.1,-0.5))),0.0), 12.0) * 0.6; gl_FragColor = vec4(c,1.0); }',
  }));
  envScene.add(sky);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.02).texture;
}

const std = (c, e = 0.2) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.75, roughness: 0.28, emissive: c, emissiveIntensity: e });
// Hull plating: panel seams, rivets and a few vents, drawn once and shared.
const plateTex = canvasTexture(256, 128, (c, w, h) => {
  c.fillStyle = '#b8bccc'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) { c.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,20'},${Math.random() * 0.08})`; c.fillRect(Math.random() * w, Math.random() * h, 10 + Math.random() * 40, 6 + Math.random() * 20); }
  c.strokeStyle = 'rgba(20,24,40,.7)'; c.lineWidth = 1.5;
  for (let x = 0; x < w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 24) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  c.fillStyle = 'rgba(20,24,40,.6)'; for (let x = 4; x < w; x += 8) for (let y = 4; y < h; y += 24) c.fillRect(x, y, 1.5, 1.5);
  c.fillStyle = 'rgba(10,10,20,.8)'; for (let i = 0; i < 6; i++) { const x = Math.random() * w, y = Math.random() * h; for (let k = 0; k < 4; k++) c.fillRect(x, y + k * 4, 18, 2); }
}, true);
const plate = (c, e = 0.1) => new THREE.MeshStandardMaterial({ map: plateTex, color: c, metalness: 0.8, roughness: 0.3, emissive: c, emissiveIntensity: e });
// Windows strip for the carrier.
const winTex = canvasTexture(256, 32, (c, w, h) => {
  c.fillStyle = '#2a1a34'; c.fillRect(0, 0, w, h);
  for (let x = 2; x < w; x += 6) for (let y = 4; y < h - 4; y += 9) if (Math.random() < 0.6) { c.fillStyle = Math.random() < 0.8 ? '#ffd8a0' : '#9ae0ff'; c.fillRect(x, y, 3, 4); }
}, true);
const hexTex = canvasTexture(256, 256, (c, w, h) => {
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#7cff9a'; c.lineWidth = 2.5;
  const r = 16, dx = r * 1.5, dy = r * Math.sqrt(3);
  for (let i = -1; i < w / dx + 1; i++) for (let j = -1; j < h / dy + 1; j++) {
    const cx = i * dx, cy = j * dy + (i % 2 ? dy / 2 : 0);
    c.beginPath(); for (let k = 0; k <= 6; k++) { const a = k / 6 * Math.PI * 2; c[k ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r, cy + Math.sin(a) * r); } c.stroke();
  }
}, true);
hexTex.repeat.set(8, 4);
const ringTex = canvasTexture(128, 128, (c) => {
  const grd = c.createRadialGradient(64, 64, 30, 64, 64, 62);
  grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.75, 'rgba(255,255,255,.9)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grd; c.fillRect(0, 0, 128, 128);
});

function scoutModel() {
  // Saucer: a lathed plated disc, glass dome with a pilot glow, a spinning rim
  // of lights, under-glow and an antenna.
  const gp = new THREE.Group();
  const prof = [[0, -0.25], [0.35, -0.3], [0.6, -0.22], [1, -0.05], [1.04, 0], [0.9, 0.12], [0.45, 0.22], [0, 0.24]].map(([x, y]) => new THREE.Vector2(x, y));
  gp.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 36), plate(0xc8cee0, 0.08)));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.045, 8, 40), std(0x3a4058, 0.1)); rim.rotation.x = Math.PI / 2; gp.add(rim);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0x9be1ff, metalness: 0, roughness: 0.05, transmission: 0, transparent: true, opacity: 0.75, emissive: 0x2a8adf, emissiveIntensity: 0.6, clearcoat: 1 }));
  dome.position.y = 0.2; gp.add(dome);
  const pilot = glowSprite(0x9be15d, 0.6); pilot.position.y = 0.32; gp.add(pilot);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.015, 0.35, 4), std(0x8a90a0)); ant.position.y = 0.72; gp.add(ant);
  const tip = glowSprite(0xff5a5a, 0.25); tip.position.y = 0.9; gp.add(tip);
  gp.spin = new THREE.Group(); gp.add(gp.spin);
  gp.lights = [];
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2;
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd34d }));
    l.position.set(Math.cos(a) * 0.95, 0.03, Math.sin(a) * 0.95); gp.spin.add(l); gp.lights.push(l);
  }
  const under = glowSprite(0x7cff9a, 2.2); under.position.y = -0.35; under.material.opacity = 0.7; gp.add(under);
  const beamDown = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0x7cff9a, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  beamDown.position.y = -0.95; gp.add(beamDown);
  gp.add(glowSprite(0x9be15d, 3.2));
  return gp;
}
function droneModel() {
  // Interceptor: faceted body with a red eye, swept blades and twin engine glows.
  const gp = new THREE.Group();
  const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), plate(0xff7ad0, 0.25)); body.scale.set(1, 0.7, 1.4); gp.add(body);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2a4a })); eye.position.z = 0.62; gp.add(eye);
  const eg = glowSprite(0xff2a4a, 0.9); eg.position.z = 0.7; gp.add(eg);
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.55), plate(0xd04aa0, 0.2)); w.position.x = s * 0.95; w.rotation.z = s * 0.25; w.rotation.y = s * -0.3; gp.add(w);
    const tipL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.6), new THREE.MeshBasicMaterial({ color: 0xffb0e8 })); tipL.position.set(s * 1.68, s * 0.18, -0.1); gp.add(tipL);
    const eng = glowSprite(0xff9ae0, 0.8); eng.position.set(s * 0.25, 0, -0.75); gp.add(eng);
  }
  gp.add(glowSprite(0xff7ad0, 2.2));
  return gp;
}
function carrierModel() {
  // Mothership: plated hull, lit window decks, a spinning outer ring with
  // pylons, a glowing hangar mouth underneath and a bank of engines astern.
  const gp = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), plate(0x6a4a7a, 0.12)); hull.scale.set(1, 0.28, 0.55); gp.add(hull);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.8, 0.12, 48, 1, true), new THREE.MeshBasicMaterial({ map: winTex, side: THREE.DoubleSide })); deck.scale.set(1, 1, 0.66); deck.position.y = 0.12; gp.add(deck);
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), plate(0x8a6aa8, 0.12)); top.scale.set(1, 0.5, 0.7); top.position.y = 0.16; gp.add(top);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.18), std(0x9a7ab8)); bridge.position.y = 0.36; gp.add(bridge);
  const bwin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.01), new THREE.MeshBasicMaterial({ color: 0x9ae0ff })); bwin.position.set(0, 0.38, 0.095); gp.add(bwin);
  gp.ring = new THREE.Group(); gp.add(gp.ring);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.04, 8, 64), new THREE.MeshBasicMaterial({ color: 0xff5cc8 })); ring.rotation.x = Math.PI / 2; gp.ring.add(ring);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const py = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.24), std(0xd0b0e8, 0.3)); py.position.set(Math.cos(a) * 1.08, 0, Math.sin(a) * 1.08); py.rotation.y = -a; gp.ring.add(py); const pg = glowSprite(0xff5cc8, 0.5); pg.position.copy(py.position); gp.ring.add(pg); }
  gp.ring.scale.set(1, 1, 0.58);
  const hangar = glowSprite(0xff8a3a, 1.2); hangar.position.y = -0.3; hangar.material.opacity = 0.9; gp.add(hangar);
  const hm = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24), new THREE.MeshBasicMaterial({ color: 0xffb06a })); hm.rotation.x = Math.PI / 2; hm.position.y = -0.275; gp.add(hm);
  for (const x of [-0.3, -0.1, 0.1, 0.3]) { const e = glowSprite(0x7ad8ff, 0.6); e.position.set(x, 0, -0.56); gp.add(e); const n = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.12, 10), std(0x4a4a5a)); n.rotation.x = Math.PI / 2; n.position.set(x, 0, -0.52); gp.add(n); }
  gp.lights = [];
  for (let i = 0; i < 18; i++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff })); const a = (i / 18 - 0.5) * Math.PI * 0.9; l.position.set(Math.sin(a) * 0.98, -0.02, Math.cos(a) * 0.54); gp.add(l); gp.lights.push(l); }
  const aura = glowSprite(0xff5cc8, 2.6); aura.material.opacity = 0.3; gp.add(aura);
  return gp;
}

/* ------------------------------------------------------------- particles */

// One additive point cloud for sparks, fire, smoke and trails; sizes in world units.
const PN = 2400;
const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3), pSize = new Float32Array(PN), pAlpha = new Float32Array(PN);
const pVel = new Float32Array(PN * 3), pLife = new Float32Array(PN), pMax = new Float32Array(PN), pGrow = new Float32Array(PN), pBase = new Float32Array(PN), pGrav = new Float32Array(PN);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
const particles = new THREE.Points(pGeo, new THREE.ShaderMaterial({
  uniforms: { map: { value: glowTexture() } },
  vertexShader: 'attribute float aSize; attribute float aAlpha; varying vec3 vC; varying float vA; void main(){ vC = color; vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * 600.0 / -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform sampler2D map; varying vec3 vC; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.a * vA, 1.0); }',
  vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
particles.frustumCulled = false; scene.add(particles);
let pNext = 0;
const _c = new THREE.Color();
function emit(x, y, z, vx, vy, vz, colour, size, life, grow = 0, grav = 0) {
  const i = pNext; pNext = (pNext + 1) % PN;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
  _c.set(colour); pCol[i * 3] = _c.r; pCol[i * 3 + 1] = _c.g; pCol[i * 3 + 2] = _c.b;
  pBase[i] = size; pLife[i] = pMax[i] = life; pGrow[i] = grow; pGrav[i] = grav;
}
function stepParticles(dt) {
  const drag = Math.pow(0.35, dt);
  for (let i = 0; i < PN; i++) {
    if (pLife[i] <= 0) { pAlpha[i] = 0; continue; }
    pLife[i] -= dt;
    const k = Math.max(0, pLife[i] / pMax[i]);
    pVel[i * 3] *= drag; pVel[i * 3 + 1] = pVel[i * 3 + 1] * drag - pGrav[i] * dt; pVel[i * 3 + 2] *= drag;
    pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    pSize[i] = pBase[i] * (1 + pGrow[i] * (1 - k));
    pAlpha[i] = k * k;
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.color.needsUpdate = pGeo.attributes.aSize.needsUpdate = pGeo.attributes.aAlpha.needsUpdate = true;
}
const rnd = (a) => (Math.random() * 2 - 1) * a;
function burst(p, scale, palette, n, speed, life, grow = 0, grav = 0) {
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(rnd(1), rnd(1), rnd(1)).normalize().multiplyScalar(speed * scale * (0.3 + Math.random()));
    emit(p.x, p.y, p.z, v.x, v.y, v.z, palette[i % palette.length], scale * (0.3 + Math.random() * 0.5), life * (0.6 + Math.random() * 0.6), grow, grav * scale);
  }
}

// Wreckage: tumbling hot shards.
const DN = 220;
const debris = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x6a6a7a, metalness: 0.8, roughness: 0.4, emissive: 0xff7a2a, emissiveIntensity: 0.6 }), DN);
debris.frustumCulled = false; debris.count = DN; scene.add(debris);
const dState = Array.from({ length: DN }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), s: 0, life: 0 }));
let dNext = 0;
const _dm = new THREE.Matrix4(), _dq = new THREE.Quaternion(), _ds = new THREE.Vector3();
function shards(p, scale, n) {
  for (let i = 0; i < n; i++) {
    const d = dState[dNext]; dNext = (dNext + 1) % DN;
    d.p.copy(p); d.v.set(rnd(1), rnd(1) + 0.3, rnd(1)).normalize().multiplyScalar(scale * (1 + Math.random() * 2.5));
    d.w.set(rnd(8), rnd(8), rnd(8)); d.s = scale * (0.06 + Math.random() * 0.12); d.life = 1.4 + Math.random();
    d.grav = scale * 1.2;
  }
}
function stepDebris(dt) {
  for (let i = 0; i < DN; i++) {
    const d = dState[i];
    if (d.life <= 0) { debris.setMatrixAt(i, _dm.makeScale(0, 0, 0)); continue; }
    d.life -= dt;
    d.v.y -= d.grav * dt; d.p.addScaledVector(d.v, dt);
    d.r.x += d.w.x * dt; d.r.y += d.w.y * dt; d.r.z += d.w.z * dt;
    if (Math.random() < dt * 14) emit(d.p.x, d.p.y, d.p.z, 0, 0, 0, Math.random() < 0.5 ? '#ff8a3a' : '#5a4a48', d.s * 2.2, 0.5, 1.5);
    debris.setMatrixAt(i, _dm.compose(d.p, _dq.setFromEuler(d.r), _ds.setScalar(d.s * Math.min(1, d.life))));
  }
  debris.instanceMatrix.needsUpdate = true;
}

// Shockwave rings and flashes.
const rings = [];
function ringAt(p, size, colour, life = 0.6) {
  let r = rings.find((x) => x.t <= 0);
  if (!r) { r = { s: new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })), t: 0 }; scene.add(r.s); rings.push(r); }
  r.s.position.copy(p); r.size = size; r.t = r.max = life; r.s.material.color.set(colour); r.s.visible = true;
}
function stepRings(dt) {
  for (const r of rings) {
    if (r.t <= 0) { r.s.visible = false; continue; }
    r.t -= dt;
    const k = 1 - r.t / r.max;
    r.s.scale.setScalar(r.size * (0.2 + k * 1.6));
    r.s.material.opacity = (1 - k) * 0.9;
  }
}
const FIRE = ['#ffffff', '#fff0a0', '#ffc84a', '#ff8a2a', '#ff4a1a'];
function explode(p, scale, kind) {
  const big = kind === 'carrier';
  burst(p, scale, FIRE, big ? 260 : 90, 2.2, 0.9, 2.5, 0);
  burst(p, scale * 0.5, ['#ffffff', '#fff0c0'], big ? 80 : 30, 6, 0.45, 0, 1.5);
  burst(p, scale * 1.2, ['#3a2a2a', '#4a3a36', '#2a2224'], big ? 60 : 20, 0.8, 2.2, 3, -0.2);
  shards(p, scale, big ? 60 : kind === 'scout' ? 18 : 6);
  ringAt(p, scale * 6, kind === 'carrier' ? '#ff7ad0' : '#ffd38a', big ? 1.1 : 0.6);
  ringAt(p, scale * 3, '#ffffff', 0.25);
  if (big) setTimeout(() => { burst(p.clone().add(new THREE.Vector3(scale * 0.8, 0, 0)), scale * 0.8, FIRE, 120, 2, 0.8, 2); ringAt(p, scale * 9, '#ff5cc8', 1.2); }, 250);
}

// Laser: a white-hot core inside a cyan halo, with a muzzle flash.
const beamGrp = new THREE.Group(); beamGrp.visible = false; scene.add(beamGrp);
const beamCyl = new THREE.CylinderGeometry(4, 1, 1, 10, 1, true); beamCyl.translate(0, 0.5, 0);
for (const [r, c, o] of [[0.05, 0xffffff, 1], [0.14, 0x7fffd4, 0.5], [0.35, 0x2affb0, 0.16]]) {
  const m = new THREE.Mesh(beamCyl, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.scale.set(r, 1, r); m.base = o; beamGrp.add(m);
}
const muzzle = glowSprite(0x7fffd4, 2.5); scene.add(muzzle); muzzle.visible = false;
const _up = new THREE.Vector3(0, 1, 0);

// Missiles: a body with fins and a hot exhaust that leaves a smoke trail.
function missileModel() {
  const gp = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.6, 10), std(0xe8e8f0, 0.1)); body.rotation.x = Math.PI / 2; gp.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 10), std(0xff5a3a, 0.4)); nose.rotation.x = Math.PI / 2; nose.position.z = 1.05; gp.add(nose);
  for (let i = 0; i < 4; i++) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.4), std(0xd0d0e0)); f.rotation.z = i * Math.PI / 2; f.position.z = -0.65; f.translateY(0.25); gp.add(f); }
  const ex = glowSprite(0xffd34d, 2.4); ex.position.z = -1; gp.add(ex);
  return gp;
}
const missiles = [];
function missileAt(i) { if (!missiles[i]) { missiles[i] = missileModel(); scene.add(missiles[i]); } missiles[i].visible = true; return missiles[i]; }

// Shield: a hex dome around you, flaring while it is up.
const dome = new THREE.Mesh(new THREE.SphereGeometry(14, 40, 20), new THREE.MeshBasicMaterial({ map: hexTex, color: 0x7cff9a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide }));
dome.frustumCulled = false; scene.add(dome);

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

/* ---------------------------------------------------------------- render */

const _v = new THREE.Vector3();
let menuH = 0;

const sizeOf = (f) => Math.tan(f.size * D) * RANGE[f.kind] * (f.kind === 'carrier' ? 1 : 1.2);
const _w = new THREE.Vector3(), _g = new THREE.Vector3();

function render3d(now) {
  const dt = clock(now);
  const a = view ? aimed() : { h: (menuH += dt * 6) % 360, e: 12 };
  camera.rotation.y = -a.h * D;
  camera.rotation.x = a.e * D;
  camera.updateMatrixWorld();
  // Effects raised by the game since the last frame.
  while (fx.length) {
    const e = fx.shift();
    if (e.type === 'flak') {
      for (let i = 0; i < 7; i++) { const p = dirOf(e.h + rnd(5), e.e + rnd(4), 105 + rnd(10), new THREE.Vector3()); burst(p, 3, ['#ffd38a', '#ff9f43', '#ffffff'], 14, 2, 0.5, 2); burst(p, 3, ['#4a3a30', '#3a302a'], 6, 0.6, 1.6, 2.5); ringAt(p, 10, '#ff9f43', 0.4); }
      continue;
    }
    const sc = Math.tan((e.kind === 'carrier' ? 7 : e.kind === 'scout' ? 2.2 : 1.1) * D) * RANGE[e.kind] * (e.kind === 'carrier' ? 1 : 1.2);
    const p = dirOf(e.h, e.e, RANGE[e.kind], new THREE.Vector3());
    if (e.type === 'boom') explode(p, sc, e.kind);
    else { burst(p, sc * 0.4, ['#ffffff', '#7fffd4', '#fff0a0'], 10, 4, 0.3, 0, 1); ringAt(p, sc * 1.4, '#7fffd4', 0.2); }
  }
  const live = new Set();
  if (foes) for (const f of foes) {
    live.add(f);
    const m = meshFor(f);
    const r = RANGE[f.kind];
    dirOf(f.h, f.e, r, m.position);
    const sc = sizeOf(f);
    m.scale.setScalar(sc);
    m.rotation.y = -f.h * D + Math.sin(now / 700 + f.t) * 0.3;
    m.rotation.z = Math.sin(now / 500 + f.t) * 0.15;
    if (m.spin) m.spin.rotation.y = now / 400;
    if (m.ring) m.ring.rotation.y = now / 1500;
    if (m.lights) m.lights.forEach((l, i) => l.material.color.setHex((Math.floor(now / 160) + i) % 2 ? 0xffd34d : 0xff5a5a));
    // Damaged raiders trail fire and smoke.
    if (f.hp < f.max * 0.55 && Math.random() < dt * (f.kind === 'carrier' ? 40 : 18)) {
      const q = m.position;
      emit(q.x + rnd(sc * 0.4), q.y + rnd(sc * 0.1), q.z + rnd(sc * 0.4), 0, sc * 0.3, 0, Math.random() < 0.4 ? '#ff8a3a' : '#4a3a38', sc * 0.35, 1.2, 2.5);
    }
  }
  for (const [f, m] of foeMeshes) if (!live.has(f)) { scene.remove(m); foeMeshes.delete(f); }
  let si = 0, mi = 0;
  if (shots) for (const s of shots) {
    if (s.kind === 'bolt') {
      // Incoming plasma travels from the raider toward you, trailing sparks, growing as it comes.
      const sp = shotAt(si++);
      dirOf(s.h, s.e, 30 + 90 * s.d, sp.position);
      const col = s.big ? 0xff5cc8 : 0xff7a4d;
      sp.material.color.setHex(col);
      sp.scale.setScalar((s.big ? 6 : 3.5) * (1.6 - s.d));
      if (Math.random() < dt * 40) emit(sp.position.x, sp.position.y, sp.position.z, rnd(1), rnd(1), rnd(1), s.big ? '#ff9ae0' : '#ffb08a', (s.big ? 2.2 : 1.3) * (1.6 - s.d), 0.35, 0.5);
    } else {
      const mm = missileAt(mi++);
      dirOf(s.h, s.e, 70, _w);
      _g.copy(mm.position);
      mm.position.copy(_w);
      if (_g.lengthSq() > 1 && _g.distanceToSquared(_w) > 0.0001) mm.lookAt(_w.clone().multiplyScalar(2).sub(_g));
      mm.scale.setScalar(1.6);
      if (_g.lengthSq() > 1) for (let k = 0; k < 3; k++) { const t = k / 3; emit(_g.x + (_w.x - _g.x) * t, _g.y + (_w.y - _g.y) * t, _g.z + (_w.z - _g.z) * t, rnd(0.3), rnd(0.3), rnd(0.3), k ? '#8a8a96' : '#ffd38a', 1.2, k ? 1.4 : 0.25, 2.5); }
    }
  }
  shotList.slice(si).forEach((s) => (s.visible = false));
  missiles.slice(mi).forEach((m) => { m.visible = false; m.position.set(0, 0, 0); });
  beamGrp.visible = muzzle.visible = false;
  let bi = 0;
  if (blasts) for (const b of blasts) {
    if (b.beam) {
      const from = new THREE.Vector3(2.2, -3.2, -4).applyEuler(camera.rotation);
      const to = dirOf(b.h, b.e, 110, _v.clone());
      const dir = to.clone().sub(from);
      beamGrp.visible = muzzle.visible = true;
      beamGrp.position.copy(from);
      beamGrp.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
      beamGrp.scale.set(1, dir.length(), 1);
      const k = b.t / 0.12;
      beamGrp.children.forEach((m) => (m.material.opacity = m.base * k));
      muzzle.position.copy(from); muzzle.material.opacity = k;
      if (Math.random() < 0.6) emit(to.x, to.y, to.z, rnd(6), rnd(6), rnd(6), '#7fffd4', 2, 0.3);
      continue;
    }
    const sp = blastAt(bi++);
    dirOf(b.h, b.e, 110, sp.position);
    sp.material.color.set(b.c);
    sp.scale.setScalar(Math.tan(b.r * D) * 110 * 2 * (1.3 - b.t));
    sp.material.opacity = Math.min(1, b.t * 2) * 0.6;
  }
  blastList.slice(bi).forEach((s) => (s.visible = false));
  dome.material.opacity = shieldOn > 0 ? 0.18 + Math.sin(now / 60) * 0.05 : Math.max(0, dome.material.opacity - dt * 1.5);
  hexTex.offset.y = now / 20000;
  stepParticles(dt); stepDebris(dt); stepRings(dt);
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
