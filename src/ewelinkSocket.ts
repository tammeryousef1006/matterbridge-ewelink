import WebSocket from 'ws';

import { EWeLinkLogger, EWeLinkParams, EWeLinkSocketAuth, errorMessage, nonce } from './ewelinkApi.js';

export interface EWeLinkSocketOptions {
  /** Fresh credentials and server for each connection attempt. */
  auth: () => Promise<EWeLinkSocketAuth>;
  log: EWeLinkLogger;
  /** A device reported new params (only the ones that changed). */
  onUpdate: (deviceId: string, params: EWeLinkParams) => void;
  /** A device went online or offline. */
  onOnline: (deviceId: string, online: boolean) => void;
  /** Connection state changes, e.g. to slow down polling while connected. */
  onConnected?: (connected: boolean) => void;
  /** Server URL for a dispatch answer; tests use plain ws://. */
  url?: (domain: string, port: number) => string;
  /** Reconnect delays in ms; eWeLink blocks clients that log in to the WebSocket too often. */
  retryDelays?: number[];
}

const DEFAULT_RETRY_DELAYS = [10_000, 30_000, 60_000, 120_000, 300_000];
/** A connection that lasted this long resets the retry backoff. */
const STABLE_CONNECTION_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_S = 90;
/** eWeLink answers 406 when the same account and app logged in somewhere else. */
const OTHER_SESSION_ERROR = 406;

/**
 * eWeLink live updates (official API center v2, "Real Time Control Device"): get a server from the
 * dispatch service, open wss://domain:port/api/ws, send userOnline, then receive "update" and "sysmsg"
 * messages for every device of the account. Keeps reconnecting with a backoff until stopped.
 */
export class EWeLinkSocket {
  private ws: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private connectedAt = 0;
  private stopped = true;
  private connected = false;

  constructor(private readonly options: EWeLinkSocketOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.cleanup();
    this.ws?.removeAllListeners();
    this.ws?.on('error', () => undefined);
    this.ws?.terminate();
    this.ws = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let auth: EWeLinkSocketAuth;
    try {
      auth = await this.options.auth();
    } catch (error) {
      this.options.log.debug(`eWeLink live updates unavailable: ${errorMessage(error)}`);
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;

    const url = this.options.url?.(auth.domain, auth.port) ?? `wss://${auth.domain}:${auth.port}/api/ws`;
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    this.ws = ws;
    const sequence = String(Date.now());

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          action: 'userOnline',
          at: auth.at,
          apikey: auth.apikey,
          appid: auth.appid,
          nonce: nonce(),
          ts: Math.floor(Date.now() / 1000),
          userAgent: 'app',
          sequence,
          version: 8,
        }),
      );
    });

    ws.on('message', (data) => {
      const text = data.toString();
      if (text === 'pong') return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      this.handleMessage(ws, message, sequence);
    });

    ws.on('error', (error) => this.options.log.debug(`eWeLink live update connection error: ${errorMessage(error)}`));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      const wasConnected = this.connected;
      this.cleanup();
      if (this.stopped) return;
      if (wasConnected) this.options.log.info('eWeLink live updates disconnected, reconnecting.');
      if (wasConnected && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) this.attempt = 0;
      this.scheduleRetry();
    });
  }

  private handleMessage(ws: WebSocket, message: Record<string, unknown>, sequence: string): void {
    // Answer to userOnline
    if (!this.connected && message.sequence === sequence && message.action === undefined) {
      const error = Number(message.error ?? 0);
      if (error !== 0) {
        if (error === OTHER_SESSION_ERROR) {
          this.options.log.warn('eWeLink refused live updates because this account is logged in with the same app elsewhere (error 406).');
        } else {
          this.options.log.warn(`eWeLink refused live updates (error ${error}${message.reason ? `: ${message.reason}` : ''}).`);
        }
        ws.close();
        return;
      }
      this.connected = true;
      this.connectedAt = Date.now();
      const config = (message.config ?? {}) as { hb?: number; hbInterval?: number };
      const interval = Number(config.hbInterval) > 0 ? Number(config.hbInterval) : DEFAULT_HEARTBEAT_S;
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), interval * 1000);
      this.heartbeat.unref?.();
      this.options.log.info('eWeLink live updates connected.');
      this.options.onConnected?.(true);
      return;
    }

    const deviceId = typeof message.deviceid === 'string' ? message.deviceid : undefined;
    const params = message.params && typeof message.params === 'object' ? (message.params as EWeLinkParams) : undefined;
    if (!deviceId || !params) return;
    if (message.action === 'update') this.options.onUpdate(deviceId, params);
    else if (message.action === 'sysmsg' && typeof params.online === 'boolean') this.options.onOnline(deviceId, params.online);
  }

  private cleanup(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.connected) {
      this.connected = false;
      this.options.onConnected?.(false);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delays = this.options.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }
}
