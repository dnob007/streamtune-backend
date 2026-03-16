'use strict';
const { _computeState } = require('../src/services/syncEngine');

describe('SyncEngine._computeState', () => {
  const videos = [
    { id: 'v1', ytId: 'AAA', title: 'Track A', durationSec: 180 },
    { id: 'v2', ytId: 'BBB', title: 'Track B', durationSec: 240 },
    { id: 'v3', ytId: 'CCC', title: 'Track C', durationSec: 300 },
  ];
  const totalSec = 180 + 240 + 300; // 720
  const sched = { videos, totalSec };

  test('starts at first video when nowSec mod total = 0', () => {
    const state = _computeState(sched, totalSec * 10); // exact multiple
    expect(state.ytId).toBe('AAA');
    expect(state.frameAt).toBe(0);
    expect(state.videoIndex).toBe(0);
  });

  test('resolves second video mid-way', () => {
    // 200 seconds in → past video1 (180s), 20s into video2
    const state = _computeState(sched, totalSec * 5 + 200);
    expect(state.ytId).toBe('BBB');
    expect(state.frameAt).toBe(20);
    expect(state.videoIndex).toBe(1);
  });

  test('resolves third video', () => {
    // 180 + 240 + 50 = 470 seconds in
    const state = _computeState(sched, totalSec * 3 + 470);
    expect(state.ytId).toBe('CCC');
    expect(state.frameAt).toBe(50);
    expect(state.videoIndex).toBe(2);
  });

  test('wraps around playlist correctly', () => {
    // Exactly at totalSec → back to first video
    const state = _computeState(sched, totalSec * 7);
    expect(state.ytId).toBe('AAA');
    expect(state.frameAt).toBe(0);
  });

  test('same nowSec always returns same state (determinism)', () => {
    const nowSec = 1_700_000_123;
    const a = _computeState(sched, nowSec);
    const b = _computeState(sched, nowSec);
    expect(a).toEqual(b);
  });

  test('returns nextVideo title', () => {
    const state = _computeState(sched, totalSec * 2 + 5); // in first video
    expect(state.nextVideo).toBe('Track B');
  });

  test('nextVideo wraps to first for last video', () => {
    const state = _computeState(sched, totalSec * 4 + 421); // in last video
    expect(state.nextVideo).toBe('Track A');
  });
});
