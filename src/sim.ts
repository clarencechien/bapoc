// Synthetic 24 h energy data for the fictional T-City Green Tower and a rule-based EMS.
// Everything here is an assumption for the demo, not data about Taipei 101. Units: MW, MWh, hours.

export const STEPS = 96;
export const DT = 0.25; // h

export type ScenarioId = 'sunny' | 'cloudy' | 'typhoon' | 'weekend' | 'dr';

export const SCENARIOS: Record<ScenarioId, { label: string; cloud: number; occupancy: number; drEvent?: [number, number] }> = {
  sunny: { label: '晴天平日', cloud: 0.1, occupancy: 1 },
  cloudy: { label: '多雲平日', cloud: 0.65, occupancy: 1 },
  typhoon: { label: '颱風停班日', cloud: 0.95, occupancy: 0.35 },
  weekend: { label: '晴天假日', cloud: 0.1, occupancy: 0.4 },
  dr: { label: '需量反應事件（18–19 時）', cloud: 0.1, occupancy: 1, drEvent: [18, 19] },
};

export const ASSUMPTIONS = {
  latitude: 25.03, dayOfYear: 200,
  pv: { southArea: 27000, eastArea: 27000, efficiency: 0.18, performanceRatio: 0.85 }, // next-gen semi-transparent BIPV, assumed,
  building: { night: 3.2, peak: 8.5 },
  ai: { itLoad: 2.0, pue: 1.25, maxBoost: 1.5 },
  bess: { power: 5, capacity: 10, efficiency: 0.92, minSoc: 0.1, maxSoc: 0.95, initialSoc: 0.5 },
  ev: { acChargers: 120, acKw: 11, dcChargers: 8, dcKw: 120 },
  carbon: 0.494, // kgCO2e/kWh, illustrative grid factor
  feedIn: 4.0, // NTD/kWh, illustrative
};

export interface Params {
  ems: boolean;             // false = baseline: no dispatch, BESS idle, EV charges on arrival, AI flat
  contractMw: number;       // grid import target the EMS tries to stay below
  evCapMw: number;          // total EV charging cap under EMS
  aiFlexShare: number;      // share of AI IT load that is deferrable training (0..0.6)
  bessReserve: number;      // SoC kept for peak shaving / DR (0..0.5)
}

export const DEFAULT_PARAMS: Params = { ems: true, contractMw: 10, evCapMw: 1.2, aiFlexShare: 0.3, bessReserve: 0.2 };

export interface Step {
  hour: number; price: number;
  pvSouth: number; pvEast: number; pv: number;
  building: number; ai: number; aiTraining: number; ev: number;
  bessCharge: number; bessDischarge: number; soc: number;
  gridImport: number; gridExport: number;
  heatRecovery: number; dr: boolean; evCars: number;
}

export interface Kpis {
  pvMwh: number; loadMwh: number; selfConsumption: number; renewableShare: number;
  peakImport: number; cost: number; carbonT: number; evServed: number; aiTrainingDone: number;
  overContractMw: number; drReduction: number | null;
}

// Seeded PRNG so a scenario always replays the same day.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function price(hour: number): number { // illustrative 3-tier TOU, NTD/kWh
  if (hour >= 16 && hour < 22) return 8.0;
  if (hour >= 9 && hour < 16) return 5.0;
  if (hour >= 22) return 5.0;
  return 2.3;
}

export function sun(hour: number, lat = ASSUMPTIONS.latitude, day = ASSUMPTIONS.dayOfYear) {
  const decl = 23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365) * Math.PI / 180;
  const ha = (hour - 12) * 15 * Math.PI / 180, phi = lat * Math.PI / 180;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const alt = Math.asin(sinAlt);
  // azimuth from north, clockwise
  const cosAz = (Math.sin(decl) - Math.sin(alt) * Math.sin(phi)) / (Math.cos(alt) * Math.cos(phi));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (ha > 0) az = 2 * Math.PI - az;
  return { alt, az };
}

// Irradiance on a vertical facade (W/m2) facing facadeAz (rad from north).
export function facadeIrradiance(hour: number, facadeAz: number, cloud: number): number {
  const { alt, az } = sun(hour);
  if (alt <= 0) return 0;
  const sa = Math.sin(alt);
  const dni = 900 * Math.exp(-0.14 / Math.max(sa, 0.05)) * (1 - 0.9 * cloud);
  const dhi = (60 + 80 * cloud) * sa + 20;
  const ghi = dni * sa + dhi;
  const cosInc = Math.cos(alt) * Math.cos(az - facadeAz);
  return dni * Math.max(0, cosInc) + dhi * 0.5 + 0.2 * ghi * 0.5;
}

interface EvSession { arrive: number; leave: number; need: number; maxMw: number; got: number }

