import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { EWeLinkApi, EWeLinkApiError, normalizeCountryCode, regionForCountryCode } from '../dist/ewelinkApi.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const APP_SECRET = 'app-secret';

// Minimal fake of the eWeLink v2 open API
const state = { requests: [], tokens: 0, validToken: null, rejectNextToken: false, things: [], wrongRegion: false };

function reset() {
  state.requests = [];
  state.tokens = 0;
  state.validToken = null;
  state.rejectNextToken = false;
  state.wrongRegion = false;
  state.things = [
    { itemType: 1, itemData: { deviceid: 'a1', name: 'Plug', online: true, extra: { uiid: 1 }, params: { switch: 'on', fwVersion: '3.5.0' } } },
    { itemType: 2, itemData: { deviceid: 'b2', name: 'Shared', online: false, extra: { uiid: 2 }, params: { switches: [] } } },
    { itemType: 3, itemData: { id: 'group', name: 'A group' } },
  ];
}

function send(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function newToken() {
  state.tokens++;
  state.validToken = `at-${state.tokens}`;
  return { at: state.validToken, rt: `rt-${state.tokens}`, region: 'eu' };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const body = raw ? JSON.parse(raw) : {};
    state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers });

    if (req.headers['x-ck-appid'] !== 'app-id') return send(res, { error: 407, msg: 'appid invalid' });

    if (url.pathname === '/v2/user/login') {
      const sign = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('base64');
      if (req.headers.authorization !== `Sign ${sign}`) return send(res, { error: 401, msg: 'bad sign' });
      if (state.wrongRegion) return send(res, { error: 10004, msg: 'region does not match', data: { region: 'us' } });
      if (body.email !== 'me@example.com' || body.password !== 'secret') return send(res, { error: 10001, msg: 'wrong account or password' });
      return send(res, { error: 0, data: newToken() });
    }

    if (url.pathname === '/v2/user/refresh') {
      if (body.rt !== `rt-${state.tokens}`) return send(res, { error: 401, msg: 'bad refresh token' });
      return send(res, { error: 0, data: newToken() });
    }

    if (state.rejectNextToken || req.headers.authorization !== `Bearer ${state.validToken}`) {
      state.rejectNextToken = false;
      return send(res, { error: 401, msg: 'token invalid' });
    }

    if (url.pathname === '/v2/device/thing' && req.method === 'GET') {
      return send(res, { error: 0, data: { thingList: state.things, total: state.things.length } });
    }
    if (url.pathname === '/v2/device/thing/status' && req.method === 'POST') {
      return body.id === 'offline' ? send(res, { error: 4002, msg: 'device offline' }) : send(res, { error: 0, data: {} });
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(reset);

function createApi(overrides = {}) {
  return new EWeLinkApi({ baseUrl, appId: 'app-id', appSecret: APP_SECRET, email: 'me@example.com', password: 'secret', countryCode: '+20', ...overrides }, silentLog);
}

test('logs in with a signed request', async () => {
  const api = createApi();
  await api.ensureAuthenticated();
  assert.equal(api.isAuthenticated, true);
  const login = state.requests.find((r) => r.path === '/v2/user/login');
  assert.equal(login.body.countryCode, '+20');
  assert.equal(login.body.email, 'me@example.com');
  assert.match(login.headers['x-ck-nonce'], /^[0-9a-f]{8}$/);
});

test('reports bad credentials', async () => {
  await assert.rejects(createApi({ password: 'wrong' }).ensureAuthenticated(), (error) => error instanceof EWeLinkApiError && error.errcode === 10001);
});

test('reports a wrong region when the base URL is fixed', async () => {
  state.wrongRegion = true;
  await assert.rejects(createApi().ensureAuthenticated(), (error) => error instanceof EWeLinkApiError && error.errcode === 10004);
});

test('shares a single login between concurrent calls', async () => {
  const api = createApi();
  await Promise.all([api.listDevices(), api.setParams('a1', { switch: 'off' }), api.listDevices()]);
  assert.equal(state.tokens, 1);
});

test('lists own and shared devices but not groups', async () => {
  const devices = await createApi().listDevices();
  assert.deepEqual(
    devices.map((d) => [d.deviceid, d.name, d.uiid, d.online]),
    [
      ['a1', 'Plug', 1, true],
      ['b2', 'Shared', 2, false],
    ],
  );
  assert.equal(devices[0].fwVersion, '3.5.0');
  assert.equal(state.requests.find((r) => r.path === '/v2/device/thing').query.get('num'), '0');
});

test('sends device params', async () => {
  await createApi().setParams('a1', { switch: 'off' });
  const request = state.requests.find((r) => r.path === '/v2/device/thing/status');
  assert.deepEqual(request.body, { type: 1, id: 'a1', params: { switch: 'off' } });
});

test('refreshes the token when it is rejected', async () => {
  const api = createApi();
  await api.ensureAuthenticated();
  state.rejectNextToken = true;
  await api.setParams('a1', { switch: 'on' });
  assert.equal(state.tokens, 2);
  assert.equal(state.requests.filter((r) => r.path === '/v2/user/refresh').length, 1);
  assert.equal(state.requests.filter((r) => r.path === '/v2/user/login').length, 1);
});

test('surfaces device command errors', async () => {
  await assert.rejects(createApi().setParams('offline', { switch: 'on' }), (error) => error instanceof EWeLinkApiError && error.errcode === 4002);
});

test('wraps network failures', async () => {
  const api = new EWeLinkApi({ baseUrl: 'http://127.0.0.1:1', appId: 'a', appSecret: 's', email: 'e', password: 'p', countryCode: '1', timeoutMs: 2000 }, silentLog);
  await assert.rejects(api.ensureAuthenticated(), EWeLinkApiError);
});

test('normalizes country codes and guesses the region', () => {
  assert.equal(normalizeCountryCode('44'), '+44');
  assert.equal(normalizeCountryCode(' +971 '), '+971');
  assert.equal(regionForCountryCode('+1'), 'us');
  assert.equal(regionForCountryCode('+44'), 'eu');
  assert.equal(regionForCountryCode('+20'), 'eu');
  assert.equal(regionForCountryCode('+86'), 'cn');
  assert.equal(regionForCountryCode('+971'), 'as');
});
