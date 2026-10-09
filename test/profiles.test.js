import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conv,
  coverProfile,
  energyProfile,
  fanProfile,
  hsToRgb,
  kelvinToMireds,
  lightProfile,
  miredsToKelvin,
  percentToSpeed,
  rgbToHs,
  speedToPercent,
  thermostatProfile,
  xyToHs,
} from '../dist/profiles.js';

test('conv maps and clamps ranges', () => {
  assert.equal(conv(50, 0, 100, 0, 255), 128);
  assert.equal(conv(150, 0, 100, 0, 255), 255);
  assert.equal(conv(-5, 0, 100, 10, 100), 10);
});

test('D1 dimmer (UIID 44)', () => {
  const d1 = lightProfile(44);
  assert.deepEqual(d1.read({ switch: 'on', brightness: 0 }), { on: true, brightness: 1 });
  assert.deepEqual(d1.write({ brightness: 50 }, { on: false }), [{ switch: 'on', brightness: 50, mode: 0 }]);
  assert.deepEqual(d1.write({ on: false }, { on: true }), [{ switch: 'off' }]);
});

test('KING-M4 dimmer (UIID 36) turns on before dimming', () => {
  const dimmer = lightProfile(36);
  assert.equal(dimmer.read({ switch: 'off', bright: 10 }).brightness, 1);
  assert.deepEqual(dimmer.write({ brightness: 100 }, { on: false }), [{ switch: 'on' }, { bright: 100 }]);
  assert.deepEqual(dimmer.write({ brightness: 100 }, { on: true }), [{ bright: 100 }]);
});

test('single colour bulb (UIID 57) uses string channel0', () => {
  const bulb = lightProfile(57);
  assert.deepEqual(bulb.read({ state: 'on', channel0: '255' }), { on: true, brightness: 100 });
  assert.deepEqual(bulb.write({ brightness: 1 }, { on: true }), [{ channel0: '25' }]);
});

test('B02 white bulb (UIID 103) sends brightness and colour temperature together', () => {
  const b02 = lightProfile(103);
  assert.equal(b02.color, false);
  const state = b02.read({ switch: 'on', ltype: 'white', white: { br: 30, ct: 0 } });
  assert.deepEqual(state, { on: true, brightness: 30, kelvin: 2200, mode: 'white' });
  assert.deepEqual(b02.write({ brightness: 60 }, state), [{ switch: 'on', ltype: 'white', white: { br: 60, ct: 0 } }]);
  assert.deepEqual(b02.write({ kelvin: 6500 }, state), [{ switch: 'on', ltype: 'white', white: { br: 30, ct: 255 } }]);
});

test('B05 colour bulb (UIID 104) switches between white and colour', () => {
  const b05 = lightProfile(104);
  const color = b05.read({ switch: 'on', ltype: 'color', color: { br: 80, r: 255, g: 0, b: 0 } });
  assert.deepEqual(color, { on: true, brightness: 80, color: { h: 0, s: 100 }, mode: 'color' });
  // Brightness keeps the colour mode
  assert.deepEqual(b05.write({ brightness: 40 }, color), [{ switch: 'on', ltype: 'color', color: { br: 40, r: 255, g: 0, b: 0 } }]);
  assert.deepEqual(b05.write({ kelvin: 2000 }, color), [{ switch: 'on', ltype: 'white', white: { br: 80, ct: 0 } }]);
  // B05-BL (136) uses colour temperature 0-100
  assert.equal(lightProfile(136).read({ ltype: 'white', white: { br: 50, ct: 100 } }).kelvin, 6500);
});

test('L1 strip (UIID 59)', () => {
  const l1 = lightProfile(59);
  assert.deepEqual(l1.read({ switch: 'on', bright: 40, colorR: 0, colorG: 0, colorB: 255 }), { on: true, mode: 'color', brightness: 40, color: { h: 240, s: 100 } });
  assert.deepEqual(l1.write({ color: { h: 120, s: 100 } }, { on: false }), [{ switch: 'on' }, { mode: 1, colorR: 0, colorG: 255, colorB: 0, light_type: 1 }]);
});

test('Zigbee lights (UIID 1257, 1258, 3258)', () => {
  assert.deepEqual(lightProfile(1257).write({ brightness: 70 }, { on: true }), [{ switch: 'on', brightness: 70 }]);
  const cct = lightProfile(1258);
  assert.equal(cct.read({ switch: 'on', brightness: 100, colorTemp: 100 }).kelvin, 4000);
  assert.deepEqual(cct.write({ kelvin: 2200, brightness: 10 }, {}), [{ switch: 'on', brightness: 10, colorTemp: 0 }]);
  const rgbcw = lightProfile(3258);
  const white = rgbcw.read({ switch: 'on', colorMode: 'cct', cctBrightness: 50, colorTemp: 100 });
  assert.deepEqual(white, { on: true, mode: 'white', brightness: 50, kelvin: 6500 });
  assert.deepEqual(rgbcw.write({ color: { h: 359.6, s: 80 } }, white), [{ colorMode: 'rgb', switch: 'on', rgbBrightness: 50, hue: 359, saturation: 80 }]);
  assert.deepEqual(rgbcw.write({ brightness: 20 }, white), [{ colorMode: 'cct', switch: 'on', cctBrightness: 20, colorTemp: 100 }]);
});

test('lights without a profile', () => {
  assert.equal(lightProfile(1), undefined);
});