function evSessions(occupancy: number, r: () => number): EvSession[] {
  const out: EvSession[] = [];
  const commuters = Math.round(140 * occupancy), visitors = Math.round(40 + 30 * (1 - occupancy));
  for (let i = 0; i < commuters; i++) {
    const arrive = 7.5 + r() * 2.5, leave = 17 + r() * 2.5;
    const dc = r() < 0.06;
    out.push({ arrive, leave, need: (8 + r() * 22) / 1000, maxMw: dc ? 0.12 : 0.011, got: 0 });
  }
  for (let i = 0; i < visitors; i++) {
    const arrive = 10 + r() * 10, leave = Math.min(23.9, arrive + 1 + r() * 3);
    const dc = r() < 0.25;
    out.push({ arrive, leave, need: (6 + r() * 20) / 1000, maxMw: dc ? 0.12 : 0.011, got: 0 });
  }
  return out;
}

export function simulate(scenarioId: ScenarioId, p: Params, seed = 101): { steps: Step[]; kpis: Kpis } {
  const sc = SCENARIOS[scenarioId], A = ASSUMPTIONS, r = rng(seed);
  const noise = Array.from({ length: STEPS }, () => r());
  const cloudNoise = Array.from({ length: STEPS }, () => r());
  const sessions = evSessions(sc.occupancy, r);
  const evNeed = sessions.reduce((s, e) => s + e.need, 0);

  // Exogenous profiles.
  const base = Array.from({ length: STEPS }, (_, i) => {
    const hour = i * DT + DT / 2;
    const cloud = Math.min(1, sc.cloud + (cloudNoise[i] - 0.5) * 0.25 * (sc.cloud > 0.3 ? 1 : 0.3));
    const kw = (area: number, az: number) => area * facadeIrradiance(hour, az, cloud) * A.pv.efficiency * A.pv.performanceRatio / 1e6;
    const pvSouth = kw(A.pv.southArea, Math.PI), pvEast = kw(A.pv.eastArea, Math.PI / 2);
    const office = hour >= 7 && hour < 20 ? Math.sin(Math.PI * (hour - 7) / 13) ** 0.6 : 0;
    const cooling = Math.max(0, Math.sin(Math.PI * (hour - 6) / 16)) * (1 - 0.5 * sc.cloud);
    const building = A.building.night + (A.building.peak - A.building.night) * (0.7 * office * sc.occupancy + 0.3 * cooling) + (noise[i] - 0.5) * 0.3;
    return { hour, pvSouth, pvEast, pv: pvSouth + pvEast, building };
  });

  // AI: fixed inference + deferrable training energy quota (same daily energy with or without EMS).
  const fixedIt = A.ai.itLoad * (1 - p.aiFlexShare);
  const flexIt = A.ai.itLoad * p.aiFlexShare;
  const training = new Array(STEPS).fill(flexIt);
  if (p.ems && flexIt > 0) {
    // Greedy: fill cheapest steps (price minus a solar-surplus bonus) up to maxBoost, skip DR window.
    const quota = flexIt * STEPS, cap = flexIt * A.ai.maxBoost;
    const score = base.map((b, i) => price(b.hour) - 3 * Math.max(0, b.pv - b.building) + (inDr(sc, b.hour) ? 100 : 0) + i * 1e-6);
    const order = score.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
    training.fill(0);
    let left = quota;
    for (const [, i] of order) { const take = Math.min(cap, left); training[i] = take; left -= take; if (left <= 1e-9) break; }
  }

  const steps: Step[] = [];
  let soc = A.bess.initialSoc * A.bess.capacity;
  const eff = Math.sqrt(A.bess.efficiency);
  for (let i = 0; i < STEPS; i++) {
    const b = base[i], hour = b.hour, dr = inDr(sc, hour);
    const ai = (fixedIt + training[i]) * A.ai.pue;

    // EV allocation.
    const present = sessions.filter(s => s.arrive <= hour && s.leave > hour && s.got < s.need - 1e-9);
    let ev = 0;
    if (!p.ems) {
      for (const s of present) { const q = Math.min(s.maxMw, (s.need - s.got) / DT); s.got += q * DT; ev += q; }
    } else {
      // Minimum power to finish by departure, then extra when cheap or sunny, capped (DR: minimum only).
      const want = present.map(s => {
        const remaining = s.need - s.got, tLeft = Math.max(DT, s.leave - hour);
        const must = Math.min(s.maxMw, Math.max(0, remaining - (tLeft - DT) * s.maxMw * 0.9) / DT);
        return { s, must: Math.min(must, remaining / DT), max: Math.min(s.maxMw, remaining / DT) };
      });
      for (const w of want) { ev += w.must; w.s.got += w.must * DT; }
      // Extra charging fills the valley under 90% of the contract, never in peak-price hours or a DR event.
      const headroom = 0.9 * p.contractMw - (b.building + ai - b.pv);
      let budget = dr || price(hour) >= 8 ? 0 : Math.max(0, Math.min(p.evCapMw, headroom) - ev);
      {
        for (const w of want.sort((a, c) => a.s.leave - c.s.leave)) {
          const extra = Math.min(w.max - w.must, budget); if (extra <= 0) continue;
          w.s.got += extra * DT; ev += extra; budget -= extra;
        }
      }
    }

    const load = b.building + ai + ev;
    let net = load - b.pv; // >0 needs grid/BESS
    let charge = 0, discharge = 0;
    if (p.ems) {
      let reserve = Math.max(A.bess.minSoc, p.bessReserve) * A.bess.capacity;
      if (sc.drEvent && hour < sc.drEvent[0])   // keep a full hour of discharge for the announced DR event
        reserve = Math.max(reserve, Math.min(A.bess.maxSoc, A.bess.minSoc + A.bess.power * (sc.drEvent[1] - sc.drEvent[0]) / A.bess.capacity / eff) * A.bess.capacity);
      const maxDis = (floor: number) => Math.max(0, Math.min(A.bess.power, (soc - floor) * eff / DT));
      const maxChg = Math.max(0, Math.min(A.bess.power, (A.bess.maxSoc * A.bess.capacity - soc) / eff / DT));
      if (net < 0) charge = Math.min(maxChg, -net);                               // solar surplus
      else if (dr) discharge = Math.min(maxDis(A.bess.minSoc * A.bess.capacity), net); // DR: everything
      else if (net > p.contractMw) discharge = Math.min(maxDis(A.bess.minSoc * A.bess.capacity), net - p.contractMw); // peak shave
      else if (price(hour) >= 8) discharge = Math.min(maxDis(reserve), net, Math.max(0, soc - reserve) * eff / Math.max(DT, 22 - hour + DT / 2)); // spread over the peak-price window
      else if (price(hour) <= 2.3 && hour > 1) {                                   // off-peak top-up toward 90% by 09:00
        const target = 0.9 * A.bess.capacity, stepsLeft = Math.max(1, (9 - hour) / DT);
        charge = Math.min(maxChg, Math.max(0, (target - soc) / eff / DT / stepsLeft * 1.5), Math.max(0, 0.8 * p.contractMw - net));
      }
      soc += charge * eff * DT - discharge / eff * DT;
    }
    net += charge - discharge;
    const gridImport = Math.max(0, net), gridExport = Math.max(0, -net);
    steps.push({ hour, price: price(hour), pvSouth: b.pvSouth, pvEast: b.pvEast, pv: b.pv, building: b.building, ai,
      aiTraining: training[i] * A.ai.pue, ev, bessCharge: charge, bessDischarge: discharge, soc: soc / A.bess.capacity,
      gridImport, gridExport, heatRecovery: (fixedIt + training[i]) * 0.6, dr, evCars: present.length });
  }

  const sum = (f: (s: Step) => number) => steps.reduce((t, s) => t + f(s) * DT, 0);
  const pvMwh = sum(s => s.pv), exportMwh = sum(s => s.gridExport), importMwh = sum(s => s.gridImport);
  const loadMwh = sum(s => s.building + s.ai + s.ev);
  const peakImport = Math.max(...steps.map(s => s.gridImport));
  const drSteps = steps.filter(s => s.dr);
  return {
    steps,
    kpis: {
      pvMwh, loadMwh, selfConsumption: pvMwh > 0 ? 1 - exportMwh / pvMwh : 1,
      renewableShare: loadMwh > 0 ? (pvMwh - exportMwh) / loadMwh : 0,
      peakImport, cost: sum(s => s.gridImport * s.price - s.gridExport * A.feedIn) * 1000,
      carbonT: importMwh * A.carbon, evServed: evNeed > 0 ? sessions.reduce((t, s) => t + Math.min(s.got, s.need), 0) / evNeed : 1,
      aiTrainingDone: flexIt > 0 ? training.reduce((t, x) => t + x, 0) / (flexIt * STEPS) : 1,
      overContractMw: Math.max(0, peakImport - p.contractMw),
      drReduction: drSteps.length ? drSteps.reduce((t, s) => t + s.gridImport, 0) / drSteps.length : null,
    },
  };
}

function inDr(sc: { drEvent?: [number, number] }, hour: number) {
  return !!sc.drEvent && hour >= sc.drEvent[0] && hour < sc.drEvent[1];
}

// Energy balance residual per step (sources - sinks), for tests and the on-screen check.
export function balance(s: Step): number {
  return s.pv + s.gridImport + s.bessDischarge - (s.building + s.ai + s.ev + s.bessCharge + s.gridExport);
}
