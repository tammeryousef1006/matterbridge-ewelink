import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as http from 'http';
import * as os from 'os';

import { EWeLinkLogger, EWeLinkParams, errorMessage } from './ewelinkApi.js';

/**
 * eWeLink LAN mode: devices announce themselves with mDNS (_ewelink._tcp.local) and take commands over HTTP on
 * their own address (POST /zeroconf/<command>), without the cloud. Their state and the commands are encrypted
 * with AES-128-CBC; the key is the MD5 of the device key the eWeLink cloud gives out once (protocol as in
 * eWeLink's own LAN API and SonoffLAN, https://github.com/AlexxIT/SonoffLAN).
 */
export interface EWeLinkLanOptions {
  log: EWeLinkLogger;
  /** The device key of a device, from the cloud device list (saved, so it also works offline). */
  keyFor: (deviceId: string) => string | undefined;
  /** New state from a device's announcement. */
  onUpdate: (deviceId: string, params: EWeLinkParams) => void;
  /** A device was seen on the network (first time, or again after it was gone). */
  onSeen?: (deviceId: string, seen: boolean) => void;
}

export interface LanDevice {
  deviceId: string;
  host: string;
  port: number;
  /** Device type in the announcement (plug, strip, diy_plug, light, fan_light, ...). */
  type?: string;
  encrypted: boolean;
  seq?: string;
  lastSeen: number;
}

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_ewelink._tcp.local';
const QUERY_INTERVAL_MS = 60_000;
/** A device not heard of for this long is treated as gone from the network. */
const GONE_AFTER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 4000;

/** Commands whose endpoint is not the first param name (SonoffLAN). */
const COMMAND_BY_UIID: Record<number, string> = { 44: 'dimmable' };

export function lanKey(deviceKey: string): Buffer {
  return crypto.createHash('md5').update(deviceKey, 'utf8').digest();
}

export function encryptParams(params: EWeLinkParams, deviceKey: string, iv = crypto.randomBytes(16)): { iv: string; data: string } {
  const cipher = crypto.createCipheriv('aes-128-cbc', lanKey(deviceKey), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(params), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}

export function decryptParams(data: string, iv: string, deviceKey: string): EWeLinkParams {
  const decipher = crypto.createDecipheriv('aes-128-cbc', lanKey(deviceKey), Buffer.from(iv, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(text) as EWeLinkParams;
}

/** The HTTP endpoint for a command: the first param name, with the known exceptions. */
export function lanCommand(params: EWeLinkParams, uiid?: number): string {
  if (uiid !== undefined && COMMAND_BY_UIID[uiid]) return COMMAND_BY_UIID[uiid];
  if ('switches' in params) return 'switches';
  if ('switch' in params) return 'switch';
  return Object.keys(params)[0] ?? 'info';
}

// ---- minimal mDNS (only what eWeLink devices send: PTR, SRV, TXT, A) ----

interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  data: Buffer;
  offset: number;
  message: Buffer;
}

function readName(message: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  let jumps = 0;
  while (offset < message.length) {
    const length = message[offset];
    if (length === 0) {
      offset++;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (next < 0) next = offset + 2;
      offset = ((length & 0x3f) << 8) | message[offset + 1];
      if (++jumps > 20) break;
      continue;
    }
    labels.push(message.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return { name: labels.join('.'), next: next < 0 ? offset : next };
}

export function parseMdns(message: Buffer): DnsRecord[] {
  if (message.length < 12) return [];
  const questions = message.readUInt16BE(4);
  const records = message.readUInt16BE(6) + message.readUInt16BE(8) + message.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i++) offset = readName(message, offset).next + 4;
  const out: DnsRecord[] = [];
  for (let i = 0; i < records && offset < message.length; i++) {
    const { name, next } = readName(message, offset);
    offset = next;
    if (offset + 10 > message.length) break;
    const type = message.readUInt16BE(offset);
    const ttl = message.readUInt32BE(offset + 4);
    const length = message.readUInt16BE(offset + 8);
    offset += 10;
    out.push({ name, type, ttl, data: message.subarray(offset, offset + length), offset, message });
    offset += length;
  }
  return out;
}

function txtEntries(data: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset];
    const text = data.toString('utf8', offset + 1, offset + 1 + length);
    const eq = text.indexOf('=');
    if (eq > 0) entries[text.slice(0, eq)] = text.slice(eq + 1);
    offset += 1 + length;
  }
  return entries;
}

function query(): Buffer {
  const labels = SERVICE.split('.');
  const name = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, name, tail]);
}

export class EWeLinkLan {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private readonly devices = new Map<string, LanDevice>();
  /** SRV target host name -> IPv4 address, from A records. */
  private readonly addresses = new Map<string, string>();
  private stopped = true;

  constructor(private readonly options: EWeLinkLanOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (message, rinfo) => this.onMessage(message, rinfo.address));
    socket.on('error', (error) => this.options.log.warn(`Local network (mDNS): ${errorMessage(error)}`));
    socket.bind(MDNS_PORT, () => {
      for (const address of localAddresses()) {
        try {
          socket.addMembership(MDNS_ADDRESS, address);
        } catch {
          // an interface without multicast: skip it
        }
      }
      this.query();
    });
    this.timer = setInterval(() => {
      this.query();
      this.expire();
    }, QUERY_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = undefined;
  }