test('curtains', () => {
  const setclose = coverProfile(258, {});
  assert.equal(setclose.read({ setclose: 30 }), 30);
  assert.deepEqual(setclose.action('stop'), { switch: 'pause' });
  assert.deepEqual(setclose.position(75), { setclose: 75 });

  const zigbee = coverProfile(7006, {});
  assert.deepEqual(zigbee.action('open'), { curtainAction: 'open' });
  assert.deepEqual(zigbee.position(10), { openPercent: 10 });

  // DualR3 is a curtain only in motor mode; it reports percent open
  assert.equal(coverProfile(126, { workMode: 1 }), undefined);
  const dualr3 = coverProfile(126, { workMode: 2 });
  assert.equal(dualr3.read({ currLocation: 100 }), 0);
  assert.deepEqual(dualr3.position(25), { location: 75 });
  assert.deepEqual(dualr3.action('close'), { motorTurn: 2 });

  const t5 = coverProfile(211, { workMode: 2 });
  assert.equal(t5.read({ percentageControl: 40, calibState: false }), undefined);
  assert.equal(t5.read({ percentageControl: 40, calibState: true }), 40);
  assert.deepEqual(t5.action('open'), { electromotor: 0 });
  assert.equal(coverProfile(211, { workMode: 1 }), undefined);
});

test('iFan speeds (UIID 34)', () => {
  const ifan = fanProfile(34);
  const relays = (r1, r2, r3) => ({ switches: [{ outlet: 0, switch: 'on' }, { outlet: 1, switch: r1 }, { outlet: 2, switch: r2 }, { outlet: 3, switch: r3 }] });
  assert.equal(ifan.read(relays('off', 'on', 'on')), 0);
  assert.equal(ifan.read(relays('on', 'off', 'off')), 1);
  assert.equal(ifan.read(relays('on', 'on', 'off')), 2);
  assert.equal(ifan.read(relays('on', 'off', 'on')), 3);
  assert.deepEqual(ifan.write(3), { switches: [{ outlet: 1, switch: 'on' }, { outlet: 2, switch: 'off' }, { outlet: 3, switch: 'on' }] });
  assert.deepEqual(ifan.write(0), { switches: [{ outlet: 1, switch: 'off' }] });
});

test('three speed fan (UIID 17)', () => {
  const fan = fanProfile(17);
  assert.equal(fan.read({ fan: 'on', speed: 'moderate' }), 2);
  assert.equal(fan.read({ fan: 'off', speed: 'fast' }), 0);
  assert.deepEqual(fan.write(1), { fan: 'on', speed: 'slow' });
  assert.deepEqual(fan.write(0), { fan: 'off' });
});

test('fan percent and speed', () => {
  assert.deepEqual([0, 1, 33, 34, 66, 67, 100].map(percentToSpeed), [0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual([0, 1, 2, 3].map(speedToPercent), [0, 33, 66, 100]);
  // Round trip keeps the speed
  for (const speed of [0, 1, 2, 3]) assert.equal(percentToSpeed(speedToPercent(speed)), speed);
});

test('TRVZB (UIID 7017)', () => {
  const trv = thermostatProfile(7017);
  assert.deepEqual(trv.read({ workMode: '0', temperature: '205', curTargetTemp: 220, workState: '1' }), { on: true, current: 20.5, target: 22, heating: true });
  assert.equal(trv.read({ workMode: '1' }).on, false);
  assert.deepEqual(trv.setTarget(21.5, { workMode: '0' }), { manTargetTemp: 215 });
  assert.deepEqual(trv.setTarget(19, { workMode: '2' }), { autoTargetTemp: 190 });
  // Setting a temperature while off switches to manual
  assert.deepEqual(trv.setTarget(20, { workMode: '1' }), { workMode: '0', manTargetTemp: 200 });
  assert.deepEqual(trv.power(false), { workMode: '1' });
});

test('Wi-Fi thermostat (UIID 127)', () => {
  const t = thermostatProfile(127);
  assert.deepEqual(t.read({ switch: 'on', targetTemp: 21, temperature: 19.5 }), { on: true, current: 19.5, target: 21, heating: undefined });
  assert.deepEqual(t.setTarget(21.3, {}), { targetTemp: 21.5 });
});

test('power monitoring', () => {
  assert.deepEqual(energyProfile(32).read({ power: '1800.01', voltage: '230.00', current: '7.83' }), { power: 1800.01, voltage: 230, current: 7.83 });
  assert.deepEqual(energyProfile(190).read({ power: 12345, voltage: 23010, current: 54 }), { power: 123.45, voltage: 230.1, current: 0.54 });
  assert.deepEqual(energyProfile(126).read({ actPow_01: 500, voltage_01: 23000, current_01: 2 }, 1), { power: 5, voltage: 230, current: 0.02 });
  assert.equal(energyProfile(1), undefined);
});

test('colour maths', () => {
  assert.deepEqual(hsToRgb({ h: 0, s: 100 }), [255, 0, 0]);
  assert.deepEqual(hsToRgb({ h: 120, s: 100 }), [0, 255, 0]);
  assert.deepEqual(hsToRgb({ h: 240, s: 0 }), [255, 255, 255]);
  assert.deepEqual(rgbToHs(0, 0, 255), { h: 240, s: 100 });
  assert.deepEqual(rgbToHs(255, 255, 255), { h: 0, s: 0 });
  const green = xyToHs(0.17, 0.7);
  assert.ok(green.h > 100 && green.h < 160, `green hue ${green.h}`);
  assert.equal(kelvinToMireds(2000), 500);
  assert.equal(miredsToKelvin(153), 6536);
});
