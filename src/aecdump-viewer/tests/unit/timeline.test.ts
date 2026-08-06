import { describe, it, expect } from 'vitest';
import {
  IDENTITY_TRANSFORM,
  DriftCurve,
  makeTransform,
  toDisplayTime,
  toNativeTime,
} from '../../src/timeline.js';

const curve = (times: number[], offsets: number[]): DriftCurve => ({
  times: Float64Array.from(times),
  offsets: Float64Array.from(offsets),
});

describe('identity', () => {
  it('leaves every track on its own clock by default', () => {
    for (const t of [0, 1.5, 120]) {
      expect(toDisplayTime(IDENTITY_TRANSFORM, t)).toBe(t);
      expect(toNativeTime(IDENTITY_TRANSFORM, t)).toBe(t);
    }
  });
});

describe('static offset', () => {
  it('shifts display time and inverts exactly', () => {
    const transform = makeTransform(0.25);
    expect(toDisplayTime(transform, 1)).toBeCloseTo(1.25, 12);
    expect(toNativeTime(transform, 1.25)).toBeCloseTo(1, 12);
  });

  it('accepts a negative offset, for a track that starts early', () => {
    const transform = makeTransform(-2);
    expect(toDisplayTime(transform, 1)).toBeCloseTo(-1, 12);
    expect(toNativeTime(transform, -1)).toBeCloseTo(1, 12);
  });
});

describe('drift curve', () => {
  it('interpolates between samples', () => {
    const transform = makeTransform(0, curve([0, 10], [0, 0.1]));
    expect(toDisplayTime(transform, 0)).toBeCloseTo(0, 12);
    expect(toDisplayTime(transform, 5)).toBeCloseTo(5.05, 12);
    expect(toDisplayTime(transform, 10)).toBeCloseTo(10.1, 12);
  });

  it('holds the end values outside the sampled range', () => {
    // Beyond the evidence the correction stops changing rather than running
    // away on an extrapolated slope.
    const transform = makeTransform(0, curve([10, 20], [0.1, 0.2]));
    expect(toDisplayTime(transform, 0)).toBeCloseTo(0.1, 12);
    expect(toDisplayTime(transform, 100)).toBeCloseTo(100.2, 12);
  });

  it('composes with a static offset', () => {
    const transform = makeTransform(1, curve([0, 10], [0, 0.5]));
    expect(toDisplayTime(transform, 10)).toBeCloseTo(11.5, 12);
  });

  it('inverts a warped transform closely enough to seek with', () => {
    const transform = makeTransform(0.3, curve([0, 60], [0, 0.25]));
    for (const native of [0, 1, 17.5, 59.9]) {
      const display = toDisplayTime(transform, native);
      expect(toNativeTime(transform, display)).toBeCloseTo(native, 6);
    }
  });

  it('inverts even when the target lies outside the bracket', () => {
    const transform = makeTransform(0, curve([0, 10], [0, 0.1]));
    const display = toDisplayTime(transform, 500);
    expect(toNativeTime(transform, display)).toBeCloseTo(500, 6);
  });

  it('handles an empty curve as no correction', () => {
    const transform = makeTransform(0.5, curve([], []));
    expect(toDisplayTime(transform, 3)).toBeCloseTo(3.5, 12);
  });

  it('handles a single-sample curve as a constant correction', () => {
    const transform = makeTransform(0, curve([5], [0.2]));
    expect(toDisplayTime(transform, 0)).toBeCloseTo(0.2, 12);
    expect(toDisplayTime(transform, 100)).toBeCloseTo(100.2, 12);
  });
});
