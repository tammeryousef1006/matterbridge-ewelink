// Builds the platform against a stand-in Matterbridge host to check that every supported device type
// creates valid Matter endpoints and that Matter commands become the right eWeLink commands.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { EWeLinkPlatform } from '../dist/platform.js';

let platform;
const endpoints = {};
const sent = [];

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matterbridge-ewelink-'));
  process.env.EWELINK_APP_ID = 'app-id';
  process.env.EWELINK_APP_SECRET = 'app-secret';
  const log = new AnsiLogger({ logName: 'test', logLevel: LogLevel.ERROR });
  const host = { matterbridgeDirectory: dir, matterbridgePluginDirectory: dir, matterbridgeVersion: '3.10.12' };
  platform = new EWeLinkPlatform(host, log, { name: 'matterbridge-ewelink', type: 'DynamicPlatform', version: '1.1.0' });
  platform.registerDevice = async (endpoint) => {
    endpoints[endpoint.id] = endpoint;
  };
  platform.api.setParams = async (id, params) => {
    sent.push([id, params]);
  };
  await platform.ready;
});

after(async () => {
  await platform.onShutdown('test');
});

const device = (deviceid, uiid, params, name = deviceid) => ({ deviceid, name, online: true, uiid, params });
const servers = (id) => endpoints[id].getAllClusterServerNames();

async function command(id, name, request = {}, attributes = {}) {
  sent.length = 0;
  await endpoints[id].executeCommandHandler(name, request, undefined, attributes, endpoints[id]);
  return sent.map(([, params]) => params);
}

test('creates Matter devices for every supported type', async () => {
  const devices = [
    device('plug', 1, { switch: 'on' }),
    device('pow', 32, { switch: 'on', power: '10', voltage: '230', current: '0.1' }),
    device('dualr3', 126, { switches: [{ outlet: 0, switch: 'on' }, { outlet: 1, switch: 'off' }], workMode: 1, actPow_00: 100 }),
    device('d1', 44, { switch: 'off', brightness: 50 }),
    device('b02', 103, { switch: 'on', ltype: 'white', white: { br: 50, ct: 100 } }),
    device('b05', 104, { switch: 'on', ltype: 'color', color: { br: 80, r: 255, g: 0, b: 0 } }),
    device('zbrgb', 3258, { switch: 'on', colorMode: 'cct', colorTemp: 50, cctBrightness: 60 }),
    device('curtain', 258, { switch: 'pause', setclose: 40 }),
    device('ifan', 34, { switches: [{ outlet: 0, switch: 'on' }, { outlet: 1, switch: 'on' }, { outlet: 2, switch: 'off' }, { outlet: 3, switch: 'off' }] }, 'Fan'),
    device('trv', 7017, { workMode: '0', temperature: '205', curTargetTemp: '220', battery: 90 }),
    device('button', 1000, { key: 0, trigTime: '1', battery: 80 }),
    device('leak', 4026, { water: 0, battery: 70 }),
    device('smoke', 5026, { smoke: 0, battery: 60 }),
  ];
  for (const d of devices) await platform.addDevice(d);

  assert.ok(servers('ewelink-plug').includes('onOff'));
  assert.ok(servers('ewelink-pow').includes('electricalPowerMeasurement'));
  assert.ok(servers('ewelink-d1').includes('levelControl'));
  assert.ok(!servers('ewelink-d1').includes('colorControl'));
  assert.ok(servers('ewelink-b02').includes('colorControl'));
  assert.ok(servers('ewelink-b05').includes('colorControl'));
  assert.ok(servers('ewelink-curtain').includes('windowCovering'));
  assert.ok(servers('ewelink-ifan').includes('fanControl'));
  // The iFan light is a device of its own
  assert.ok(servers('ewelink-ifan-light').includes('onOff'));
  assert.equal(endpoints['ewelink-ifan-light'].deviceName, 'Fan Light');
  assert.equal(endpoints['ewelink-ifan'].deviceName, 'Fan');
  assert.ok(servers('ewelink-trv').includes('thermostat'));
  assert.ok(servers('ewelink-button').includes('switch'));
  assert.ok(servers('ewelink-leak').includes('booleanState'));
  assert.ok(servers('ewelink-smoke').includes('smokeCoAlarm'));
  assert.equal(endpoints['ewelink-dualr3'].getChildEndpoints().length, 2);
});

test('light commands', async () => {
  assert.deepEqual(await command('ewelink-d1', 'moveToLevelWithOnOff', { level: 127 }), [{ switch: 'on', brightness: 50, mode: 0 }]);
  assert.deepEqual(await command('ewelink-d1', 'moveToLevelWithOnOff', { level: 0 }), [{ switch: 'off' }]);
  assert.deepEqual(await command('ewelink-b05', 'moveToHueAndSaturation', { hue: 85, saturation: 254 }), [
    { switch: 'on', ltype: 'color', color: { br: 80, r: 0, g: 255, b: 2 } },
  ]);
  assert.deepEqual(await command('ewelink-b05', 'moveToColorTemperature', { colorTemperatureMireds: 500 }), [{ switch: 'on', ltype: 'white', white: { br: 80, ct: 0 } }]);
  assert.deepEqual(await command('ewelink-b02', 'moveToColorTemperature', { colorTemperatureMireds: 154 }), [{ switch: 'on', ltype: 'white', white: { br: 50, ct: 255 } }]);
  assert.deepEqual(await command('ewelink-zbrgb', 'moveToHue', { hue: 169 }, { currentHue: 0, currentSaturation: 254 }), [
    { colorMode: 'rgb', switch: 'on', rgbBrightness: 60, hue: 240, saturation: 100 },
  ]);
});

test('curtain commands', async () => {
  assert.deepEqual(await command('ewelink-curtain', 'goToLiftPercentage', { liftPercent100thsValue: 2500 }), [{ setclose: 25 }]);
  assert.deepEqual(await command('ewelink-curtain', 'upOrOpen'), [{ switch: 'on' }]);
  assert.deepEqual(await command('ewelink-curtain', 'stopMotion'), [{ switch: 'pause' }]);
});

test('switch, iFan light and power plug commands', async () => {
  assert.deepEqual(await command('ewelink-ifan-light', 'off'), [{ switches: [{ switch: 'off', outlet: 0 }] }]);
  assert.deepEqual(await command('ewelink-pow', 'off'), [{ switch: 'off' }]);
});

test('offline devices refuse commands', async () => {
  platform.devices.get('plug').device.online = false;
  await assert.rejects(command('ewelink-plug', 'on'), /offline/);
  platform.devices.get('plug').device.online = true;
});

test('live updates are merged into the device state', async () => {
  await platform.handleUpdate('b05', { ltype: 'white', white: { br: 10, ct: 255 } });
  assert.deepEqual(platform.devices.get('b05').device.params.white, { br: 10, ct: 255 });
  await platform.handleUpdate('unknown', { switch: 'on' });
});
