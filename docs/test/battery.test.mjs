// node --test test/battery.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { percentFromMv, stateOf, describe, level, FULL_MV, RISE_MV } from '../battery.js';

test('percent follows the curve, not a straight line', () => {
  assert.equal(percentFromMv(4200), 100);
  assert.equal(percentFromMv(4300), 100, 'clamped above full');
  assert.equal(percentFromMv(3800), 50);
  assert.equal(percentFromMv(3300), 0);
  assert.equal(percentFromMv(3000), 0, 'clamped below empty');

  // 3.75 V sits midway between the 3700/32 and 3800/50 points.
  assert.equal(percentFromMv(3750), 41);

  // The whole point of the curve: a linear map would call 3.75 V exactly 50%.
  const linear = Math.round(((3750 - 3300) / (4200 - 3300)) * 100);
  assert.equal(linear, 50);
  assert.notEqual(percentFromMv(3750), linear);
});

test('percent rejects nonsense', () => {
  for (const bad of [null, undefined, NaN, 0, -1, 'x']) {
    assert.equal(percentFromMv(bad), null);
  }
});

test('a cable means USB is physically there, so it is charging', () => {
  assert.equal(stateOf({ mv: 3800, onCable: true }), 'charging');
  assert.equal(stateOf({ mv: 4200, onCable: true }), 'charged, on USB');
});

test('without a cable, only a rising voltage proves charging', () => {
  assert.equal(stateOf({ mv: 3800, onCable: false, prevMv: null }), 'on battery',
    'one sample cannot show a trend');
  assert.equal(stateOf({ mv: 3800, onCable: false, prevMv: 3700 }), 'charging');
  assert.equal(stateOf({ mv: 3700, onCable: false, prevMv: 3800 }), 'on battery',
    'falling is discharging');
});

test('small wobbles are ADC noise, not charging', () => {
  const mv = 3800;
  assert.equal(stateOf({ mv, onCable: false, prevMv: mv - (RISE_MV - 1) }), 'on battery');
  assert.equal(stateOf({ mv, onCable: false, prevMv: mv - RISE_MV }), 'charging');
});

test('a full cell off USB reads full, not charging', () => {
  assert.equal(stateOf({ mv: FULL_MV, onCable: false }), 'full');
  assert.equal(stateOf({ mv: FULL_MV - 1, onCable: false }), 'on battery');
});

test('no battery is reported rather than guessed at', () => {
  assert.equal(stateOf({ mv: 0, onCable: true }), 'no battery');
  assert.equal(describe({ mv: 0, onCable: true }).pct, null);
  assert.equal(describe({ mv: 0, onCable: true }).text, 'no battery');
});

test('describe reads as one line', () => {
  // 4.05 V is midway between the 4000/78 and 4100/90 points: 78 + 6.
  const d = describe({ mv: 4050, onCable: true });
  assert.equal(d.pct, 84);
  assert.equal(d.text, '84% 4.05V charging');
});

test('level buckets', () => {
  assert.equal(level(null), 'none');
  assert.equal(level(100), 'good');
  assert.equal(level(60), 'good');
  assert.equal(level(59), 'fair');
  assert.equal(level(25), 'fair');
  assert.equal(level(24), 'weak');
  assert.equal(level(0), 'weak');
});
