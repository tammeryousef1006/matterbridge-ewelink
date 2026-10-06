import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface EWeLinkLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export type EWeLinkRegion = 'eu' | 'us' | 'as' | 'cn';

export interface EWeLinkApiOptions {
  appId: string;
  appSecret: string;
  email: string;
  password: string;
  /** Country code of the account, e.g. +1 or +44. Also picks the first region tried on login. */
  countryCode: string;
  /** Starting region; defaults to one derived from the country code. The login switches to the account's real region. */
  region?: EWeLinkRegion;
  /** Override the API base URL (used by tests). Disables region switching. */
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

interface EWeLinkLoginData {
  at?: string;
  rt?: string;
  region?: EWeLinkRegion;
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

/** Error codes eWeLink returns when the access token is invalid or expired. */
const TOKEN_ERROR_CODES = new Set([401, 402, 406]);
const WRONG_REGION_ERROR = 10004;
/** Item types of devices in the thing list (own and shared); groups are skipped. */
const DEVICE_ITEM_TYPES = new Set([1, 2]);
/** Access tokens last 30 days; renew them a day early. */
const TOKEN_LIFETIME_MS = 29 * 24 * 60 * 60 * 1000;

export class EWeLinkApiError extends Error {
  constructor(
    message: string,
    public readonly errcode?: number,
  ) {
    super(message);
    this.name = 'EWeLinkApiError';
  }
}

export function regionBaseUrl(region: EWeLinkRegion): string {
  return region === 'cn' ? 'https://cn-apia.coolkit.cn' : `https://${region}-apia.coolkit.cc`;
}

/** Minimal client for the eWeLink (CoolKit) open platform REST API v2. */
export class EWeLinkApi {
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;
  private authPromise: Promise<void> | null = null;
  private region: EWeLinkRegion;

