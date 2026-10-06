import * as crypto from 'crypto';
import * as http from 'http';

import { EWeLinkLogger, errorMessage } from './ewelinkApi.js';

/** The part of EWeLinkApi the login page needs. */
export interface LoginApi {
  readonly isLoggedIn: boolean;
  readonly region: string | undefined;
  loginUrl(state: string): string;
  completeLogin(code: string, region: string): Promise<void>;
}

export interface LoginServerOptions {
  port: number;
  /** Bind address; all interfaces by default so phones on the network can reach it. */
  host?: string;
  api: LoginApi;
  log: EWeLinkLogger;
  /** Called after a successful login, e.g. to discover devices. */
  onLogin?: () => Promise<void> | void;
}

/** A login attempt is valid for this long (time to type the password on eWeLink's page). */
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Small web page on the Matterbridge host that starts the eWeLink OAuth login and receives its result.
 *
 * eWeLink only redirects to the app's registered redirect URL (a static page on GitHub Pages). That page
 * forwards the browser to the address carried in `state`, which is this server's /callback.
 */
export class LoginServer {
  private server: http.Server | undefined;
  private readonly pending = new Map<string, number>();

  constructor(private readonly options: LoginServerOptions) {}

  async start(): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.options.log.error(`eWeLink login page error: ${errorMessage(error)}`);
        if (!res.headersSent) send(res, 500, page('Error', `<p>${escapeHtml(errorMessage(error))}</p>`));
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') return send(res, 405, page('Not allowed', ''));

    switch (url.pathname) {
      case '/':
        return send(res, 200, this.statusPage());
      case '/login': {
        const host = req.headers.host;
        if (!host || !/^[\w.\-:[\]]+$/.test(host)) return send(res, 400, page('Bad request', '<p>Missing or invalid Host header.</p>'));
        res.writeHead(302, { Location: this.options.api.loginUrl(this.newState(`http://${host}`)), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      case '/callback':
        return this.callback(url, res);
      default:
        return send(res, 404, page('Not found', '<p><a href="/">Back</a></p>'));
    }
  }

  private async callback(url: URL, res: http.ServerResponse): Promise<void> {
    const code = url.searchParams.get('code');
    const region = url.searchParams.get('region');
    const state = url.searchParams.get('state');
    if (!code || !region || !state || !this.consumeState(state)) {
      return send(res, 400, page('Login failed', '<p>This login link is invalid or has expired.</p><p><a href="/">Try again</a></p>'));
    }
    try {
      await this.options.api.completeLogin(code, region);
    } catch (error) {
      this.options.log.error(`eWeLink login failed: ${errorMessage(error)}`);
      return send(res, 502, page('Login failed', `<p>${escapeHtml(errorMessage(error))}</p><p><a href="/">Try again</a></p>`));
    }
    send(res, 200, page('Logged in', '<p>&#9989; You are logged in to eWeLink. Your devices are being added to Matterbridge.</p><p>You can close this page.</p>'));
    try {
      await this.options.onLogin?.();
    } catch (error) {
      this.options.log.error(`Failed to load eWeLink devices after login: ${errorMessage(error)}`);
    }
  }

  private statusPage(): string {
    const { api } = this.options;
    if (api.isLoggedIn) {
      return page(
        'eWeLink',
        `<p>&#9989; Logged in to eWeLink (region ${escapeHtml(api.region ?? '?')}).</p>
<p>Use another account or fix a broken login:</p><p><a class="button" href="/login">Log in again</a></p>`,
      );
    }
    return page(
      'eWeLink',
      `<p>Log in with the email and password you use in the eWeLink app. Your password is entered on eWeLink's own page and never stored by Matterbridge.</p>
<p><a class="button" href="/login">Log in with eWeLink</a></p>
<p class="hint">This device must be on the same network as Matterbridge.</p>`,
    );
  }

  /** state = base64url JSON with the address to return to and a one-time id. */
  private newState(returnTo: string): string {
    const now = Date.now();
    for (const [id, expires] of this.pending) if (expires < now) this.pending.delete(id);
    const id = crypto.randomBytes(16).toString('hex');
    this.pending.set(id, now + STATE_TTL_MS);
    return Buffer.from(JSON.stringify({ r: returnTo, n: id })).toString('base64url');
  }

  private consumeState(state: string): boolean {
    let id: unknown;
    try {
      id = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))?.n;
    } catch {
      return false;
    }
    if (typeof id !== 'string') return false;
    const expires = this.pending.get(id);
    this.pending.delete(id);
    return expires !== undefined && expires >= Date.now();
  }
}

function send(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Matterbridge eWeLink</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1c1c1e;background:#fff}
h1{font-size:1.4rem}.button{display:inline-block;padding:.7rem 1.4rem;border-radius:.5rem;background:#0a6cff;color:#fff;text-decoration:none;font-weight:600}
.hint{color:#666;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.hint{color:#aaa}}
</style></head>
<body><h1>Matterbridge eWeLink</h1>${body}</body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
