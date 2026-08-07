import { describe, it, expect } from 'vitest';
import {
  IDENTITY_TRANSFORM,
  makeTransform,
  toDisplayTime,
  toEventFrame,
} from '../../src/timeline.js';

describe('identity', () => {
  it('reads event frames as tenths of a second', () => {
    expect(toDisplayTime(IDENTITY_TRANSFORM, 0)).toBe(0);
    expect(toDisplayTime(IDENTITY_TRANSFORM, 100)).toBeCloseTo(1, 12);
    expect(toEventFrame(IDENTITY_TRANSFORM, 1)).toBeCloseTo(100, 12);
  });
});

describe('static offset', () => {
  it('shifts display time and inverts exactly', () => {
    const transform = makeTransform(0.25);
    expect(toDisplayTime(transform, 100)).toBeCloseTo(1.25, 12);
    expect(toEventFrame(transform, 1.25)).toBeCloseTo(100, 12);
  });

  it('accepts a negative offset, for a track that starts early', () => {
    const transform = makeTransform(-2);
    expect(toDisplayTime(transform, 100)).toBeCloseTo(-1, 12);
    expect(toEventFrame(transform, -1)).toBeCloseTo(100, 12);
  });

  it('round-trips at arbitrary positions', () => {
    const transform = makeTransform(0.3);
    for (const frame of [0, 1, 1750, 5990]) {
      expect(toEventFrame(transform, toDisplayTime(transform, frame))).toBeCloseTo(frame, 9);
    }
  });

  it('returns a fractional frame, leaving rounding to the caller', () => {
    // Landing between slots is a seek decision the event layout owns, because
    // only it knows whether the position falls inside a gap.
    expect(toEventFrame(IDENTITY_TRANSFORM, 0.125)).toBeCloseTo(12.5, 12);
  });
});