  /** The device can be controlled locally: it is on the network and its key is known. */
  isLocal(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return !!device && Date.now() - device.lastSeen < GONE_AFTER_MS && (!device.encrypted || !!this.options.keyFor(deviceId));
  }

  /** Seen on the network (with or without a key). */
  seen(deviceId: string): LanDevice | undefined {
    const device = this.devices.get(deviceId);
    return device && Date.now() - device.lastSeen < GONE_AFTER_MS ? device : undefined;
  }

  /** Send params to the device over the local network. Throws when the device does not accept them. */
  async send(deviceId: string, params: EWeLinkParams, uiid?: number): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('not found on the local network');
    const key = this.options.keyFor(deviceId);
    const body: Record<string, unknown> = { sequence: String(Date.now()), deviceid: deviceId, selfApikey: '123' };
    if (device.encrypted) {
      if (!key) throw new Error('no local key for this device yet');
      Object.assign(body, { encrypt: true, ...encryptParams(params, key) });
    } else {
      body.data = params;
    }
    const command = lanCommand(params, uiid);
    const answer = await postJson(device.host, device.port, `/zeroconf/${command}`, body);
    const error = Number((answer as { error?: number }).error ?? 0);
    if (error !== 0) throw new Error(`the device answered error ${error} to ${command}`);
  }

  private query(): void {
    if (!this.socket || this.stopped) return;
    this.socket.send(query(), MDNS_PORT, MDNS_ADDRESS, () => undefined);
  }

  private expire(): void {
    for (const device of this.devices.values()) {
      if (device.lastSeen && Date.now() - device.lastSeen >= GONE_AFTER_MS) {
        device.lastSeen = 0;
        this.options.log.info(`eWeLink ${device.deviceId} is no longer seen on the local network.`);
        this.options.onSeen?.(device.deviceId, false);
      }
    }
  }

  private onMessage(message: Buffer, from: string): void {
    let records: DnsRecord[];
    try {
      records = parseMdns(message);
    } catch {
      return;
    }
    if (!records.some((r) => r.name.toLowerCase().includes('_ewelink._tcp'))) {
      // A records can come in their own packet
      for (const r of records) if (r.type === 1 && r.data.length === 4) this.addresses.set(r.name.toLowerCase(), [...r.data].join('.'));
      return;
    }
    for (const r of records) if (r.type === 1 && r.data.length === 4) this.addresses.set(r.name.toLowerCase(), [...r.data].join('.'));
    let port = 8081;
    let target: string | undefined;
    let txt: Record<string, string> | undefined;
    for (const r of records) {
      if (r.type === 33 && r.data.length >= 6) {
        port = r.data.readUInt16BE(4);
        target = readName(r.message, r.offset + 6).name.toLowerCase();
      } else if (r.type === 16 && r.name.toLowerCase().includes('_ewelink._tcp')) {
        txt = txtEntries(r.data);
      }
    }
    if (!txt?.id) return;
    const deviceId = txt.id;
    const host = (target && this.addresses.get(target)) || from;
    const known = this.devices.get(deviceId);
    const device: LanDevice = known ?? { deviceId, host, port, encrypted: true, lastSeen: 0 };
    const wasGone = !device.lastSeen;
    device.host = host;
    device.port = port;
    device.type = txt.type;
    device.encrypted = txt.encrypt !== 'false' && !!txt.iv;
    device.lastSeen = Date.now();
    this.devices.set(deviceId, device);
    if (wasGone) {
      this.options.log.info(`eWeLink ${deviceId} found on the local network at ${host}:${port}${device.encrypted && !this.options.keyFor(deviceId) ? ' (no local key yet)' : ''}.`);
      this.options.onSeen?.(deviceId, true);
    }
    // the announcement carries the current state; a new seq means it changed
    if (txt.seq === undefined || txt.seq === device.seq) return;
    device.seq = txt.seq;
    const data = (txt.data1 ?? '') + (txt.data2 ?? '') + (txt.data3 ?? '') + (txt.data4 ?? '');
    if (!data) return;
    try {
      let params: EWeLinkParams;
      if (device.encrypted) {
        const key = this.options.keyFor(deviceId);
        if (!key) return;
        params = decryptParams(data, txt.iv, key);
      } else {
        params = JSON.parse(data) as EWeLinkParams;
      }
      this.options.onUpdate(deviceId, params);
    } catch (error) {
      this.options.log.debug(`eWeLink ${deviceId}: could not read the local state (${errorMessage(error)}); the device key may have changed (paired again?)`);
    }
  }
}

function localAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function postJson(host: string, port: number, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request(
      { host, port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'close' }, timeout: REQUEST_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            resolve({});
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`no answer from ${host}:${port} within ${REQUEST_TIMEOUT_MS / 1000} s`)));
    request.on('error', reject);
    request.end(payload);
  });
}
