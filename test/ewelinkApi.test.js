import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { EWeLinkApi, EWeLinkApiError, EWeLinkNotLoggedInError, OAUTH_PAGE_URL } from '../dist/ewelinkApi.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const APP_ID = 'app-id';
const APP_SECRET = 'app-secret';
const REDIRECT = 'https://example.github.io/matterbridge-ewelink/';
const DAY = 24 * 60 * 60 * 1000;

const sign = (message) => crypto.createHmac('sha256', APP_SECRET).update(message).digest('base64');

// Minimal fake of the eWeLink v2 open API
const state = {};

function reset() {
  Object.assign(state, {
    requests: [],
    tokens: 0,
    validToken: null,
    validRefresh: null,
    rejectNextToken: false,
    things: [
      { itemType: 1, itemData: { deviceid: 'a1', name: 'Plug', online: true, extra: { uiid: 1 }, params: { switch: 'on', fwVersion: '3.5.0' } } },
      { itemType: 2, itemData: { deviceid: 'b2', name: 'Shared', online: false, extra: { uiid: 2 }, params: { switches: [] } } },
      { itemType: 3, itemData: { id: 'group', name: 'A group' } },
    ],
  });
}

function send(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function issue() {
  state.tokens++;
  state.validToken = `at-${state.tokens}`;
  state.validRefresh = `rt-${state.tokens}`;
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const body = raw ? JSON.parse(raw) : {};
    state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers });

    if (req.headers['x-ck-appid'] !== APP_ID) return send(res, { error: 407, msg: 'appid invalid' });
    const signed = req.headers.authorization === `Sign ${sign(raw)}`;

    if (url.pathname === '/v2/user/oauth/token') {
      if (!signed) return send(res, { error: 401, msg: 'bad sign' });
      if (body.code !== 'good-code' || body.redirectUrl !== REDIRECT || body.grantType !== 'authorization_code') return send(res, { error: 400, msg: 'bad code' });
      issue();
      return send(res, { error: 0, data: { accessToken: state.validToken, refreshToken: state.validRefresh, atExpiredTime: Date.now() + 30 * DAY, rtExpiredTime: Date.now() + 60 * DAY } });
    }

    if (url.pathname === '/v2/user/refresh') {
      if (!signed) return send(res, { error: 401, msg: 'bad sign' });
      if (body.rt !== state.validRefresh) return send(res, { error: 401, msg: 'refresh token invalid' });
      issue();
      return send(res, { error: 0, data: { at: state.validToken, rt: state.validRefresh } });
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
  const saved = [];
  const api = new EWeLinkApi({ baseUrl, appId: APP_ID, appSecret: APP_SECRET, redirectUrl: REDIRECT, onTokens: (t) => saved.push(t), ...overrides }, silentLog);
  return { api, saved };
}

async function loggedIn() {
  const result = createApi();
  await result.api.completeLogin('good-code', 'eu');
  return result;
}

test('builds a signed login URL', () => {
  const { api } = createApi();
  const url = new URL(api.loginUrl('my-state'));
  assert.equal(`${url.origin}${url.pathname}`, OAUTH_PAGE_URL);
  const p = url.searchParams;
  assert.equal(p.get('clientId'), APP_ID);
  assert.equal(p.get('redirectUrl'), REDIRECT);
  assert.equal(p.get('grantType'), 'authorization_code');
  assert.equal(p.get('state'), 'my-state');
  assert.match(p.get('nonce'), /^[0-9a-f]{8}$/);
  assert.equal(p.get('authorization'), sign(`${APP_ID}_${p.get('seq')}`));
});

test('is not logged in without tokens', async () => {
  const { api } = createApi();
  assert.equal(api.isLoggedIn, false);
  await assert.rejects(api.listDevices(), EWeLinkNotLoggedInError);
});

test('exchanges the authorization code for tokens and saves them', async () => {
  const { api, saved } = await loggedIn();
  assert.equal(api.isLoggedIn, true);
  assert.equal(api.region, 'eu');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].accessToken, 'at-1');
  assert.equal(saved[0].refreshToken, 'rt-1');
  assert.equal(saved[0].region, 'eu');
});

test('rejects a bad code and an unknown region', async () => {
  const { api } = createApi();
  await assert.rejects(api.completeLogin('bad-code', 'eu'), (error) => error instanceof EWeLinkApiError && error.errcode === 400);
  await assert.rejects(api.completeLogin('good-code', 'mars'), EWeLinkApiError);
  assert.equal(api.isLoggedIn, false);
});

test('restores saved tokens', async () => {
  const { saved } = await loggedIn();
  const { api } = createApi({ tokens: saved[0] });
  assert.equal(api.isLoggedIn, true);
  assert.equal((await api.listDevices()).length, 2);
});

test('ignores saved tokens whose refresh token has expired', () => {
  const tokens = { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 0, refreshTokenExpiresAt: Date.now() - 1, region: 'eu' };
  assert.equal(createApi({ tokens }).api.isLoggedIn, false);
});

test('lists own and shared devices but not groups', async () => {
  const { api } = await loggedIn();
  const devices = await api.listDevices();
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
  const { api } = await loggedIn();
  await api.setParams('a1', { switch: 'off' });
  const request = state.requests.find((r) => r.path === '/v2/device/thing/status');
  assert.deepEqual(request.body, { type: 1, id: 'a1', params: { switch: 'off' } });
});

test('renews the access token when eWeLink rejects it', async () => {
  const { api, saved } = await loggedIn();
  state.rejectNextToken = true;
  await api.setParams('a1', { switch: 'on' });
  assert.equal(state.tokens, 2);
  assert.equal(saved.at(-1).accessToken, 'at-2');
  assert.equal(saved.at(-1).refreshToken, 'rt-2');
});

test('renews an access token that is about to expire, once for concurrent calls', async () => {
  const { saved } = await loggedIn();
  const { api } = createApi({ tokens: { ...saved[0], accessTokenExpiresAt: Date.now() + DAY } });
  await Promise.all([api.listDevices(), api.listDevices(), api.setParams('a1', { switch: 'on' })]);
  assert.equal(state.tokens, 2);
  assert.equal(state.requests.filter((r) => r.path === '/v2/user/refresh').length, 1);
});

test('logs out when the refresh token is refused', async () => {
  const { api, saved } = await loggedIn();
  state.validToken = 'something-else';
  state.validRefresh = 'something-else';
  await assert.rejects(api.listDevices(), EWeLinkNotLoggedInError);
  assert.equal(api.isLoggedIn, false);
  assert.equal(saved.at(-1), undefined);
});

test('surfaces device command errors', async () => {
  const { api } = await loggedIn();
  await assert.rejects(api.setParams('offline', { switch: 'on' }), (error) => error instanceof EWeLinkApiError && error.errcode === 4002);
});

test('keeps the login on network failures', async () => {
  const tokens = { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 0, refreshTokenExpiresAt: Date.now() + DAY, region: 'eu' };
  const { api } = createApi({ baseUrl: 'http://127.0.0.1:1', tokens, timeoutMs: 2000 });
  await assert.rejects(api.listDevices(), (error) => error instanceof EWeLinkApiError && error.errcode === undefined);
  assert.equal(api.isLoggedIn, true);
});
