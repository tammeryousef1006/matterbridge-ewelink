import { EWeLinkDevice, EWeLinkParams } from './ewelinkApi.js';

/** One Matter-facing function of an eWeLink device; a device can have several (e.g. a TH16 is a switch plus two sensors). */
export type DeviceFunction =
  | { kind: 'onOff'; id: string; channel?: number }
  /** One security mode of an NSPanel Pro / Bridge as a switch: on while that mode is armed. */
  | { kind: 'security'; id: string; mode: number }
  | { kind: 'temperature'; id: string }
  | { kind: 'humidity'; id: string }
  | { kind: 'contact'; id: string }
  | { kind: 'motion'; id: string }
  /** Bright/dark only (SNZB-06P), reported as a fixed illuminance. */
  | { kind: 'light'; id: string };

export interface DeviceState {
  /** On/off per function id (switches and security modes). */
  onOff: Record<string, boolean>;
  /** Degrees Celsius. */
  temperature?: number;
  /** Percent. */
  humidity?: number;
  /** true when the door/window is closed. */
  contact?: boolean;
  motion?: boolean;
  /** true when bright, false when dark. */
  bright?: boolean;
  /** Percent, for battery powered (Zigbee) sensors. */
  battery?: number;
}

/**
 * Number of relays of multi-channel devices, by UIID. Their `switches` array often lists four outlets
 * whatever the real number is. Unknown UIIDs fall back to the length of that array.
 */
const CHANNEL_COUNT: Record<number, number> = {
  2: 2, 3: 3, 4: 4, 7: 2, 8: 3, 9: 4, 29: 2, 30: 3, 31: 4, 77: 1, 78: 1, 81: 1, 82: 2, 83: 3, 84: 4, 107: 1,
  // DualR3, NSPanel, M5
  126: 2, 133: 2, 161: 2, 162: 3,
  // TX Ultimate T5-1C/2C/3C/4C
  209: 1, 210: 2, 211: 3, 212: 4,
  7029: 2,
  // Virtual switches (eWeLink scenes), single channel despite a 4 entry switches array
  264: 1,
};
/** Security modes of the NSPanel Pro and Bridge-M/U (`securityType`; 0 is disarmed). */
export const SECURITY_MODES = [
  { id: 'home', mode: 1, label: 'Home Mode' },
  { id: 'away', mode: 2, label: 'Away Mode' },
  { id: 'sleep', mode: 3, label: 'Sleep Mode' },
];
// SNZB-02 and SNZB-02D
const ZIGBEE_TEMP_HUMIDITY = new Set([1770, 1771]);
// SNZB-04
const ZIGBEE_CONTACT = new Set([3026]);
// SNZB-03
const ZIGBEE_MOTION = new Set([2026]);
// SNZB-06P presence sensor (mains powered)
const ZIGBEE_PRESENCE = new Set([7016]);
/** Zigbee sensors that report a battery level. */
export const BATTERY_UIIDS = new Set([...ZIGBEE_TEMP_HUMIDITY, ...ZIGBEE_CONTACT, ...ZIGBEE_MOTION]);

/** Work out what an eWeLink device can do from its UIID and params. Returns an empty list for unsupported devices. */
export function deviceFunctions(device: EWeLinkDevice): DeviceFunction[] {
  const { uiid, params } = device;
  if (ZIGBEE_CONTACT.has(uiid)) return [{ kind: 'contact', id: 'contact' }];
  if (ZIGBEE_MOTION.has(uiid)) return [{ kind: 'motion', id: 'motion' }];
  if (ZIGBEE_PRESENCE.has(uiid)) {
    const functions: DeviceFunction[] = [{ kind: 'motion', id: 'motion' }];
    if (typeof params.brState === 'string') functions.push({ kind: 'light', id: 'light' });
    return functions;
  }
  if (ZIGBEE_TEMP_HUMIDITY.has(uiid)) {
    return [
      { kind: 'temperature', id: 'temperature' },
      { kind: 'humidity', id: 'humidity' },
    ];
  }

  const functions: DeviceFunction[] = [];
  if (params.securityType !== undefined && Number.isInteger(Number(params.securityType))) {
    for (const { id, mode } of SECURITY_MODES) functions.push({ kind: 'security', id, mode });
  }
  if (Array.isArray(params.switches) && !('switch' in params)) {
    const count = CHANNEL_COUNT[uiid] ?? params.switches.length;
    for (let channel = 0; channel < count; channel++) functions.push({ kind: 'onOff', id: `channel${channel + 1}`, channel });
  } else if (typeof params.switch === 'string') {
    functions.push({ kind: 'onOff', id: 'switch' });
  }

  // TH10/TH16/THR3xx report their probe readings next to the relay; without a probe they say "unavailable"
  if (scaled(params.currentTemperature, 1) !== undefined) functions.push({ kind: 'temperature', id: 'temperature' });
  if (scaled(params.currentHumidity, 1) !== undefined) functions.push({ kind: 'humidity', id: 'humidity' });
  return functions;
}

