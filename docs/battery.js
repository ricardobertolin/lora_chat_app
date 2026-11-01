// Battery state from the single voltage the firmware reports.
//
// A LiPo's voltage maps to charge very non-linearly, so a straight
// (v - 3.3) / (4.2 - 3.3) reads badly wrong in the middle of the range. The
// curve below is piecewise-linear through measured points and is the same one
// the buddy-tracker firmware uses.
//
// Whether it is charging cannot be read directly: the Heltec V3 exposes no
// charge-status pin. Two things stand in for it, in order of trust:
//   1. The app is connected by cable, so USB is physically present. Certain.
//   2. The voltage is climbing. Only USB can do that. Needs two samples.
// Anything else is reported as running on the battery, which is the safe
// assumption to show.

const CURVE = [
  [4200, 100], [4100, 90], [4000, 78], [3900, 65], [3800, 50],
  [3700, 32], [3600, 15], [3500, 6], [3300, 0],
];

// At rest a full cell sits near 4.2 V. On USB the charger holds the node up,
// so anything at or above this is "topped up" rather than a real 100%.
export const FULL_MV = 4150;
// Smaller rises than this are ADC noise, not charging.
export const RISE_MV = 15;

export function percentFromMv(mv) {
  if (!Number.isFinite(mv) || mv <= 0) return null;
  if (mv >= CURVE[0][0]) return 100;
  for (let i = 1; i < CURVE.length; i++) {
    const [hiMv, hiPct] = CURVE[i - 1];
    const [loMv, loPct] = CURVE[i];
    if (mv >= loMv) {
      return Math.round(loPct + ((mv - loMv) * (hiPct - loPct)) / (hiMv - loMv));
    }
  }
  return 0;
}

// `prev` is the previous reading in mV, or null on the first sample.
export function stateOf({ mv, onCable, prevMv = null }) {
  if (!Number.isFinite(mv) || mv <= 0) return 'no battery';
  if (onCable) return mv >= FULL_MV ? 'charged, on USB' : 'charging';
  if (prevMv !== null && mv - prevMv >= RISE_MV) return 'charging';
  if (mv >= FULL_MV) return 'full';
  return 'on battery';
}

export function describe({ mv, onCable, prevMv = null }) {
  if (!Number.isFinite(mv) || mv <= 0) {
    return { text: 'no battery', pct: null, state: 'no battery' };
  }
  const pct = percentFromMv(mv);
  const state = stateOf({ mv, onCable, prevMv });
  return { text: `${pct}% ${(mv / 1000).toFixed(2)}V ${state}`, pct, state };
}

// Four coarse buckets, so the indicator can be coloured without the caller
// re-deriving thresholds.
export function level(pct) {
  if (pct === null) return 'none';
  if (pct >= 60) return 'good';
  if (pct >= 25) return 'fair';
  return 'weak';
}
