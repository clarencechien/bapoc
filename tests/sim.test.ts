import { describe, expect, it } from 'vitest';
import { balance, DEFAULT_PARAMS, SCENARIOS, simulate, STEPS, type ScenarioId } from '../src/sim';

const ids = Object.keys(SCENARIOS) as ScenarioId[];

describe('synthetic day + EMS', () => {
  for (const id of ids) for (const ems of [true, false]) {
    it(`${id} ems=${ems}: energy balances every step, SoC stays in range`, () => {
      const { steps, kpis } = simulate(id, { ...DEFAULT_PARAMS, ems });
      expect(steps).toHaveLength(STEPS);
      for (const s of steps) {
        expect(Math.abs(balance(s))).toBeLessThan(1e-9);
        expect(s.soc).toBeGreaterThanOrEqual(0.099);
        expect(s.soc).toBeLessThanOrEqual(0.951);
        expect(s.gridImport * s.gridExport).toBe(0);
      }
      expect(kpis.aiTrainingDone).toBeCloseTo(1, 6);
      expect(kpis.evServed).toBeGreaterThan(0.97);
    });
  }

  it('is deterministic for the same seed', () => {
    expect(simulate('sunny', DEFAULT_PARAMS).kpis).toEqual(simulate('sunny', DEFAULT_PARAMS).kpis);
  });

  it('EMS lowers peak import and cost on a sunny weekday', () => {
    const on = simulate('sunny', DEFAULT_PARAMS).kpis, off = simulate('sunny', { ...DEFAULT_PARAMS, ems: false }).kpis;
    expect(on.peakImport).toBeLessThan(off.peakImport);
    expect(on.cost).toBeLessThan(off.cost);
  });

  it('DR event cuts grid import during 18-19 h', () => {
    const on = simulate('dr', DEFAULT_PARAMS).kpis, off = simulate('dr', { ...DEFAULT_PARAMS, ems: false }).kpis;
    expect(on.drReduction!).toBeLessThan(off.drReduction! - 3);
  });
});