/** Extract the current state from eWeLink params. Values that are missing or "unavailable" are left undefined. */
export function deviceState(device: EWeLinkDevice, functions: DeviceFunction[]): DeviceState {
  const { uiid, params } = device;
  const state: DeviceState = { onOff: {} };

  for (const fn of functions) {
    if (fn.kind === 'security') {
      if (params.securityType !== undefined) state.onOff[fn.id] = Number(params.securityType) === fn.mode;
      continue;
    }
    if (fn.kind !== 'onOff') continue;
    const value = fn.channel === undefined ? params.switch : channelSwitch(params, fn.channel);
    if (value === 'on' || value === 'off') state.onOff[fn.id] = value === 'on';
  }

  if (ZIGBEE_TEMP_HUMIDITY.has(uiid)) {
    // Zigbee sensors report hundredths, as strings
    state.temperature = scaled(params.temperature, 100);
    state.humidity = scaled(params.humidity, 100);
  } else {
    state.temperature = scaled(params.currentTemperature, 1);
    state.humidity = scaled(params.currentHumidity, 1);
  }
  // SNZB-04 reports lock: 1 when the magnet is away (open)
  if (ZIGBEE_CONTACT.has(uiid) && params.lock !== undefined) state.contact = Number(params.lock) === 0;
  if (ZIGBEE_MOTION.has(uiid) && params.motion !== undefined) state.motion = Number(params.motion) === 1;
  if (ZIGBEE_PRESENCE.has(uiid) && params.human !== undefined) state.motion = Number(params.human) === 1;
  if (ZIGBEE_PRESENCE.has(uiid) && (params.brState === 'brighter' || params.brState === 'darker')) state.bright = params.brState === 'brighter';
  if (BATTERY_UIIDS.has(uiid)) {
    const battery = scaled(params.battery, 1);
    if (battery !== undefined) state.battery = Math.max(0, Math.min(100, Math.round(battery)));
  }
  return state;
}

/**
 * Params to send to switch one function on or off, or undefined when nothing has to be sent
 * (turning off a security mode that is not armed must not disarm the active one).
 */
export function onOffParams(fn: DeviceFunction, on: boolean, current: EWeLinkParams = {}): EWeLinkParams | undefined {
  if (fn.kind === 'security') {
    if (on) return { securityType: fn.mode, currentType: fn.mode };
    return Number(current.securityType) === fn.mode ? { securityType: 0 } : undefined;
  }
  if (fn.kind !== 'onOff') throw new Error(`${fn.id} is not a switch.`);
  const value = on ? 'on' : 'off';
  return fn.channel === undefined ? { switch: value } : { switches: [{ switch: value, outlet: fn.channel }] };
}

/** Merge params changed by a command into the cached params so the next state read reflects it. */
export function mergeParams(params: EWeLinkParams, update: EWeLinkParams): EWeLinkParams {
  const merged = { ...params, ...update };
  if (Array.isArray(update.switches) && Array.isArray(params.switches)) {
    const switches = params.switches.map((entry) => ({ ...(entry as object) })) as { switch: string; outlet: number }[];
    for (const change of update.switches as { switch: string; outlet: number }[]) {
      const existing = switches.find((entry) => entry.outlet === change.outlet);
      if (existing) existing.switch = change.switch;
      else switches.push(change);
    }
    merged.switches = switches;
  }
  return merged;
}

function channelSwitch(params: EWeLinkParams, channel: number): unknown {
  if (!Array.isArray(params.switches)) return undefined;
  const entry = (params.switches as { switch?: string; outlet?: number }[]).find((item) => item?.outlet === channel);
  return entry?.switch;
}

function scaled(value: unknown, divisor: number): number | undefined {
  if (value === undefined || value === null || value === '' || value === 'unavailable') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number / divisor : undefined;
}

/** Lux reported for a bright/dark-only light sensor. */
export const BRIGHT_LUX = 300;
export const DARK_LUX = 5;

/** Matter illuminance attribute value (10000 * log10(lux) + 1) for a lux reading. */
export function illuminanceValue(lux: number): number {
  return Math.round(10000 * Math.log10(Math.max(lux, 1)) + 1);
}
