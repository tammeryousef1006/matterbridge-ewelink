import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { EWeLinkSocket } from '../dist/ewelinkSocket.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await wait(10);
  }
}

let server;
let socket;
afterEach(async () => {
  socket?.stop();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  server = undefined;
});

/** Fake eWeLink WebSocket server: answers userOnline like the official API. */
async function startServer({ error = 0, hbInterval = 145 } = {}) {
  const received = [];
  const clients = [];
  server = new WebSocketServer({ port: 0 });
  server.on('connection', (ws) => {
    clients.push(ws);
    ws.on('message', (data) => {
      const text = data.toString();
      received.push(text);
      if (text === 'ping') return ws.send('pong');
      const message = JSON.parse(text);
      if (message.action === 'userOnline') {
        ws.send(JSON.stringify(error ? { error, reason: 'Authentication Failed', sequence: message.sequence } : { error: 0, apikey: message.apikey, config: { hb: 1, hbInterval }, sequence: message.sequence }));
      }
    });
  });
  await new Promise((resolve) => server.on('listening', resolve));
  return { port: server.address().port, received, clients };
}

function createSocket(port, overrides = {}) {
  const events = { updates: [], online: [], connected: [], auths: 0 };
  socket = new EWeLinkSocket({
    auth: async () => {
      events.auths++;
      return { at: 'token', apikey: 'user-key', appid: 'app-id', domain: '127.0.0.1', port };
    },
    log: silentLog,
    url: (domain, p) => `ws://${domain}:${p}`,
    onUpdate: (id, params) => events.updates.push([id, params]),
    onOnline: (id, online) => events.online.push([id, online]),
    onConnected: (connected) => events.connected.push(connected),
    retryDelays: [50],
    ...overrides,
  });
  return events;
}

test('logs in with userOnline as in the official protocol', async () => {
  const { port, received } = await startServer();
  const events = createSocket(port);
  socket.start();
  await until(() => socket.isConnected);
  const handshake = JSON.parse(received[0]);
  assert.equal(handshake.action, 'userOnline');
  assert.equal(handshake.at, 'token');
  assert.equal(handshake.apikey, 'user-key');
  assert.equal(handshake.appid, 'app-id');
  assert.equal(handshake.userAgent, 'app');
  assert.equal(handshake.version, 8);
  assert.match(handshake.nonce, /^[0-9a-f]{8}$/);
  assert.deepEqual(events.connected, [true]);
});

test('passes device updates and online changes on', async () => {
  const { port, clients } = await startServer();
  const events = createSocket(port);
  socket.start();
  await until(() => socket.isConnected);
  clients[0].send(JSON.stringify({ action: 'update', deviceid: 'd1', apikey: 'x', userAgent: 'device', params: { switch: 'on' } }));
  clients[0].send(JSON.stringify({ action: 'sysmsg', deviceid: 'd2', params: { online: false } }));
  clients[0].send('pong');
  clients[0].send('not json');
  await until(() => events.updates.length === 1 && events.online.length === 1);
  assert.deepEqual(events.updates, [['d1', { switch: 'on' }]]);
  assert.deepEqual(events.online, [['d2', false]]);
});

test('sends heartbeats at the interval the server asks for', async () => {
  const { port, received } = await startServer({ hbInterval: 0.1 });
  createSocket(port);
  socket.start();
  await until(() => received.filter((m) => m === 'ping').length >= 2);
});

test('reconnects after the connection drops', async () => {
  const { port, clients } = await startServer();
  const events = createSocket(port);
  socket.start();
  await until(() => socket.isConnected);
  clients[0].terminate();
  await until(() => events.connected.length === 3, 5000);
  assert.deepEqual(events.connected, [true, false, true]);
  assert.equal(events.auths, 2);
});

test('a refused login is retried, not treated as connected', async () => {
  const { port, received } = await startServer({ error: 406 });
  const events = createSocket(port);
  socket.start();
  await until(() => received.length >= 2);
  assert.equal(socket.isConnected, false);
  assert.deepEqual(events.connected, []);
});

test('keeps retrying when credentials are not available', async () => {
  let calls = 0;
  socket = new EWeLinkSocket({
    auth: async () => {
      calls++;
      throw new Error('Not logged in to eWeLink.');
    },
    log: silentLog,
    onUpdate() {},
    onOnline() {},
    retryDelays: [20],
  });
  socket.start();
  await until(() => calls >= 3);
});
