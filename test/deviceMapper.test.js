import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buttonPress, deviceFunctions, deviceState, illuminanceValue, mergeParams, onOffParams } from '../dist/deviceMapper.js';

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

test('SNZB-06P presence sensor with bright/dark light sensor', () => {
  const d = device(7016, { human: 1, brState: 'brighter' });
  const functions = deviceFunctions(d);
  assert.deepEqual(functions, [
    { kind: 'motion', id: 'motion' },
    { kind: 'illuminance', id: 'light' },
  ]);
  const state = deviceState(d, functions);
  assert.equal(state.motion, true);
  assert.equal(state.bright, true);
  assert.equal(state.battery, undefined);
  assert.equal(deviceState(device(7016, { human: 0, brState: 'darker' }), functions).bright, false);
});

test('illuminance values follow the Matter log scale', () => {
  assert.equal(illuminanceValue(1), 1);
  assert.equal(illuminanceValue(300), 24772);
  assert.equal(illuminanceValue(5), 6991);
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

test('virtual switches are single channel', () => {
  const switches = [0, 1, 2, 3].map((outlet) => ({ switch: outlet === 0 ? 'on' : 'off', outlet }));
  const d = device(264, { switches });
  const functions = deviceFunctions(d);
  assert.deepEqual(functions, [{ kind: 'onOff', id: 'channel1', channel: 0 }]);
  assert.deepEqual(deviceState(d, functions).onOff, { channel1: true });
});

test('NSPanel Pro security modes are three switches', () => {
  const d = device(195, { securityType: 2, temperature: 25 });
  const functions = deviceFunctions(d);
  assert.deepEqual(
    functions.map((fn) => [fn.kind, fn.id]),
    [
      ['security', 'home'],
      ['security', 'away'],
      ['security', 'sleep'],
    ],
  );
  assert.deepEqual(deviceState(d, functions).onOff, { home: false, away: true, sleep: false });
  const [home, away] = functions;
  assert.deepEqual(onOffParams(home, true, d.params), { securityType: 1, currentType: 1 });
  assert.deepEqual(onOffParams(away, false, d.params), { securityType: 0 });
  // Turning off a mode that is not armed leaves the armed one alone
  assert.equal(onOffParams(home, false, d.params), undefined);
});

test('devices without security modes are unchanged', () => {
  assert.deepEqual(deviceFunctions(device(281, {})), []);
});

const kinds = (uiid, params) => deviceFunctions(device(uiid, params)).map((fn) => `${fn.kind}:${fn.id}`);

test('lights, curtains, fans and thermostats get their own kinds', () => {
  assert.deepEqual(kinds(44, { switch: 'on', brightness: 50 }), ['light:light']);
  assert.deepEqual(kinds(104, { switch: 'on', ltype: 'white' }), ['light:light']);
  assert.deepEqual(kinds(258, { switch: 'pause', setclose: 10 }), ['cover:cover']);
  assert.deepEqual(kinds(7017, { workMode: '0' }), ['thermostat:thermostat']);
  assert.deepEqual(kinds(17, { fan: 'on' }), ['fan:fan']);
});

test('iFan is a fan plus its light relay', () => {
  const functions = deviceFunctions(device(34, { switches: [{ outlet: 0, switch: 'on' }] }));
  assert.deepEqual(
    functions.map((fn) => [fn.kind, fn.id, fn.channel, fn.light]),
    [
      ['fan', 'fan', undefined, undefined],
      ['onOff', 'light', 0, true],
    ],
  );
  assert.deepEqual(onOffParams(functions[1], false), { switches: [{ switch: 'off', outlet: 0 }] });
});

test('DualR3 and TX Ultimate are curtains only in motor mode', () => {
  const switches = [0, 1, 2, 3].map((outlet) => ({ switch: 'off', outlet }));
  assert.deepEqual(kinds(126, { switches, workMode: 1 }), ['onOff:channel1', 'onOff:channel2']);
  assert.deepEqual(kinds(126, { switches, workMode: 2 }), ['cover:cover']);
  assert.deepEqual(kinds(211, { switches, workMode: 2 }), ['cover:cover']);
  assert.deepEqual(kinds(211, { switches, workMode: 1 }), ['onOff:channel1', 'onOff:channel2', 'onOff:channel3']);
});

test('Zigbee button, leak and smoke sensors', () => {
  assert.deepEqual(kinds(1000, { key: 0, trigTime: '1' }), ['button:button']);
  assert.deepEqual(kinds(7019, { water: 0 }), ['leak:leak']);
  assert.deepEqual(kinds(5026, { smoke: 0 }), ['smoke:smoke']);
  const leak = device(4026, { water: 1, battery: 55 });
  const state = deviceState(leak, deviceFunctions(leak));
  assert.equal(state.leak, true);
  assert.equal(state.battery, 55);
  const smoke = device(5026, { smoke: 1 });
  assert.equal(deviceState(smoke, deviceFunctions(smoke)).smoke, true);
});

test('power monitoring is attached to the relays', () => {
  const pow = device(32, { switch: 'on', power: '100.5', voltage: '230', current: '0.44' });
  const functions = deviceFunctions(pow);
  assert.equal(functions.length, 1);
  assert.ok(functions[0].energy);
  assert.deepEqual(deviceState(pow, functions).power.switch, { power: 100.5, voltage: 230, current: 0.44 });
  const dualr3 = device(126, { switches: [{ outlet: 0, switch: 'on' }, { outlet: 1, switch: 'off' }], actPow_00: 1000, voltage_00: 23000, current_00: 4, workMode: 1 });
  assert.deepEqual(deviceState(dualr3, deviceFunctions(dualr3)).power.channel1, { power: 10, voltage: 230, current: 0.04 });
  assert.equal(deviceFunctions(device(1, { switch: 'on' }))[0].energy, undefined);
});

test('button presses need a new trigger time', () => {
  assert.equal(buttonPress({ key: 0, trigTime: '2' }, '1'), 'Single');
  assert.equal(buttonPress({ key: 1, trigTime: '3' }, '2'), 'Double');
  assert.equal(buttonPress({ key: 2, actionTime: '4' }, '3'), 'Long');
  // Replayed after a reconnect
  assert.equal(buttonPress({ key: 0, trigTime: '2' }, '2'), undefined);
  // Battery report without a press
  assert.equal(buttonPress({ battery: 90 }, '2'), undefined);
});

test('light state is read through the profile', () => {
  const d = device(44, { switch: 'on', brightness: 30 });
  assert.deepEqual(deviceState(d, deviceFunctions(d)).lights.light, { on: true, brightness: 30 });
});
