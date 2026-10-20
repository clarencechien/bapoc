import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ASSUMPTIONS, balance, DEFAULT_PARAMS, SCENARIOS, simulate, STEPS, sun, type Kpis, type Params, type ScenarioId, type Step } from './sim';
import { drawChart, drawSpark } from './chart';
import './style.css';

const BASE = import.meta.env.BASE_URL;
const TOWER_H = 508;         // m, roof + spire of the reference silhouette
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = { pv: css('--pv'), grid: css('--grid'), bess: css('--bess'), building: css('--building'), ai: css('--ai'), ev: css('--ev'), heat: css('--heat') };

// ---------- renderer, scene, camera ----------
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 20; controls.maxDistance = 2200;

const sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x2b2f24, 0.6);
scene.add(sunLight, sunLight.target, hemi);

// ---------- ground, district, basement ----------
const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 0.95, transparent: true });
const ground = new THREE.Mesh(new THREE.CircleGeometry(1400, 64).rotateX(-Math.PI / 2), groundMat);
scene.add(ground);
const plaza = new THREE.Mesh(new THREE.PlaneGeometry(220, 180).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8f86, roughness: 0.9, transparent: true }));
plaza.position.y = 0.1; scene.add(plaza);

// Simple massing blocks for the surrounding district (stand-ins; see the concept image for the intent).
{
  const r = mulberry(7), geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4d5866, roughness: 0.55, metalness: 0.3 });
  const n = 90, blocks = new THREE.InstancedMesh(geo, mat, n), m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    let x = 0, z = 0;
    do { x = (r() - 0.5) * 1500; z = (r() - 0.5) * 1500; } while (Math.abs(x) < 190 && Math.abs(z) < 170);
    const h = 20 + r() ** 2 * 140, w = 30 + r() * 40, d = 30 + r() * 40;
    blocks.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d)));
  }
  scene.add(blocks);
}

const basement = new THREE.Group();
scene.add(basement);
const BASE_W = 180, BASE_D = 140;
{
  const shell = new THREE.Mesh(new THREE.BoxGeometry(BASE_W, 24, BASE_D), new THREE.MeshStandardMaterial({ color: 0x223040, transparent: true, opacity: 0.18, side: THREE.BackSide, depthWrite: false }));
  shell.position.y = -12;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shell.geometry), new THREE.LineBasicMaterial({ color: 0x4b6a8a }));
  edges.position.y = -12;
  const slabMat = new THREE.MeshStandardMaterial({ color: 0x55606c, roughness: 0.9, transparent: true, opacity: 0.45, depthWrite: false });
  const b1 = new THREE.Mesh(new THREE.BoxGeometry(BASE_W - 2, 0.6, BASE_D - 2), slabMat); b1.position.y = -10.5;
  const b3 = new THREE.Mesh(new THREE.BoxGeometry(BASE_W - 2, 0.6, BASE_D - 2), slabMat); b3.position.y = -23.5;
  basement.add(shell, edges, b1, b3);
}
const substation = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.5, roughness: 0.4 });
  for (let i = 0; i < 3; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(8, 7, 6), mat); t.position.set(i * 11, 3.5, 0); substation.add(t);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(9, 5, 1), mat); fin.position.set(i * 11, 3, 3.5); substation.add(fin);
  }
  const fence = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(40, 4, 20)), new THREE.LineBasicMaterial({ color: 0x8792a0 }));
  fence.position.set(11, 2, 0); substation.add(fence);
  substation.position.set(-190, 0, -150);
  substation.traverse(o => (o.userData.node = 'grid'));
  scene.add(substation);
}

