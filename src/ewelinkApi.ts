import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface EWeLinkLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export type EWeLinkRegion = 'eu' | 'us' | 'as' | 'cn';

/** What the plugin has to remember between restarts to stay logged in. */
export interface EWeLinkTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessTokenExpiresAt: number;
  /** Epoch ms. */
  refreshTokenExpiresAt: number;
  region: EWeLinkRegion;
}

export interface EWeLinkApiOptions {
  appId: string;
  appSecret: string;
  /** Must match the redirect URL registered for the app on dev.ewelink.cc. */
  redirectUrl: string;
  /** Tokens saved by an earlier login. */
  tokens?: EWeLinkTokens;
  /** Called whenever the tokens change (login, refresh, logout) so they can be saved. */
  onTokens?: (tokens: EWeLinkTokens | undefined) => void;
  /** Override the API base URL for every region (used by tests). */
  baseUrl?: string;
  timeoutMs?: number;
}

export type EWeLinkParams = Record<string, unknown>;

export interface EWeLinkDevice {
  deviceid: string;
  name: string;
  online: boolean;
  /** eWeLink device type ("UIID"), which decides the params layout. */
  uiid: number;
  brandName?: string;
  productModel?: string;
  fwVersion?: string;
  params: EWeLinkParams;
}

interface EWeLinkResponse<T> {
  error: number;
  msg?: string;
  data?: T;
}

interface EWeLinkOAuthTokenData {
  accessToken?: string;
  refreshToken?: string;
  atExpiredTime?: number;
  rtExpiredTime?: number;
}

interface EWeLinkRefreshData {
  at?: string;
  rt?: string;
}

interface EWeLinkThing {
  itemType: number;
  itemData: {
    deviceid?: string;
    name?: string;
    online?: boolean;
    brandName?: string;
    productModel?: string;
    extra?: { uiid?: number; model?: string };
    params?: EWeLinkParams;
  };
}

interface EWeLinkThingList {
  thingList?: EWeLinkThing[];
  total?: number;
}

export const OAUTH_PAGE_URL = 'https://c2ccdn.coolkit.cc/oauth/index.html';
const REGIONS: EWeLinkRegion[] = ['eu', 'us', 'as', 'cn'];
/** Error codes eWeLink returns when the access token is invalid or expired. */
const TOKEN_ERROR_CODES = new Set([401, 402, 406]);
/** Item types of devices in the thing list (own and shared); groups are skipped. */
const DEVICE_ITEM_TYPES = new Set([1, 2]);
/** Access tokens last 30 days and refresh tokens 60; renew the access token a few days early. */
const ACCESS_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
const RENEW_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

export class EWeLinkApiError extends Error {
  constructor(
    message: string,
    public readonly errcode?: number,
  ) {
    super(message);
    this.name = 'EWeLinkApiError';
  }
}

/** Thrown when there is no valid login; the user has to log in again in the browser. */
export class EWeLinkNotLoggedInError extends Error {
  constructor(message = 'Not logged in to eWeLink.') {
    super(message);
    this.name = 'EWeLinkNotLoggedInError';
  }
}

export function regionBaseUrl(region: EWeLinkRegion): string {
  return region === 'cn' ? 'https://cn-apia.coolkit.cn' : `https://${region}-apia.coolkit.cc`;
}

export function isRegion(value: unknown): value is EWeLinkRegion {
  return REGIONS.includes(value as EWeLinkRegion);
}

