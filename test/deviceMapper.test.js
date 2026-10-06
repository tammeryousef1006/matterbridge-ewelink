import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deviceFunctions, deviceState, mergeParams, onOffParams } from '../dist/deviceMapper.js';

const device = (uiid, params) => ({ deviceid: 'id', name: 'Device', online: true, uiid, params });

test('single channel switch', () => {
  const d = device(1, { switch: 'on' });
  const functions = deviceFunctions(d);
  assert.deepEqual(functions, [{ kind: 'onOff', id: 'switch' }]);
  assert.deepEqual(deviceState(d, functions).onOff, { switch: true });
  assert.deepEqual(onOffParams(functions[0], false), { switch: 'off' });
});

test('multi channel switch uses the known channel count', () => {
  const switches = [0, 1, 2, 3].map((outlet) => ({ switch: outlet === 1 ? 'on' : 'off', outlet }));
  const d = device(2, { switches });
  const functions = deviceFunctions(d);
  assert.deepEqual(
    functions.map((fn) => fn.id),
    ['channel1', 'channel2'],
  );
  assert.deepEqual(deviceState(d, functions).onOff, { channel1: false, channel2: true });
  assert.deepEqual(onOffParams(functions[1], false), { switches: [{ switch: 'off', outlet: 1 }] });
});

test('unknown multi channel device falls back to the switches array', () => {
  const d = device(999, { switches: [{ switch: 'on', outlet: 0 }, { switch: 'off', outlet: 1 }, { switch: 'off', outlet: 2 }] });
  assert.equal(deviceFunctions(d).length, 3);
});

test('TH16 is a switch with temperature and humidity', () => {
  const d = device(15, { switch: 'off', currentTemperature: '23.5', currentHumidity: '41' });
  const functions = deviceFunctions(d);
  assert.deepEqual(
    functions.map((fn) => fn.kind),
    ['onOff', 'temperature', 'humidity'],
  );
  const state = deviceState(d, functions);
  assert.equal(state.temperature, 23.5);
  assert.equal(state.humidity, 41);
  assert.equal(state.battery, undefined);
});

test('TH16 without a probe is only a switch', () => {
  const d = device(15, { switch: 'on', currentTemperature: 'unavailable', currentHumidity: 'unavailable' });
  assert.deepEqual(deviceFunctions(d), [{ kind: 'onOff', id: 'switch' }]);
});

test('TX Ultimate gangs use the real channel count', () => {
  const switches = [0, 1, 2, 3].map((outlet) => ({ switch: 'off', outlet }));
  assert.deepEqual([209, 210, 211, 212].map((uiid) => deviceFunctions(device(uiid, { switches })).length), [1, 2, 3, 4]);
});

test('SNZB-06P presence sensor', () => {
  const d = device(7016, { human: 1, brState: 'brighter' });
  const functions = deviceFunctions(d);
  assert.deepEqual(functions, [{ kind: 'motion', id: 'motion' }]);
  const state = deviceState(d, functions);
  assert.equal(state.motion, true);
  assert.equal(state.battery, undefined);
});

test('Zigbee temperature/humidity sensor', () => {
  const d = device(1770, { temperature: '2150', humidity: '4875', battery: 87 });
  const state = deviceState(d, deviceFunctions(d));
  assert.equal(state.temperature, 21.5);
  assert.equal(state.humidity, 48.75);
  assert.equal(state.battery, 87);
});

test('Zigbee door sensor and motion sensor', () => {
  const door = device(3026, { lock: 1, battery: 100 });
  assert.deepEqual(deviceFunctions(door), [{ kind: 'contact', id: 'contact' }]);
  assert.equal(deviceState(door, deviceFunctions(door)).contact, false);
  const motion = device(2026, { motion: 1, battery: 15 });
  assert.equal(deviceState(motion, deviceFunctions(motion)).motion, true);
});

test('unsupported devices have no functions', () => {
  assert.deepEqual(deviceFunctions(device(28, { rfList: [] })), []);
});

test('merges channel changes into cached params', () => {
  const params = { switches: [{ switch: 'off', outlet: 0 }, { switch: 'off', outlet: 1 }], other: 1 };
  const merged = mergeParams(params, { switches: [{ switch: 'on', outlet: 1 }] });
  assert.deepEqual(merged.switches, [{ switch: 'off', outlet: 0 }, { switch: 'on', outlet: 1 }]);
  assert.equal(merged.other, 1);
  assert.equal(params.switches[1].switch, 'off');
});
