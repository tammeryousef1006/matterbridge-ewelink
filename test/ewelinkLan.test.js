import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { EWeLinkLan, decryptParams, encryptParams, lanCommand, parseMdns } from '../dist/ewelinkLan.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, notice() {} };
const KEY = '9a1c3e5f-1234-5678-9abc-def012345678';

/** One DNS name in wire format. */
function name(text) {
  return Buffer.concat([...text.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
}
function record(owner, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}
function txt(entries) {
  return Buffer.concat(Object.entries(entries).map(([k, v]) => {
    const text = Buffer.from(`${k}=${v}`);
    return Buffer.concat([Buffer.from([text.length]), text]);
  }));
}
/** An announcement like a Sonoff in LAN mode sends (PTR, SRV, TXT, A). */
function announcement(deviceId, params, { seq = '1', port = 8081, ip = [127, 0, 0, 1], key = KEY } = {}) {
  const instance = `eWeLink_${deviceId}._ewelink._tcp.local`;
  const host = `eWeLink_${deviceId}.local`;
  const { iv, data } = encryptParams(params, key);
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 0xff]), name(host)]);
  const records = [
    record('_ewelink._tcp.local', 12, name(instance)),
    record(instance, 33, srv),
    record(instance, 16, txt({ txtvers: '1', id: deviceId, type: 'plug', apivers: '1', seq, encrypt: 'true', iv, data1: data })),
    record(host, 1, Buffer.from(ip)),
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}

test('params survive encryption with the device key', () => {
  const { iv, data } = encryptParams({ switch: 'on', startup: 'stay' }, KEY);
  assert.deepEqual(decryptParams(data, iv, KEY), { switch: 'on', startup: 'stay' });
  assert.throws(() => decryptParams(data, iv, 'another-key-000000000000000000000'));
});

test('the command endpoint follows the params', () => {
  assert.equal(lanCommand({ switch: 'on' }), 'switch');
  assert.equal(lanCommand({ switches: [{ switch: 'on', outlet: 1 }] }), 'switches');
  assert.equal(lanCommand({ light: 'on' }), 'light');
  assert.equal(lanCommand({ switch: 'on', brightness: 50, mode: 0 }, 44), 'dimmable');
});

test('an announcement gives the address and the state', () => {
  const records = parseMdns(announcement('1000abcdef', { switch: 'on' }));
  assert.equal(records.length, 4);
  const updates = [];
  const seen = [];
  const lan = new EWeLinkLan({ log: silentLog, keyFor: () => KEY, onUpdate: (id, p) => updates.push([id, p]), onSeen: (id, s) => seen.push([id, s]) });
  lan.onMessage(announcement('1000abcdef', { switch: 'on' }, { ip: [192, 168, 1, 50] }), '192.168.1.50');
  assert.deepEqual(updates, [['1000abcdef', { switch: 'on' }]]);
  assert.deepEqual(seen, [['1000abcdef', true]]);
  assert.equal(lan.isLocal('1000abcdef'), true);
  assert.equal(lan.seen('1000abcdef').host, '192.168.1.50');
  // the same seq again is not a new state; a new seq is
  lan.onMessage(announcement('1000abcdef', { switch: 'on' }), '192.168.1.50');
  lan.onMessage(announcement('1000abcdef', { switch: 'off' }, { seq: '2' }), '192.168.1.50');
  assert.deepEqual(updates.map(([, p]) => p.switch), ['on', 'off']);
});

test('without the key a device is seen but not local', () => {
  const lan = new EWeLinkLan({ log: silentLog, keyFor: () => undefined, onUpdate: () => assert.fail('no state without the key') });
  lan.onMessage(announcement('1000000002', { switch: 'on' }), '127.0.0.1');
  assert.ok(lan.seen('1000000002'));
  assert.equal(lan.isLocal('1000000002'), false);
});

test('a command goes to the device encrypted, on its own address', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body);
      received.push({ path: req.url, json, params: decryptParams(json.data, json.iv, KEY) });
      res.end(JSON.stringify({ seq: 2, error: received.length === 1 ? 0 : 400 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const lan = new EWeLinkLan({ log: silentLog, keyFor: () => KEY, onUpdate: () => {} });
  lan.onMessage(announcement('1000000003', { switch: 'off' }, { port }), '127.0.0.1');
  await lan.send('1000000003', { switch: 'on' });
  assert.equal(received[0].path, '/zeroconf/switch');
  assert.equal(received[0].json.deviceid, '1000000003');
  assert.equal(received[0].json.encrypt, true);
  assert.deepEqual(received[0].params, { switch: 'on' });
  // a refused command is an error (the plugin then tries the cloud)
  await assert.rejects(lan.send('1000000003', { switch: 'off' }), /error 400/);
  server.close();
});