/** Minimal client for the eWeLink (CoolKit) open platform REST API v2, logged in with OAuth 2.0. */
export class EWeLinkApi {
  private readonly http: AxiosInstance;
  private tokens: EWeLinkTokens | undefined;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly options: EWeLinkApiOptions,
    private readonly log: EWeLinkLogger,
  ) {
    this.http = axios.create({ timeout: options.timeoutMs ?? 15000 });
    const tokens = options.tokens;
    if (tokens?.accessToken && tokens.refreshToken && isRegion(tokens.region) && tokens.refreshTokenExpiresAt > Date.now()) {
      this.tokens = { ...tokens };
    }
  }

  get isLoggedIn(): boolean {
    return this.tokens !== undefined;
  }

  get region(): EWeLinkRegion | undefined {
    return this.tokens?.region;
  }

  /** URL of eWeLink's login page. After login eWeLink redirects to the app's redirect URL with code, region and state. */
  loginUrl(state: string): string {
    const seq = String(Date.now());
    const params = new URLSearchParams({
      clientId: this.options.appId,
      seq,
      authorization: this.sign(`${this.options.appId}_${seq}`),
      redirectUrl: this.options.redirectUrl,
      grantType: 'authorization_code',
      state,
      nonce: nonce(),
    });
    return `${OAUTH_PAGE_URL}?${params.toString()}`;
  }

  /** Exchange the authorization code from the login redirect for tokens. The code is only valid for 30 seconds. */
  async completeLogin(code: string, region: string): Promise<void> {
    if (!isRegion(region)) throw new EWeLinkApiError(`Unknown eWeLink region "${region}".`);
    const data = await this.signedPost<EWeLinkOAuthTokenData>(region, '/v2/user/oauth/token', {
      code,
      redirectUrl: this.options.redirectUrl,
      grantType: 'authorization_code',
    });
    if (!data.accessToken || !data.refreshToken) throw new EWeLinkApiError('eWeLink did not return tokens.');
    const now = Date.now();
    this.setTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessTokenExpiresAt: data.atExpiredTime || now + ACCESS_TOKEN_LIFETIME_MS,
      refreshTokenExpiresAt: data.rtExpiredTime || now + REFRESH_TOKEN_LIFETIME_MS,
      region,
    });
    this.log.info(`Logged in to eWeLink (region ${region}).`);
  }

  logout(): void {
    this.setTokens(undefined);
  }

  /** Renew the access token when it is close to expiring (or when forced after eWeLink rejected it). */
  async ensureFreshToken(force = false): Promise<void> {
    const tokens = this.tokens;
    if (!tokens) throw new EWeLinkNotLoggedInError();
    if (!force && Date.now() < tokens.accessTokenExpiresAt - RENEW_MARGIN_MS) return;
    // Share one in-flight refresh between concurrent callers
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(tokens).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refresh(tokens: EWeLinkTokens): Promise<void> {
    let data: EWeLinkRefreshData;
    try {
      data = await this.signedPost<EWeLinkRefreshData>(tokens.region, '/v2/user/refresh', { rt: tokens.refreshToken });
    } catch (error) {
      // Only a rejected refresh token means the login is gone; network errors are retried later
      if (error instanceof EWeLinkApiError && error.errcode !== undefined) {
        this.log.warn(`eWeLink refused to renew the login (${errorMessage(error)}). Please log in again.`);
        this.setTokens(undefined);
        throw new EWeLinkNotLoggedInError('The eWeLink login has expired. Please log in again.');
      }
      throw error;
    }
    if (!data.at) throw new EWeLinkApiError('eWeLink did not return an access token.');
    const now = Date.now();
    this.setTokens({
      ...tokens,
      accessToken: data.at,
      refreshToken: data.rt ?? tokens.refreshToken,
      accessTokenExpiresAt: now + ACCESS_TOKEN_LIFETIME_MS,
      refreshTokenExpiresAt: data.rt ? now + REFRESH_TOKEN_LIFETIME_MS : tokens.refreshTokenExpiresAt,
    });
    this.log.debug('Renewed the eWeLink access token.');
  }

  private setTokens(tokens: EWeLinkTokens | undefined): void {
    this.tokens = tokens;
    this.options.onTokens?.(tokens ? { ...tokens } : undefined);
  }

  /** All devices on the account, including devices shared with it. */
  async listDevices(): Promise<EWeLinkDevice[]> {
    const data = await this.authorized<EWeLinkThingList>('get', '/v2/device/thing', { num: 0 });
    const devices: EWeLinkDevice[] = [];
    for (const thing of data.thingList ?? []) {
      if (!DEVICE_ITEM_TYPES.has(thing.itemType)) continue;
      const item = thing.itemData;
      if (!item?.deviceid) continue;
      devices.push({
        deviceid: item.deviceid,
        name: (item.name || item.deviceid).trim(),
        online: item.online === true,
        uiid: Number(item.extra?.uiid ?? 0),
        brandName: item.brandName,
        productModel: item.productModel || item.extra?.model,
        fwVersion: typeof item.params?.fwVersion === 'string' ? item.params.fwVersion : undefined,
        params: item.params ?? {},
      });
    }
    return devices;
  }

  /** Send new params (e.g. { switch: 'on' }) to a device. */
  async setParams(deviceId: string, params: EWeLinkParams): Promise<void> {
    await this.authorized('post', '/v2/device/thing/status', { type: 1, id: deviceId, params });
  }

  private async authorized<T>(method: 'get' | 'post', path: string, payload: Record<string, unknown>): Promise<T> {
    await this.ensureFreshToken();
    try {
      return await this.bearer<T>(method, path, payload);
    } catch (error) {
      if (!(error instanceof EWeLinkApiError) || error.errcode === undefined || !TOKEN_ERROR_CODES.has(error.errcode)) throw error;
      this.log.debug(`eWeLink rejected the access token (${error.errcode}), renewing it.`);
      await this.ensureFreshToken(true);
      return this.bearer<T>(method, path, payload);
    }
  }

  private bearer<T>(method: 'get' | 'post', path: string, payload: Record<string, unknown>): Promise<T> {
    const tokens = this.tokens;
    if (!tokens) throw new EWeLinkNotLoggedInError();
    const url = this.url(tokens.region, path);
    const headers = this.headers(`Bearer ${tokens.accessToken}`);
    return this.request<T>(path, () =>
      method === 'get' ? this.http.get(url, { params: payload, headers }) : this.http.post(url, JSON.stringify(payload), { headers }),
    );
  }

  /** POST signed with the app secret instead of a token. */
  private signedPost<T>(region: EWeLinkRegion, path: string, body: Record<string, unknown>): Promise<T> {
    const json = JSON.stringify(body);
    const headers = this.headers(`Sign ${this.sign(json)}`);
    return this.request<T>(path, () => this.http.post(this.url(region, path), json, { headers }));
  }

  private url(region: EWeLinkRegion, path: string): string {
    return `${(this.options.baseUrl ?? regionBaseUrl(region)).replace(/\/+$/, '')}${path}`;
  }

  private sign(message: string): string {
    return crypto.createHmac('sha256', this.options.appSecret).update(message).digest('base64');
  }

  private headers(authorization: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-CK-Appid': this.options.appId,
      'X-CK-Nonce': nonce(),
      Authorization: authorization,
    };
  }

  private async request<T>(path: string, call: () => Promise<{ data: EWeLinkResponse<T> }>): Promise<T> {
    let response: EWeLinkResponse<T>;
    try {
      response = (await call()).data;
    } catch (error) {
      throw new EWeLinkApiError(`Request to ${path} failed: ${errorMessage(error)}`);
    }
    if (!response || typeof response !== 'object') throw new EWeLinkApiError(`Unexpected response from ${path}.`);
    if (response.error !== 0) {
      throw new EWeLinkApiError(`eWeLink error ${response.error}${response.msg ? `: ${response.msg}` : ''}`, response.error);
    }
    return (response.data ?? {}) as T;
  }
}

/** 8 character alphanumeric nonce, as eWeLink requires. */
function nonce(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