// ---------- models ----------
const draco = new DRACOLoader().setDecoderPath(`${BASE}draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco);
const load = (name: string) => loader.loadAsync(`${BASE}models/${name}`).then(g => g.scene);
const query = new URLSearchParams(location.search);

const tower = new THREE.Group();
scene.add(tower);
// Half-width (x) and half-depth (z) of the tower per height bin, measured from the generated mesh.
const BINS = 96;
let profile: { y: number; hx: number; hz: number }[] = fallbackProfile();
const towerMaterials: THREE.MeshStandardMaterial[] = [];
const xrayExtras = new THREE.Group();
scene.add(xrayExtras);
const pickables: THREE.Object3D[] = [substation];

async function loadTower() {
  const model = await load(query.get('tower') ?? 'tower.glb');
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const s = TOWER_H / size.y;
  model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  model.scale.setScalar(s);
  tower.add(model);
  model.updateMatrixWorld(true);
  profile = measureProfile(model);
  model.traverse(o => {
    if ((o as THREE.Mesh).isMesh) {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
      m.transparent = true; towerMaterials.push(m); o.userData.node = 'building'; pickables.push(o);
    }
  });
}

function measureProfile(model: THREE.Object3D) {
  const hx = new Array(BINS).fill(0), hz = new Array(BINS).fill(0), v = new THREE.Vector3();
  model.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const b = Math.min(BINS - 1, Math.max(0, Math.floor(v.y / TOWER_H * BINS)));
      hx[b] = Math.max(hx[b], Math.abs(v.x)); hz[b] = Math.max(hz[b], Math.abs(v.z));
    }
  });
  return hx.map((x, i) => ({ y: (i + 0.5) * TOWER_H / BINS, hx: x, hz: hz[i] }));
}

function fallbackProfile() {
  return Array.from({ length: BINS }, (_, i) => {
    const y = (i + 0.5) * TOWER_H / BINS;
    const w = y < 30 ? 70 : y < 430 ? 32 + ((y - 30) % 50) / 50 * 8 : y < 470 ? 22 : 3;
    return { y, hx: w, hz: w };
  });
}
const halfAt = (y: number) => profile[Math.min(BINS - 1, Math.max(0, Math.floor(y / TOWER_H * BINS)))];

// Floors, core and the facade PV skin, built from the measured profile (accurate placement for data overlays).
const floorMat = new THREE.MeshStandardMaterial({ color: 0x3d6ea8, emissive: 0x60a5fa, emissiveIntensity: 0.2, transparent: true, opacity: 0.35, depthWrite: false });
const pvMat = { south: pvMaterial(), east: pvMaterial() };
function pvMaterial() { return new THREE.MeshBasicMaterial({ color: COLORS.pv, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }); }

const pvSkins = new THREE.Group();
scene.add(pvSkins);
function buildOverlays() {
  xrayExtras.clear(); pvSkins.clear();
  for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i].userData.overlay) pickables.splice(i, 1);
  const floors = profile.filter(p => p.y > 34 && p.y < 440);
  const step = 2, inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.5, 1), floorMat, Math.ceil(floors.length / step)), m = new THREE.Matrix4();
  floors.filter((_, i) => i % step === 0).forEach((p, i) => inst.setMatrixAt(i, m.compose(new THREE.Vector3(0, p.y, 0), new THREE.Quaternion(), new THREE.Vector3(p.hx * 1.8, 1, p.hz * 1.8))));
  inst.userData.node = 'building'; inst.userData.overlay = true; pickables.push(inst);
  const core = new THREE.Mesh(new THREE.BoxGeometry(18, 440, 18), new THREE.MeshStandardMaterial({ color: 0x8aa0b8, transparent: true, opacity: 0.25, depthWrite: false }));
  core.position.y = 220;
  xrayExtras.add(inst, core);
  // Stepped skin 0.6 m outside the south (+z) and east (+x) faces.
  for (const face of ['south', 'east'] as const) {
    const pos: number[] = [];
    for (const p of profile) {
      if (p.y < 34 || p.y > 445) continue;
      const y0 = p.y - TOWER_H / BINS / 2, y1 = p.y + TOWER_H / BINS / 2;
      if (face === 'south') { const z = p.hz + 0.6, w = p.hx * 0.92; pos.push(-w, y0, z, w, y0, z, w, y1, z, -w, y0, z, w, y1, z, -w, y1, z); }
      else { const x = p.hx + 0.6, w = p.hz * 0.92; pos.push(x, y0, w, x, y0, -w, x, y1, -w, x, y0, w, x, y1, -w, x, y1, w); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const skin = new THREE.Mesh(g, pvMat[face]); skin.userData.node = face === 'south' ? 'pvSouth' : 'pvEast'; skin.userData.overlay = true;
    pvSkins.add(skin); pickables.push(skin);
  }
}

// Equipment: TRELLIS models placed as stand-ins (each instance represents a group of real units).
async function loadEquipment() {
  const [bess, ev, ai] = await Promise.all([load('bess.glb'), load('ev.glb'), load('ai-rack.glb')]);
  const place = (src: THREE.Object3D, node: string, size: number, at: THREE.Vector3[], rotY: number) => {
    const box = new THREE.Box3().setFromObject(src), s = size / box.getSize(new THREE.Vector3()).x;
    for (const p of at) {
      const c = src.clone(); c.scale.setScalar(s); c.rotation.y = rotY;
      c.position.copy(p).add(new THREE.Vector3(0, -box.min.y * s, 0));
      c.traverse(o => { o.userData.node = node; if ((o as THREE.Mesh).isMesh) pickables.push(o); });
      basement.add(c);
    }
  };
  const grid = (x0: number, z0: number, nx: number, nz: number, dx: number, dz: number, y: number) =>
    Array.from({ length: nx * nz }, (_, i) => new THREE.Vector3(x0 + (i % nx) * dx, y, z0 + Math.floor(i / nx) * dz));
  place(bess, 'bess', 7, grid(20, -46, 6, 2, 11, 14, -23.2), 0);
  place(ev, 'ev', 1.6, grid(-80, 14, 10, 2, 6, 18, -10.2), 0);
  place(ai, 'ai', 9, grid(-80, -50, 3, 2, 13, 12, -23.2), 0);
}

// ---------- energy flows ----------
const HUB = new THREE.Vector3(0, -16, -5);
type FlowKey = 'pvSouth' | 'pvEast' | 'grid' | 'bess' | 'building' | 'ai' | 'ev';
interface Flow { key: FlowKey; color: string; curve: THREE.CatmullRomCurve3; points: THREE.Points; line: THREE.Line; phase: number; value: number }
const flows: Flow[] = [];
const dotTexture = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!, grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.55, '#fff'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const NODE_POS: Record<FlowKey, THREE.Vector3> = {
  pvSouth: new THREE.Vector3(0, 260, 0), pvEast: new THREE.Vector3(0, 260, 0), grid: new THREE.Vector3(-170, 4, -150),
  bess: new THREE.Vector3(48, -20, -38), building: new THREE.Vector3(0, 260, 0), ai: new THREE.Vector3(-62, -20, -44), ev: new THREE.Vector3(-53, -8, 26),
};

function buildFlows() {
  for (const f of flows) { scene.remove(f.points, f.line); }
  flows.length = 0;
  const s = halfAt(260), base = halfAt(40);
  NODE_POS.pvSouth.set(0, 260, s.hz + 2); NODE_POS.pvEast.set(s.hx + 2, 260, 0);
  const paths: Record<FlowKey, THREE.Vector3[]> = {
    pvSouth: [NODE_POS.pvSouth, new THREE.Vector3(0, 140, halfAt(140).hz + 2), new THREE.Vector3(0, 40, base.hz + 3), new THREE.Vector3(0, 2, 30), HUB],
    pvEast: [NODE_POS.pvEast, new THREE.Vector3(halfAt(140).hx + 2, 140, 0), new THREE.Vector3(base.hx + 3, 40, 0), new THREE.Vector3(30, 2, 0), HUB],
    grid: [NODE_POS.grid, new THREE.Vector3(-120, -3, -110), new THREE.Vector3(-60, -16, -50), HUB],
    bess: [NODE_POS.bess, new THREE.Vector3(25, -18, -20), HUB],
    building: [HUB, new THREE.Vector3(0, 30, 0), new THREE.Vector3(0, 150, 0), NODE_POS.building],
    ai: [HUB, new THREE.Vector3(-30, -19, -30), NODE_POS.ai],
    ev: [HUB, new THREE.Vector3(-25, -10, 12), NODE_POS.ev],
  };
  for (const key of Object.keys(paths) as FlowKey[]) {
    const color = key.startsWith('pv') ? COLORS.pv : COLORS[key as keyof typeof COLORS];
    const curve = new THREE.CatmullRomCurve3(paths[key]);
    const n = 60, geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 4, sizeAttenuation: false, map: dotTexture, alphaTest: 0.1, transparent: true, depthWrite: false, depthTest: false }));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(120)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false }));
    points.renderOrder = line.renderOrder = 10;
    scene.add(line, points);
    flows.push({ key, color, curve, points, line, phase: Math.random(), value: 0 });
  }
}

// Signed flow toward the hub (sources positive) for the current step.
function flowValue(key: FlowKey, s: Step): number {
  switch (key) {
    case 'pvSouth': return s.pvSouth;
    case 'pvEast': return s.pvEast;
    case 'grid': return s.gridImport - s.gridExport;
    case 'bess': return s.bessDischarge - s.bessCharge;
    case 'building': return s.building;
    case 'ai': return s.ai;
    case 'ev': return s.ev;
  }
}
const OUTBOUND = new Set<FlowKey>(['building', 'ai', 'ev']); // curves drawn hub -> load

function animateFlows(dt: number) {
  const v = new THREE.Vector3();
  for (const f of flows) {
    const mag = Math.abs(f.value), dir = (OUTBOUND.has(f.key) ? 1 : 1) * Math.sign(f.value || 0);
    f.phase = (f.phase + dt * (0.04 + 0.05 * Math.min(mag, 10) / 3) * dir + 1) % 1;
    const pos = f.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = pos.count, visible = Math.round(Math.min(n, 6 + mag * 9));
    for (let i = 0; i < n; i++) {
      if (i >= visible) { pos.setXYZ(i, 0, -9999, 0); continue; }
      f.curve.getPointAt((i / visible + f.phase) % 1, v); pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    (f.points.material as THREE.PointsMaterial).size = (3 + Math.min(mag, 10) * 0.9) * Math.min(devicePixelRatio, 2);
    (f.points.material as THREE.PointsMaterial).opacity = mag < 0.01 ? 0 : 0.9;
    (f.line.material as THREE.LineBasicMaterial).opacity = mag < 0.01 ? 0.06 : 0.3;
  }
}

// ---------- labels ----------
const LABELS: { key: string; title: string; color: string; at: () => THREE.Vector3; text: (s: Step) => string }[] = [
  { key: 'pvSouth', title: '南面光電', color: COLORS.pv, at: () => NODE_POS.pvSouth.clone().add(new THREE.Vector3(0, 40, 0)), text: s => mw(s.pvSouth) },
  { key: 'pvEast', title: '東面光電', color: COLORS.pv, at: () => NODE_POS.pvEast.clone().add(new THREE.Vector3(0, 70, 0)), text: s => mw(s.pvEast) },
  { key: 'building', title: '大樓負載', color: COLORS.building, at: () => new THREE.Vector3(0, 380, 0), text: s => mw(s.building) },
  { key: 'grid', title: '台電', color: COLORS.grid, at: () => NODE_POS.grid.clone().add(new THREE.Vector3(10, 14, 0)), text: s => s.gridExport > 0 ? `送出 ${mw(s.gridExport)}` : `購入 ${mw(s.gridImport)}` },
  { key: 'bess', title: '儲能', color: COLORS.bess, at: () => NODE_POS.bess.clone().add(new THREE.Vector3(0, 12, 0)), text: s => `${Math.round(s.soc * 100)}% ${s.bessDischarge > 0 ? '放 ' + mw(s.bessDischarge) : s.bessCharge > 0 ? '充 ' + mw(s.bessCharge) : '待機'}` },
  { key: 'ai', title: 'AI 機房', color: COLORS.ai, at: () => NODE_POS.ai.clone().add(new THREE.Vector3(0, 12, 0)), text: s => mw(s.ai) },
  { key: 'ev', title: 'EV 充電', color: COLORS.ev, at: () => NODE_POS.ev.clone().add(new THREE.Vector3(0, 10, 0)), text: s => `${mw(s.ev)} · ${s.evCars} 車` },
];
const labelEls = LABELS.map(l => {
  const el = document.createElement('div'); el.className = 'tag'; el.style.setProperty('--c', l.color);
  el.addEventListener('click', () => select(l.key)); $('labels').append(el); return el;
});
function updateLabels(s: Step) {
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight, v = new THREE.Vector3();
  LABELS.forEach((l, i) => {
    v.copy(l.at()).project(camera);
    const el = labelEls[i], hidden = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
    el.style.display = hidden ? 'none' : '';
    el.style.left = `${(v.x + 1) / 2 * w}px`; el.style.top = `${(1 - v.y) / 2 * h}px`;
    el.innerHTML = `${l.title} <b>${l.text(s)}</b>`;
  });
}

// ---------- state, simulation, UI ----------
let scenario: ScenarioId = 'sunny';
const params: Params = { ...DEFAULT_PARAMS };
let run = simulate(scenario, params), baseline = simulate(scenario, { ...params, ems: false });
let t = 48, playing = true, selected: string | null = null, xray = false;

const sliders: [string, keyof Params, (v: number) => string][] = [
  ['contract', 'contractMw', v => `${v.toFixed(2)} MW`], ['evcap', 'evCapMw', v => `${v.toFixed(1)} MW`],
  ['aiflex', 'aiFlexShare', v => `${Math.round(v * 100)}%`], ['reserve', 'bessReserve', v => `${Math.round(v * 100)}%`],
];
for (const [id, key, fmt] of sliders) {
  const input = $<HTMLInputElement>(id), out = $(`${id}-v`);
  input.value = String(params[key]); out.textContent = fmt(+input.value);
  input.addEventListener('input', () => { (params[key] as number) = +input.value; out.textContent = fmt(+input.value); resimulate(); });
}
const scenarioSel = $<HTMLSelectElement>('scenario');
for (const [id, s] of Object.entries(SCENARIOS)) scenarioSel.add(new Option(s.label, id));
scenarioSel.addEventListener('change', () => { scenario = scenarioSel.value as ScenarioId; resimulate(); });
$<HTMLInputElement>('ems').addEventListener('change', e => { params.ems = (e.target as HTMLInputElement).checked; resimulate(); });
const timeInput = $<HTMLInputElement>('time');
timeInput.addEventListener('input', () => { t = +timeInput.value; playing = false; $('play').textContent = '▶'; });
$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? '❚❚' : '▶'; });
$('play').textContent = '❚❚';
$<HTMLInputElement>('xray').addEventListener('change', e => setXray((e.target as HTMLInputElement).checked));

function resimulate() {
  run = simulate(scenario, params);
  baseline = simulate(scenario, { ...params, ems: false });
  renderKpis(run.kpis, simulate(scenario, { ...params, ems: !params.ems }).kpis);
}

function renderKpis(k: Kpis, other: Kpis) {
  const on = params.ems ? k : other, off = params.ems ? other : k;
  const item = (label: string, a: number, b: number, fmt: (x: number) => string, lowerIsBetter: boolean) => {
    const d = a - b, good = lowerIsBetter ? d < -1e-6 : d > 1e-6, bad = lowerIsBetter ? d > 1e-6 : d < -1e-6;
    return `<div class="kpi"><span>${label}</span><b>${fmt(a)}</b><em class="${good ? 'good' : bad ? 'bad' : ''}">無調度 ${fmt(b)}</em></div>`;
  };
  $('kpis').innerHTML = [
    item('尖峰購電', on.peakImport, off.peakImport, x => `${x.toFixed(2)} MW`, true),
    item('今日電費', on.cost / 1e4, off.cost / 1e4, x => `${x.toFixed(1)} 萬元`, true),
    item('碳排', on.carbonT, off.carbonT, x => `${x.toFixed(1)} t`, true),
    item('超出契約', on.overContractMw, off.overContractMw, x => `${x.toFixed(2)} MW`, true),
    item('再生能源占比', on.renewableShare, off.renewableShare, pct, false),
    item('EV 充電完成率', on.evServed, off.evServed, pct, false),
    ...(on.drReduction != null ? [item('需量反應時段平均購電', on.drReduction, off.drReduction!, x => `${x.toFixed(2)} MW`, true)] : []),
    item('光電發電量', on.pvMwh, off.pvMwh, x => `${x.toFixed(1)} MWh`, false),
  ].join('');
}

function renderFlows(s: Step) {
  const rows: [string, string, number, string][] = [
    ['光電（南＋東）', COLORS.pv, s.pv, '供給'], ['台電', COLORS.grid, s.gridImport - s.gridExport, s.gridExport > 0 ? '送出' : '購入'],
    ['儲能', COLORS.bess, s.bessDischarge - s.bessCharge, s.bessDischarge > 0 ? '放電' : s.bessCharge > 0 ? '充電' : '待機'],
    ['大樓', COLORS.building, -s.building, '用電'], ['AI 機房', COLORS.ai, -s.ai, '用電'], ['EV 充電', COLORS.ev, -s.ev, '用電'],
  ];
  $('flows').innerHTML = rows.map(([name, c, v, verb]) =>
    `<span class="dot" style="background:${c}"></span><span>${name} <small style="color:var(--muted)">${verb}</small><div class="bar"><i style="background:${c};width:${Math.min(100, Math.abs(v) / 10 * 100)}%"></i></div></span><span class="val">${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} MW</span>`).join('');
  const err = balance(s);
  $('balance').textContent = `平衡檢查：供給 − 用電 − 儲能充電 − 送出 = ${err.toExponential(1)} MW${s.dr ? '　·　需量反應事件進行中' : ''}`;
}

// ---------- selection & detail ----------
const DETAIL: Record<string, { title: string; series: (s: Step) => number; color: string; info: (s: Step) => string }> = {
  pvSouth: { title: '南面光電玻璃', color: COLORS.pv, series: s => s.pvSouth, info: s => `輸出 ${mw(s.pvSouth)}；面積 ${ASSUMPTIONS.pv.southArea.toLocaleString()} m²，效率 ${ASSUMPTIONS.pv.efficiency * 100}%（假設）。今日 ${sumDay(x => x.pvSouth).toFixed(1)} MWh。` },
  pvEast: { title: '東面光電玻璃', color: COLORS.pv, series: s => s.pvEast, info: s => `輸出 ${mw(s.pvEast)}；面積 ${ASSUMPTIONS.pv.eastArea.toLocaleString()} m²。東面上午發電、南面中午前後發電。今日 ${sumDay(x => x.pvEast).toFixed(1)} MWh。` },
  grid: { title: '台電受電', color: COLORS.grid, series: s => s.gridImport - s.gridExport, info: s => `${s.gridExport > 0 ? '送出' : '購入'} ${mw(Math.max(s.gridImport, s.gridExport))}；電價 ${s.price} 元/kWh（示意時間電價）；契約 ${params.contractMw} MW。` },
  bess: { title: '地下室儲能', color: COLORS.bess, series: s => s.soc * 100, info: s => `電量 ${Math.round(s.soc * 100)}%；${ASSUMPTIONS.bess.power} MW / ${ASSUMPTIONS.bess.capacity} MWh；${s.bessDischarge > 0 ? '放電 ' + mw(s.bessDischarge) : s.bessCharge > 0 ? '充電 ' + mw(s.bessCharge) : '待機'}。曲線為電量（%）。` },
  building: { title: '大樓負載', color: COLORS.building, series: s => s.building, info: s => `辦公、空調、電梯、照明合計 ${mw(s.building)}。` },
  ai: { title: 'AI 機房', color: COLORS.ai, series: s => s.ai, info: s => `總用電 ${mw(s.ai)}（PUE ${ASSUMPTIONS.ai.pue}），其中訓練 ${mw(s.aiTraining)}，可在便宜或光電多時段執行；回收廢熱約 ${mw(s.heatRecovery)} 熱。` },
  ev: { title: '停車場充電樁', color: COLORS.ev, series: s => s.ev, info: s => `${s.evCars} 輛車充電中，${mw(s.ev)}；共 ${ASSUMPTIONS.ev.acChargers} 支交流、${ASSUMPTIONS.ev.dcChargers} 支直流（場景中每座模型代表一組）。` },
};
function select(key: string | null) {
  selected = key;
  $('detail').hidden = !key;
  if (key) { $('detail-title').textContent = DETAIL[key].title; $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', e => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', e => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false).find(h => h.object.visible && h.object.userData.node);
  select(hit ? hit.object.userData.node : null);
});

// ---------- views & x-ray ----------
const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number]; xray?: boolean }> = {
  overview: { pos: [520, 330, 640], target: [0, 190, 0] },
  facade: { pos: [330, 230, 380], target: [0, 250, 0] },
  basement: { pos: [170, 45, 120], target: [10, -20, -20], xray: true },
  ai: { pos: [-150, 15, 35], target: [-60, -22, -44], xray: true },
};
let camAnim: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; k: number } | null = null;
function goView(name: string, instant = false) {
  const v = VIEWS[name];
  document.querySelectorAll<HTMLButtonElement>('.view-bar button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  camAnim = { from: camera.position.clone(), to: new THREE.Vector3(...v.pos), tf: controls.target.clone(), tt: new THREE.Vector3(...v.target), k: instant ? 1 : 0 };
  if (v.xray !== undefined) setXray(v.xray); else if (name === 'overview') setXray(false);
  if (name === 'ai') select('ai'); else if (name === 'basement') select('bess'); else if (name === 'facade') select('pvSouth');
}
document.querySelectorAll<HTMLButtonElement>('.view-bar button').forEach(b => b.addEventListener('click', () => goView(b.dataset.view!)));
function setXray(on: boolean) {
  xray = on; $<HTMLInputElement>('xray').checked = on;
  for (const m of towerMaterials) { m.opacity = on ? 0.06 : 1; m.depthWrite = !on; }
  xrayExtras.visible = on;
  groundMat.opacity = on ? 0.25 : 1; (plaza.material as THREE.MeshStandardMaterial).opacity = on ? 0.2 : 1;
  groundMat.depthWrite = !on;
  basement.visible = on;
}

// ---------- frame loop ----------
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

const sky = { day: new THREE.Color(0x9cc6ec), dusk: new THREE.Color(0xf0a868), night: new THREE.Color(0x0c1424) };
let last = performance.now(), lastStep = -1, lastDetail = '';
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (playing) { t = (t + dt * 1.2) % STEPS; timeInput.value = String(Math.floor(t)); }
  const i = Math.floor(t) % STEPS, s = run.steps[i];
  const hour = t * 24 / STEPS;
  if (i !== lastStep) {
    lastStep = i;
    for (const f of flows) f.value = flowValue(f.key, s);
    renderFlows(s);
    $('clock').textContent = `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`;
    $('price-tag').textContent = `${SCENARIOS[scenario].label} · 電價 ${s.price} 元/kWh`;
    drawChart($<HTMLCanvasElement>('chart'), run.steps, baseline.steps, i, COLORS, $('legend'));
    pvMat.south.opacity = Math.min(0.3, s.pvSouth / 2.5 * 0.3); pvMat.east.opacity = Math.min(0.3, s.pvEast / 2.5 * 0.3);
    floorMat.emissiveIntensity = 0.1 + s.building / ASSUMPTIONS.building.peak * 0.9;
    if (selected) {
      const d = DETAIL[selected], html = `<div>${d.info(s)}</div><canvas id="spark" height="90"></canvas>`;
      if (html !== lastDetail) { $('detail-body').innerHTML = html; lastDetail = html; }
      drawSpark($<HTMLCanvasElement>('spark'), run.steps.map(d.series), i, d.color);
    }
  }
  // Sun and sky.
  const { alt, az } = sun(hour);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
  sunLight.position.copy(dir.clone().multiplyScalar(800)); sunLight.target.position.set(0, 0, 0);
  const day = THREE.MathUtils.smoothstep(Math.sin(alt), -0.1, 0.25);
  sunLight.intensity = 3 * day; hemi.intensity = 0.25 + 0.6 * day;
  const bg = sky.night.clone().lerp(sky.dusk, THREE.MathUtils.smoothstep(Math.sin(alt), -0.15, 0.05)).lerp(sky.day, THREE.MathUtils.smoothstep(Math.sin(alt), 0.05, 0.35));
  scene.background = bg; renderer.toneMappingExposure = 0.7 + 0.5 * day;

  if (camAnim) {
    camAnim.k = Math.min(1, camAnim.k + dt / 1.2);
     const e = camAnim.k * camAnim.k * (3 - 2 * camAnim.k);
    camera.position.lerpVectors(camAnim.from, camAnim.to, e); controls.target.lerpVectors(camAnim.tf, camAnim.tt, e);
    if (camAnim.k >= 1) camAnim = null;
  }
  controls.update();
  animateFlows(dt);
  renderer.render(scene, camera);
  updateLabels(s);
  requestAnimationFrame(frame);
}

// ---------- boot ----------
function mw(x: number) { return `${x.toFixed(2)} MW`; }
function pct(x: number) { return `${(x * 100).toFixed(1)}%`; }
function sumDay(f: (s: Step) => number) { return run.steps.reduce((a, s) => a + f(s) * 0.25, 0); }
function mulberry(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

resize();
camera.position.set(...VIEWS.overview.pos); controls.target.set(...VIEWS.overview.target);
resimulate();
setXray(false);
buildOverlays(); buildFlows();
requestAnimationFrame(frame);
Promise.all([
  loadTower().then(() => { buildOverlays(); buildFlows(); setXray(xray); }),
  loadEquipment(),
]).then(() => ($('loading').hidden = true))
  .catch(err => { $('loading').textContent = `模型載入失敗：${err.message}`; console.error(err); });
(window as unknown as { twin: object }).twin = { run: () => run, setTime: (x: number) => { t = x; playing = false; }, goView, setXray, select };
