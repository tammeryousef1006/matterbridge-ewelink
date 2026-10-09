/**
 * Translation between eWeLink device params and plugin-level states for lights, curtains, fans,
 * thermostats and power monitoring.
 *
 * Sources: the official CoolKit UIID protocol
 * (https://github.com/CoolKit-Technologies/eWeLink-API/blob/main/en/UIIDProtocol.md) where it covers a
 * device, and SonoffLAN (https://github.com/AlexxIT/SonoffLAN) for newer devices it does not list.
 */
import { EWeLinkParams } from './ewelinkApi.js';

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** Linear conversion of value from range [a1, a2] to [b1, b2], rounded and clamped. */
export function conv(value: number, a1: number, a2: number, b1: number, b2: number): number {
  const result = Math.round(((value - a1) / (a2 - a1)) * (b2 - b1) + b1);
  return Math.min(Math.max(result, Math.min(b1, b2)), Math.max(b1, b2));
}

export function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || value === 'unavailable') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function onOff(value: unknown): boolean | undefined {
  return value === 'on' ? true : value === 'off' ? false : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------------------------------

export interface HueSat {
  /** 0-360 */
  h: number;
  /** 0-100 */
  s: number;
}

export interface LightState {
  on?: boolean;
  /** 1-100 */
  brightness?: number;
  kelvin?: number;
  color?: HueSat;
  /** Which of white (colour temperature) or colour is active, for lights that have both. */
  mode?: 'white' | 'color';
}

/** What a controller asked for; only the fields it changes are set. */
export interface LightCommand {
  on?: boolean;
  brightness?: number;
  kelvin?: number;
  color?: HueSat;
}

export interface LightProfile {
  name: string;
  dimmable: boolean;
  /** Kelvin range for colour temperature lights. */
  colorTemp?: { min: number; max: number };
  color: boolean;
  read(params: EWeLinkParams): LightState;
  /** Messages to send, in order. Brightness and colour can only be changed while the light is on on most devices. */
  write(command: LightCommand, state: LightState): EWeLinkParams[];
}

/** Turning on and off, plus `extra` for the dimming part. Lights that are off get a separate "on" first. */
function withPower(param: string, command: LightCommand, state: LightState, extra: EWeLinkParams | undefined): EWeLinkParams[] {
  if (command.on === false) return [{ [param]: 'off' }];
  if (!extra) return [{ [param]: 'on' }];
  return state.on === true ? [extra] : [{ [param]: 'on' }, extra];
}

function simpleDimmer(name: string, param: string, brightness: string, min: number, max: number, extra: EWeLinkParams = {}): LightProfile {
  return {
    name,
    dimmable: true,
    color: false,
    read: (p) => ({ on: onOff(p[param]), brightness: num(p[brightness]) === undefined ? undefined : conv(num(p[brightness])!, min, max, 1, 100) }),
    write: (c, s) =>
      withPower(param, c, s, c.brightness === undefined ? undefined : { [brightness]: conv(c.brightness, 1, 100, min, max), ...extra }),
  };
}

/** UIID 36 KING-M4 dimmer: bright 10-100 (official). */
const DIMMER_36 = simpleDimmer('dimmer', 'switch', 'bright', 10, 100);
/** UIID 277 MINI-DIM: brightness 1-100 (SonoffLAN). */
const MINI_DIM = simpleDimmer('minidim', 'switch', 'brightness', 1, 100);
/** UIID 1257 Zigbee white light: brightness 1-100, must be sent with switch on (official). */
const ZIGBEE_WHITE: LightProfile = {
  ...simpleDimmer('zigbee-white', 'switch', 'brightness', 1, 100),
  write: (c) => (c.on === false ? [{ switch: 'off' }] : [{ switch: 'on', ...(c.brightness === undefined ? {} : { brightness: conv(c.brightness, 1, 100, 1, 100) }) }]),
};
/** UIID 44 D1 dimmer: brightness percent (0-100), only accepted together with switch on and mode 0 (SonoffLAN). */
const D1: LightProfile = {
  ...simpleDimmer('d1', 'switch', 'brightness', 1, 100),
  write: (c) => (c.on === false ? [{ switch: 'off' }] : c.brightness === undefined ? [{ switch: 'on' }] : [{ switch: 'on', brightness: conv(c.brightness, 1, 100, 1, 100), mode: 0 }]),
};
/** UIID 57 single colour bulb: state on/off, channel0 "25"-"255" (official). */
const BULB_57: LightProfile = {
  name: 'bulb57',
  dimmable: true,
  color: false,
  read: (p) => ({ on: onOff(p.state), brightness: num(p.channel0) === undefined ? undefined : conv(num(p.channel0)!, 25, 255, 1, 100) }),
  write: (c, s) => withPower('state', c, s, c.brightness === undefined ? undefined : { channel0: String(conv(c.brightness, 1, 100, 25, 255)) }),
};

/** UIID 103/135 B02 (white only) and 104/136 B05 (white + colour): ltype with white {br, ct} and color {br, r, g, b} (official). */
function bulbB0x(name: string, color: boolean, ctMax: number, kelvin: { min: number; max: number }): LightProfile {
  const fromCt = (ct: number) => conv(ct, 0, ctMax, kelvin.min, kelvin.max);
  const toCt = (k: number) => conv(k, kelvin.min, kelvin.max, 0, ctMax);
  return {
    name,
    dimmable: true,
    colorTemp: kelvin,
    color,
    read(p) {
      const state: LightState = { on: onOff(p.switch) };
      const ltype = typeof p.ltype === 'string' ? p.ltype : undefined;
      const values = ltype && typeof p[ltype] === 'object' && p[ltype] ? (p[ltype] as Record<string, unknown>) : undefined;
      if (!values) return state;
      if (num(values.br) !== undefined) state.brightness = conv(num(values.br)!, 1, 100, 1, 100);
      if (ltype === 'white' && num(values.ct) !== undefined) {
        state.kelvin = fromCt(num(values.ct)!);
        state.mode = 'white';
      }
      if (ltype === 'color' && num(values.r) !== undefined) {
        state.color = rgbToHs(num(values.r)!, num(values.g) ?? 0, num(values.b) ?? 0);
        state.mode = 'color';
      }
      return state;
    },
    write(c, s) {
      const br = c.brightness ?? s.brightness ?? 100;
      let extra: EWeLinkParams | undefined;
      const useColor = color && (c.color !== undefined || (c.kelvin === undefined && s.mode === 'color'));
      if (c.color !== undefined || c.kelvin !== undefined || c.brightness !== undefined) {
        if (useColor) {
          const [r, g, b] = hsToRgb(c.color ?? s.color ?? { h: 0, s: 0 });
          extra = { ltype: 'color', color: { br, r, g, b } };
        } else {
          // Brightness and colour temperature have to be sent together (official)
          extra = { ltype: 'white', white: { br, ct: toCt(c.kelvin ?? s.kelvin ?? kelvin.max) } };
        }
      }
      // Changing mode must be accompanied by switch on (official)
      if (c.on === false) return [{ switch: 'off' }];
      return extra ? [{ switch: 'on', ...extra }] : [{ switch: 'on' }];
    },
  };
}

/** UIID 59 L1 strip (and 33, 137, 173): bright 1-100, colorR/G/B, mode 1 = static colour (official). */
const STRIP_L1: LightProfile = {
  name: 'l1',
  dimmable: true,
  color: true,
  read(p) {
    const state: LightState = { on: onOff(p.switch), mode: 'color' };
    if (num(p.bright) !== undefined) state.brightness = conv(num(p.bright)!, 1, 100, 1, 100);
    if (num(p.colorR) !== undefined) state.color = rgbToHs(num(p.colorR)!, num(p.colorG) ?? 0, num(p.colorB) ?? 0);
    return state;
  },
  write(c, s) {
    if (c.on === false) return [{ switch: 'off' }];
    const messages: EWeLinkParams[] = s.on === true ? [] : [{ switch: 'on' }];
    if (c.color !== undefined) {
      const [r, g, b] = hsToRgb(c.color);
      messages.push({ mode: 1, colorR: r, colorG: g, colorB: b, light_type: 1 });
    }
    if (c.brightness !== undefined) messages.push({ mode: 1, bright: conv(c.brightness, 1, 100, 1, 100) });
    return messages.length ? messages : [{ switch: 'on' }];
  },
};

/** UIID 1258 Zigbee CCT light: brightness 1-100, colorTemp 0 (warm) - 100 (cold) (official). */
const ZIGBEE_CCT: LightProfile = {
  name: 'zigbee-cct',
  dimmable: true,
  colorTemp: { min: 2200, max: 4000 },
  color: false,
  read: (p) => ({
    on: onOff(p.switch),
    brightness: num(p.brightness) === undefined ? undefined : conv(num(p.brightness)!, 1, 100, 1, 100),
    kelvin: num(p.colorTemp) === undefined ? undefined : conv(num(p.colorTemp)!, 0, 100, 2200, 4000),
    mode: 'white',
  }),
  write(c) {
    if (c.on === false) return [{ switch: 'off' }];
    const message: EWeLinkParams = { switch: 'on' };
    if (c.brightness !== undefined) message.brightness = conv(c.brightness, 1, 100, 1, 100);
    if (c.kelvin !== undefined) message.colorTemp = conv(c.kelvin, 2200, 4000, 0, 100);
    return [message];
  },
};

/** UIID 3258 / 7009 Zigbee RGBCW light: colorMode cct/rgb with cctBrightness/rgbBrightness, colorTemp, hue, saturation (official). */
const ZIGBEE_RGBCW: LightProfile = {
  name: 'zigbee-rgbcw',
  dimmable: true,
  colorTemp: { min: 2000, max: 6500 },
  color: true,
  read(p) {
    const mode = p.colorMode === 'rgb' ? 'color' : p.colorMode === 'cct' ? 'white' : undefined;
    const state: LightState = { on: onOff(p.switch), mode };
    const br = num(mode === 'color' ? p.rgbBrightness : p.cctBrightness);
    if (br !== undefined) state.brightness = conv(br, 1, 100, 1, 100);
    if (num(p.colorTemp) !== undefined) state.kelvin = conv(num(p.colorTemp)!, 0, 100, 2000, 6500);
    if (num(p.hue) !== undefined) state.color = { h: num(p.hue)!, s: num(p.saturation) ?? 100 };
    return state;
  },
  write(c, s) {
    if (c.on === false) return [{ switch: 'off' }];
    const useColor = c.color !== undefined || (c.kelvin === undefined && s.mode === 'color');
    if (c.color === undefined && c.kelvin === undefined && c.brightness === undefined) return [{ switch: 'on' }];
    const br = conv(c.brightness ?? s.brightness ?? 100, 1, 100, 1, 100);
    if (useColor) {
      const hs = c.color ?? s.color ?? { h: 0, s: 100 };
      return [{ colorMode: 'rgb', switch: 'on', rgbBrightness: br, hue: Math.min(359, Math.round(hs.h)), saturation: Math.round(hs.s) }];
    }
    return [{ colorMode: 'cct', switch: 'on', cctBrightness: br, colorTemp: conv(c.kelvin ?? s.kelvin ?? 6500, 2000, 6500, 0, 100) }];
  },
};

const LIGHT_PROFILES: Record<number, LightProfile> = {
  36: DIMMER_36,
  44: D1,
  57: BULB_57,
  59: STRIP_L1,
  33: STRIP_L1,
  137: STRIP_L1,
  173: STRIP_L1,
  103: bulbB0x('b02', false, 255, { min: 2200, max: 6500 }),
  135: bulbB0x('b02', false, 255, { min: 2200, max: 6500 }),
  104: bulbB0x('b05', true, 255, { min: 2000, max: 6500 }),
  136: bulbB0x('b05', true, 100, { min: 2000, max: 6500 }),
  277: MINI_DIM,
  1257: ZIGBEE_WHITE,
  1258: ZIGBEE_CCT,
  3258: ZIGBEE_RGBCW,
  7009: ZIGBEE_RGBCW,
};

export function lightProfile(uiid: number): LightProfile | undefined {
  return LIGHT_PROFILES[uiid];
}

// ---------------------------------------------------------------------------------------------------
// Curtains. Positions are percent closed (0 open, 100 closed), like Matter's lift percentage.
// ---------------------------------------------------------------------------------------------------

export type CoverAction = 'open' | 'close' | 'stop';

export interface CoverProfile {
  name: string;
  /** Percent closed, if the device reports a position. */
  read(params: EWeLinkParams): number | undefined;
  action(action: CoverAction): EWeLinkParams;
  /** Params to move to a position (percent closed), if the device supports positions. */
  position?(closed: number): EWeLinkParams;
}

/** Wi-Fi curtain motors (KingArt, BINTHEN, UIID 11/258): switch on/off/pause, setclose = percent closed. */
const COVER_SETCLOSE: CoverProfile = {
  name: 'setclose',
  read: (p) => num(p.setclose),
  action: (a) => ({ switch: a === 'open' ? 'on' : a === 'close' ? 'off' : 'pause' }),
  position: (closed) => ({ setclose: closed }),
};
/** Zigbee curtain (ZBCurtain 7006, 1514): curtainAction, curPercent / openPercent = percent closed. */
const COVER_ZIGBEE: CoverProfile = {
  name: 'zigbee',
  read: (p) => num(p.curPercent),
  action: (a) => ({ curtainAction: a === 'stop' ? 'pause' : a }),
  position: (closed) => ({ openPercent: closed }),
};
/** DualR3 in motor mode (workMode 2): motorTurn 0 stop / 1 open / 2 close, currLocation and location = percent open. */
const COVER_DUALR3: CoverProfile = {
  name: 'dualr3',
  read: (p) => (num(p.currLocation) === undefined ? undefined : 100 - num(p.currLocation)!),
  action: (a) => ({ motorTurn: a === 'open' ? 1 : a === 'close' ? 2 : 0 }),
  position: (closed) => ({ location: 100 - closed }),
};
/** TX Ultimate 3-gang in curtain mode (workMode 2): electromotor 0 open / 1 stop / 2 close, percentageControl = percent closed. */
const COVER_T5: CoverProfile = {
  name: 't5',
  read: (p) => (p.calibState === true ? num(p.percentageControl) : undefined),
  action: (a) => ({ electromotor: a === 'open' ? 0 : a === 'close' ? 2 : 1 }),
  position: (closed) => ({ percentageControl: closed }),
};

export function coverProfile(uiid: number, params: EWeLinkParams): CoverProfile | undefined {
  if (uiid === 11 || uiid === 258) return COVER_SETCLOSE;
  if (uiid === 7006 || uiid === 1514) return COVER_ZIGBEE;
  if ((uiid === 126 || uiid === 165) && Number(params.workMode) === 2) return COVER_DUALR3;
  if (uiid === 211 && Number(params.workMode) === 2) return COVER_T5;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// Fans. Speed 0 (off) to 3.
// ---------------------------------------------------------------------------------------------------

export interface FanProfile {
  name: string;
  read(params: EWeLinkParams): number | undefined;
  write(speed: number): EWeLinkParams;
}

/** iFan02/03/04 (UIID 34): outlet 0 is the light, outlets 1-3 the fan relays (official). */
const FAN_IFAN: FanProfile = {
  name: 'ifan',
  read(p) {
    if (!Array.isArray(p.switches)) return undefined;
    const s: Record<number, string> = {};
    for (const entry of p.switches as { outlet: number; switch: string }[]) s[entry.outlet] = entry.switch;
    if (s[1] !== 'on') return 0;
    if (s[2] === 'on' && s[3] !== 'on') return 2;
    if (s[3] === 'on' && s[2] !== 'on') return 3;
    return 1;
  },
  write(speed) {
    const relays: Record<number, string> =
      speed <= 0 ? { 1: 'off' } : speed === 1 ? { 1: 'on', 2: 'off', 3: 'off' } : speed === 2 ? { 1: 'on', 2: 'on', 3: 'off' } : { 1: 'on', 2: 'off', 3: 'on' };
    return { switches: Object.entries(relays).map(([outlet, value]) => ({ outlet: Number(outlet), switch: value })) };
  },
};
/** Three-speed fan (UIID 17): fan on/off, speed slow/moderate/fast (official). */
const SPEEDS_17 = ['slow', 'moderate', 'fast'];
const FAN_17: FanProfile = {
  name: 'fan17',
  read: (p) => (p.fan === 'off' ? 0 : p.fan === 'on' ? SPEEDS_17.indexOf(String(p.speed)) + 1 || 1 : undefined),
  write: (speed) => (speed <= 0 ? { fan: 'off' } : { fan: 'on', speed: SPEEDS_17[Math.min(speed, 3) - 1] }),
};

export function fanProfile(uiid: number): FanProfile | undefined {
  if (uiid === 34) return FAN_IFAN;
  if (uiid === 17) return FAN_17;
  return undefined;
}

/** Matter percent setting to a 0-3 speed, using the same thirds as Matter's Low/Medium/High fan modes. */
export function percentToSpeed(percent: number): number {
  if (percent <= 0) return 0;
  return percent <= 33 ? 1 : percent <= 66 ? 2 : 3;
}

export function speedToPercent(speed: number): number {
  return [0, 33, 66, 100][Math.max(0, Math.min(3, speed))];
}

// ---------------------------------------------------------------------------------------------------
// Thermostats. Temperatures in degrees Celsius.
// ---------------------------------------------------------------------------------------------------

export interface ThermostatState {
  on?: boolean;
  current?: number;
  target?: number;
  heating?: boolean;
}

export interface ThermostatProfile {
  name: string;
  min: number;
  max: number;
  read(params: EWeLinkParams): ThermostatState;
  power(on: boolean): EWeLinkParams;
  setTarget(target: number, params: EWeLinkParams): EWeLinkParams;
}

/** TRVZB (UIID 7017): workMode "0" manual / "1" off / "2" auto, temperatures in tenths (SonoffLAN). */
const TRVZB: ThermostatProfile = {
  name: 'trvzb',
  min: 4,
  max: 35,
  read(p) {
    const mode = num(p.workMode);
    return {
      on: mode === undefined ? undefined : mode !== 1,
      current: num(p.temperature) === undefined ? undefined : num(p.temperature)! / 10,
      target: num(p.curTargetTemp) === undefined ? undefined : num(p.curTargetTemp)! / 10,
      heating: num(p.workState) === undefined ? undefined : num(p.workState) === 1,
    };
  },
  power: (on) => ({ workMode: on ? '0' : '1' }),
  setTarget(target, p) {
    // Each mode has its own target; change the one that is in use (auto keeps auto)
    const key = num(p.workMode) === 2 ? 'autoTargetTemp' : 'manTargetTemp';
    return { ...(num(p.workMode) === 1 ? { workMode: '0' } : {}), [key]: Math.round(target * 10) };
  },
};
/** Wi-Fi thermostat (UIID 127): switch, targetTemp, temperature, workState 1 heating (SonoffLAN). */
const THERMOSTAT_127: ThermostatProfile = {
  name: 'thermostat127',
  min: 5,
  max: 45,
  read: (p) => ({ on: onOff(p.switch), current: num(p.temperature), target: num(p.targetTemp), heating: undefined }),
  power: (on) => (on ? { switch: 'on' } : { switch: 'off' }),
  setTarget: (target) => ({ targetTemp: Math.round(target * 2) / 2 }),
};

export function thermostatProfile(uiid: number): ThermostatProfile | undefined {
  if (uiid === 7017) return TRVZB;
  if (uiid === 127) return THERMOSTAT_127;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// Power monitoring
// ---------------------------------------------------------------------------------------------------

export interface PowerReading {
  /** Watts */
  power?: number;
  /** Volts */
  voltage?: number;
  /** Amps */
  current?: number;
}

export interface EnergyProfile {
  read(params: EWeLinkParams, channel?: number): PowerReading;
}

function energy(power: string, voltage: string, current: string, divisor: number, perChannel = false): EnergyProfile {
  const key = (name: string, channel?: number) => (perChannel ? `${name}_0${channel ?? 0}` : name);
  const value = (p: EWeLinkParams, name: string, channel?: number) => {
    const v = num(p[key(name, channel)]);
    return v === undefined ? undefined : v / divisor;
  };
  return {
    read: (p, channel) => ({ power: value(p, power, channel), voltage: value(p, voltage, channel), current: value(p, current, channel) }),
  };
}

/** POW, POWR2, S40 report W/V/A as decimal strings (official); newer meters report hundredths (SonoffLAN). */
const ENERGY_PROFILES: Record<number, EnergyProfile> = {
  5: energy('power', 'voltage', 'current', 1),
  32: energy('power', 'voltage', 'current', 1),
  182: energy('power', 'voltage', 'current', 1),
  190: energy('power', 'voltage', 'current', 100),
  276: energy('power', 'voltage', 'current', 100),
  283: energy('power', 'voltage', 'current', 100),
  7032: energy('power', 'voltage', 'current', 100),
  126: energy('actPow', 'voltage', 'current', 100, true),
  130: energy('actPow', 'voltage', 'current', 100, true),
};

export function energyProfile(uiid: number): EnergyProfile | undefined {
  return ENERGY_PROFILES[uiid];
}

// ---------------------------------------------------------------------------------------------------
// Colour maths (hue 0-360, saturation 0-100, RGB 0-255)
// ---------------------------------------------------------------------------------------------------

export function hsToRgb({ h, s }: HueSat): [number, number, number] {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const hue = (((h % 360) + 360) % 360) / 60;
  const chroma = sat;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] =
    hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const m = 1 - chroma;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHs(r: number, g: number, b: number): HueSat {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: Math.round((h + 360) % 360), s: max === 0 ? 0 : Math.round((delta / max) * 100) };
}

/** CIE xy (0-1) to hue/saturation, for controllers that send xy colours. */
export function xyToHs(x: number, y: number): HueSat {
  const Y = 1;
  const X = y === 0 ? 0 : (Y / y) * x;
  const Z = y === 0 ? 0 : (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  [r, g, b] = [gamma(Math.max(r, 0)), gamma(Math.max(g, 0)), gamma(Math.max(b, 0))];
  const max = Math.max(r, g, b, 1e-9);
  return rgbToHs((r / max) * 255, (g / max) * 255, (b / max) * 255);
}

export function kelvinToMireds(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}

export function miredsToKelvin(mireds: number): number {
  return Math.round(1_000_000 / Math.max(mireds, 1));
}