  constructor(
    private readonly options: EWeLinkApiOptions,
    private readonly log: EWeLinkLogger,
  ) {
    this.region = options.region ?? regionForCountryCode(options.countryCode);
    this.http = axios.create({
      baseURL: (options.baseUrl ?? regionBaseUrl(this.region)).replace(/\/+$/, ''),
      timeout: options.timeoutMs ?? 15000,
    });
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  get currentRegion(): EWeLinkRegion {
    return this.region;
  }

  /** Make sure a usable access token is available, logging in or refreshing as needed. */
  async ensureAuthenticated(force = false): Promise<void> {
    if (!force && this.accessToken && Date.now() < this.tokenExpiresAt) return;
    // Share one in-flight authentication between concurrent callers
    if (!this.authPromise) {
      this.authPromise = this.authenticate().finally(() => {
        this.authPromise = null;
      });
    }
    return this.authPromise;
  }

  private async authenticate(): Promise<void> {
    if (this.refreshToken && this.accessToken) {
      try {
        const data = await this.post<EWeLinkLoginData>('/v2/user/refresh', { rt: this.refreshToken }, `Bearer ${this.accessToken}`);
        this.storeTokens(data);
        this.log.debug('Refreshed eWeLink access token.');
        return;
      } catch (error) {
        this.log.warn(`Failed to refresh eWeLink access token, logging in again: ${errorMessage(error)}`);
      }
    }
    await this.login();
  }

  private async login(regionRetry = true): Promise<void> {
    const body = {
      countryCode: normalizeCountryCode(this.options.countryCode),
      email: this.options.email.trim(),
      password: this.options.password,
      lang: 'en',
    };

    // The login request is signed with the app secret instead of a token
    const json = JSON.stringify(body);
    const sign = crypto.createHmac('sha256', this.options.appSecret).update(json).digest('base64');
    try {
      const data = await this.post<EWeLinkLoginData>('/v2/user/login', json, `Sign ${sign}`);
      this.storeTokens(data);
      this.log.info(`Successfully authenticated with eWeLink (region ${this.region}).`);
    } catch (error) {
      // The account lives in another region; the error tells us which one
      const region = error instanceof RegionError ? error.region : undefined;
      if (region && regionRetry && !this.options.baseUrl) {
        this.log.info(`eWeLink account is in region "${region}", switching API endpoint.`);
        this.region = region;
        this.http.defaults.baseURL = regionBaseUrl(region);
        return this.login(false);
      }
      throw error instanceof RegionError ? new EWeLinkApiError(error.message, WRONG_REGION_ERROR) : error;
    }
  }

  private storeTokens(data: EWeLinkLoginData): void {
    if (!data.at) throw new EWeLinkApiError('eWeLink did not return an access token.');
    this.accessToken = data.at;
    this.refreshToken = data.rt ?? this.refreshToken;
    this.tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
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
    await this.ensureAuthenticated();
    try {
      return await this.send<T>(method, path, payload);
    } catch (error) {
      if (!(error instanceof EWeLinkApiError) || error.errcode === undefined || !TOKEN_ERROR_CODES.has(error.errcode)) throw error;
      this.log.debug(`eWeLink rejected the access token (${error.errcode}), re-authenticating.`);
      // Keep the old token: the refresh request is authorized with it
      await this.ensureAuthenticated(true);
      return this.send<T>(method, path, payload);
    }
  }

  private send<T>(method: 'get' | 'post', path: string, payload: Record<string, unknown>): Promise<T> {
    const auth = `Bearer ${this.accessToken}`;
    return method === 'get' ? this.get<T>(path, payload, auth) : this.post<T>(path, JSON.stringify(payload), auth);
  }

  private async get<T>(path: string, params: Record<string, unknown>, authorization: string): Promise<T> {
    return this.request<T>(() => this.http.get(path, { params, headers: this.headers(authorization) }), path);
  }

  private async post<T>(path: string, body: string | Record<string, unknown>, authorization: string): Promise<T> {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    return this.request<T>(() => this.http.post(path, json, { headers: this.headers(authorization) }), path);
  }

  private headers(authorization: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-CK-Appid': this.options.appId,
      'X-CK-Nonce': crypto.randomBytes(4).toString('hex'),
      Authorization: authorization,
    };
  }

  private async request<T>(call: () => Promise<{ data: EWeLinkResponse<T> }>, path: string): Promise<T> {
    let response: EWeLinkResponse<T>;
    try {
      response = (await call()).data;
    } catch (error) {
      throw new EWeLinkApiError(`Request to ${path} failed: ${errorMessage(error)}`);
    }
    if (!response || typeof response !== 'object') throw new EWeLinkApiError(`Unexpected response from ${path}.`);
    if (response.error !== 0) {
      const region = (response.data as EWeLinkLoginData | undefined)?.region;
      if (response.error === WRONG_REGION_ERROR && region) throw new RegionError(region);
      throw new EWeLinkApiError(`eWeLink error ${response.error}${response.msg ? `: ${response.msg}` : ''}`, response.error);
    }
    return (response.data ?? {}) as T;
  }
}

class RegionError extends Error {
  constructor(public readonly region: EWeLinkRegion) {
    super(`eWeLink account is registered in region "${region}".`);
  }
}

export function normalizeCountryCode(code: string): string {
  const digits = (code || '').replace(/[^\d]/g, '');
  return `+${digits || '1'}`;
}

/** Best first guess of the API region; a wrong guess only costs one extra login request. */
export function regionForCountryCode(code: string): EWeLinkRegion {
  const cc = Number(normalizeCountryCode(code).slice(1));
  if (cc === 86) return 'cn';
  if (cc === 1 || (cc >= 50 && cc <= 59) || (cc >= 500 && cc <= 599)) return 'us';
  if ((cc >= 30 && cc <= 49) || (cc >= 350 && cc <= 499) || cc === 7 || cc === 20 || cc === 27 || (cc >= 210 && cc <= 299)) return 'eu';
  return 'as';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
