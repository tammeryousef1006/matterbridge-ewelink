import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { LoginServer } from '../dist/loginServer.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

let server;
let base;
let api;
let logins;

beforeEach(async () => {
  logins = 0;
  api = {
    isLoggedIn: false,
    region: undefined,
    completed: [],
    loginUrl: (state) => `https://login.example/?state=${encodeURIComponent(state)}`,
    async completeLogin(code, region) {
      if (code === 'bad') throw new Error('eWeLink error 400: bad code');
      this.completed.push([code, region]);
      this.isLoggedIn = true;
      this.region = region;
    },
  };
  server = new LoginServer({ port: 0, host: '127.0.0.1', api, log: silentLog, onLogin: () => logins++ });
  base = `http://127.0.0.1:${await server.start()}`;
});

afterEach(() => server.stop());

/** Start a login and return the state eWeLink would echo back. */
async function startLogin() {
  const res = await fetch(`${base}/login`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')).searchParams.get('state');
}

test('shows a login button when not logged in', async () => {
  const html = await (await fetch(base)).text();
  assert.match(html, /Log in with eWeLink/);
});

test('state carries the address of the login page', async () => {
  const state = await startLogin();
  const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
  assert.equal(decoded.r, base);
  assert.match(decoded.n, /^[0-9a-f]{32}$/);
});

test('completes the login from the callback', async () => {
  const state = await startLogin();
  const res = await fetch(`${base}/callback?code=good&region=us&state=${state}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /logged in/);
  assert.deepEqual(api.completed, [['good', 'us']]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logins, 1);
  assert.match(await (await fetch(base)).text(), /Logged in to eWeLink \(region us\)/);
});

test('a state can only be used once', async () => {
  const state = await startLogin();
  await fetch(`${base}/callback?code=good&region=eu&state=${state}`);
  const res = await fetch(`${base}/callback?code=good&region=eu&state=${state}`);
  assert.equal(res.status, 400);
  assert.equal(api.completed.length, 1);
});

test('rejects callbacks with an unknown state', async () => {
  const forged = Buffer.from(JSON.stringify({ r: base, n: 'f'.repeat(32) })).toString('base64url');
  for (const query of [`code=good&region=eu&state=${forged}`, 'code=good&region=eu&state=garbage', 'code=good&region=eu']) {
    const res = await fetch(`${base}/callback?${query}`);
    assert.equal(res.status, 400);
  }
  assert.equal(api.completed.length, 0);
});

test('shows eWeLink errors, escaped', async () => {
  api.completeLogin = async () => {
    throw new Error('<script>x</script>');
  };
  const state = await startLogin();
  const res = await fetch(`${base}/callback?code=x&region=eu&state=${state}`);
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(logins, 0);
});
