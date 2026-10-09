import {
  DeviceTypeDefinition,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  PlatformMatterbridge,
  bridgedNode,
  colorTemperatureLight,
  contactSensor,
  dimmableLight,
  electricalSensor,
  extendedColorLight,
  fan,
  genericSwitch,
  humiditySensor,
  lightSensor,
  occupancySensor,
  onOffLight,
  onOffPlugInUnit,
  powerSource,
  smokeCoAlarm,
  temperatureSensor,
  thermostat,
  waterLeakDetector,
  windowCovering,
} from 'matterbridge';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AnsiLogger } from 'matterbridge/logger';
import {
  BooleanState,
  BridgedDeviceBasicInformation,
  ColorControl,
  ElectricalPowerMeasurement,
  FanControl,
  IlluminanceMeasurement,
  LevelControl,
  OccupancySensing,
  OnOff,
  PowerSource,
  RelativeHumidityMeasurement,
  SmokeCoAlarm,
  TemperatureMeasurement,
  Thermostat,
  WindowCovering,
} from 'matterbridge/matter/clusters';

import {
  BATTERY_UIIDS,
  BRIGHT_LUX,
  DARK_LUX,
  SECURITY_MODES,
  DeviceFunction,
  DeviceState,
  buttonPress,
  deviceFunctions,
  deviceState,
  illuminanceValue,
  mergeParams,
  onOffParams,
} from './deviceMapper.js';
import { BUILTIN_APP_ID, BUILTIN_APP_SECRET, BUILTIN_REDIRECT_URL } from './credentials.js';
import { EWeLinkApi, EWeLinkDevice, EWeLinkNotLoggedInError, EWeLinkParams, EWeLinkTokens, errorMessage } from './ewelinkApi.js';
import { EWeLinkSocket } from './ewelinkSocket.js';
import { LoginServer } from './loginServer.js';
import {
  CoverAction,
  HueSat,
  LightCommand,
  LightProfile,
  LightState,
  kelvinToMireds,
  miredsToKelvin,
  percentToSpeed,
  speedToPercent,
  xyToHs,
} from './profiles.js';

export interface EWeLinkPlatformConfig extends PlatformConfig {
  loginPort?: number;
  appId?: string;
  appSecret?: string;
  redirectUrl?: string;
  refreshInterval?: number;
  liveUpdates?: boolean;
  lightList?: string[];
  whiteList?: string[];
  blackList?: string[];
}

interface EWeLinkMatterDevice {
  device: EWeLinkDevice;
  name: string;
  functions: DeviceFunction[];
  /** Bridged Matter devices: one, or one per function for devices split into several (security modes, iFan). */
  roots: MatterbridgeEndpoint[];
  /** Endpoint holding each function: the root for single-function devices, a child endpoint otherwise. */
  endpoints: Map<string, MatterbridgeEndpoint>;
  /** Last curtain position eWeLink reported, so a command's own echo does not reset a moving curtain. */
  coverReported?: number;
  /** trigTime of the last button press, to tell new presses from replays. */
  lastTrigTime?: unknown;
  /** Attribute subscriptions, made once the endpoints are registered. */
  subscriptions: (() => void)[];
}

const DEFAULT_REFRESH_INTERVAL_S = 60;
const MIN_REFRESH_INTERVAL_S = 15;
/** While live updates are connected, poll only this often as a safety net. */
const LIVE_POLL_INTERVAL_MS = 5 * 60_000;
const LOW_BATTERY_PERCENT = 20;
const CRITICAL_BATTERY_PERCENT = 10;
const DEFAULT_LOGIN_PORT = 8284;
const SENSITIVE_KEYS = ['appSecret'];
const TOKENS_FILE = 'tokens.json';
/** Kinds that controllers like SmartThings only show when they are a device of their own. */
const SPLIT_KINDS = new Set<DeviceFunction['kind']>(['illuminance', 'fan']);

export class EWeLinkPlatform extends MatterbridgeDynamicPlatform {
  private readonly ewelinkConfig: EWeLinkPlatformConfig;
  private readonly api: EWeLinkApi;
  private readonly loginServer: LoginServer;
  private readonly socket: EWeLinkSocket;
  private readonly loginPort: number;
  private readonly tokensFile: string;
  private readonly devices = new Map<string, EWeLinkMatterDevice>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private lastPoll = 0;
  private configured = false;
  private loginHintShown = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion === 'function' && !this.verifyMatterbridgeVersion('3.0.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.0.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.ewelinkConfig = config as EWeLinkPlatformConfig;
    this.log.debug('Received configuration:', JSON.stringify(redact(config), null, 2));

    const appId = this.ewelinkConfig.appId?.trim() || process.env.EWELINK_APP_ID || BUILTIN_APP_ID;
    const appSecret = this.ewelinkConfig.appSecret?.trim() || process.env.EWELINK_APP_SECRET || BUILTIN_APP_SECRET;
    const redirectUrl = this.ewelinkConfig.redirectUrl?.trim() || BUILTIN_REDIRECT_URL;
    if (!appId || !appSecret) {
      throw new Error('This build has no eWeLink App ID/App Secret. Create an app at https://dev.ewelink.cc and enter it under the advanced settings.');
    }

    this.tokensFile = path.join(this.matterbridge.matterbridgePluginDirectory, 'matterbridge-ewelink', TOKENS_FILE);
    this.api = new EWeLinkApi({ appId, appSecret, redirectUrl, tokens: this.loadTokens(), onTokens: (tokens) => this.saveTokens(tokens) }, this.log);

    this.socket = new EWeLinkSocket({
      auth: () => this.api.socketAuth(),
      log: this.log,
      onUpdate: (deviceId, params) => void this.handleUpdate(deviceId, params),
      onOnline: (deviceId, online) => {
        const matterDevice = this.devices.get(deviceId);
        if (!matterDevice || matterDevice.device.online === online) return;
        matterDevice.device.online = online;
        this.log.info(`${matterDevice.name} is now ${online ? 'online' : 'offline'}.`);
        void this.applyState(matterDevice);
      },
    });

    const port = Number(this.ewelinkConfig.loginPort ?? DEFAULT_LOGIN_PORT);
    this.loginPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LOGIN_PORT;
    this.loginServer = new LoginServer({
      port: this.loginPort,
      api: this.api,
      log: this.log,
      onLogin: async () => {
        this.loginHintShown = false;
        await this.discoverDevices();
        this.startLiveUpdates(true);
      },
    });
    this.log.info(`eWeLink platform initialized (${this.api.isLoggedIn ? `logged in, region ${this.api.region}` : 'not logged in'}).`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    try {
      await this.loginServer.start();
      this.log.info(`eWeLink login page: ${this.loginUrls().join(' or ')}`);
    } catch (error) {
      this.log.error(
        `Could not start the eWeLink login page on port ${this.loginPort}: ${errorMessage(error)}. Choose another "loginPort" in the plugin config.`,
      );
    }

    if (this.api.isLoggedIn) await this.discoverDevices();
    else this.showLoginHint();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    this.configured = true;

    for (const matterDevice of this.devices.values()) await this.applyState(matterDevice);

    const interval = this.refreshIntervalSeconds();
    if (interval > 0) {
      this.log.info(`Refreshing device state every ${interval} seconds.`);
      this.refreshTimer = setInterval(() => void this.refreshStates(), interval * 1000);
      this.refreshTimer.unref?.();
    }
    if (this.api.isLoggedIn) this.startLiveUpdates(false);
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.socket.stop();
    await this.loginServer.stop();
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  // -------------------------------------------------------------------------------------------------
  // Login and discovery
  // -------------------------------------------------------------------------------------------------

  /** Load the device list and register devices that are not registered yet. */
  private async discoverDevices(): Promise<void> {
    let devices: EWeLinkDevice[];
    try {
      devices = await this.api.listDevices();
    } catch (error) {
      if (error instanceof EWeLinkNotLoggedInError) this.showLoginHint();
      else this.log.error(`Could not load eWeLink devices: ${errorMessage(error)}`);
      return;
    }
    this.log.info(`Discovered ${devices.length} eWeLink device(s).`);

    for (const device of devices) {
      if (this.devices.has(device.deviceid)) continue;
      try {
        await this.addDevice(device);
        const added = this.devices.get(device.deviceid);
        if (added && this.configured) await this.applyState(added);
      } catch (error) {
        this.log.error(`Failed to add eWeLink device ${device.name} (${device.deviceid}): ${errorMessage(error)}`);
      }
    }
  }

  private startLiveUpdates(restart: boolean): void {
    if (this.ewelinkConfig.liveUpdates === false) return;
    if (restart) this.socket.stop();
    this.socket.start();
  }

  private showLoginHint(): void {
    if (this.loginHintShown) return;
    this.loginHintShown = true;
    this.log.warn(`Not logged in to eWeLink. Open ${this.loginUrls().join(' or ')} in a browser on the same network to log in.`);
  }

  private loginUrls(): string[] {
    // Skip container and VPN bridges (docker0, br-xxxx, veth...) that phones can't reach
    const addresses = Object.entries(os.networkInterfaces())
      .filter(([name]) => !/^(docker|br-|veth|virbr|cni|flannel|tailscale|zt|lo)/.test(name))
      .flatMap(([, list]) => list ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => address.address);
    return (addresses.length ? addresses : ['<matterbridge-ip>']).map((address) => `http://${address}:${this.loginPort}`);
  }

  private loadTokens(): EWeLinkTokens | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.tokensFile, 'utf8')) as EWeLinkTokens;
    } catch {
      return undefined;
    }
  }

  private saveTokens(tokens: EWeLinkTokens | undefined): void {
    try {
      if (!tokens) {
        fs.rmSync(this.tokensFile, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(this.tokensFile), { recursive: true });
      fs.writeFileSync(this.tokensFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    } catch (error) {
      this.log.error(`Could not save the eWeLink login to ${this.tokensFile}: ${errorMessage(error)}`);
    }
  }

  private refreshIntervalSeconds(): number {
    const value = Number(this.ewelinkConfig.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_REFRESH_INTERVAL_S, Math.round(value));
  }

  // -------------------------------------------------------------------------------------------------
  // Matter devices
  // -------------------------------------------------------------------------------------------------

  private async addDevice(device: EWeLinkDevice): Promise<void> {
    const { name, deviceid } = device;
    const serial = `ewelink-${deviceid}`;
    const functions = deviceFunctions(device);
    if (functions.length === 0) {
      this.log.info(`Skipping ${name} (${deviceid}): eWeLink UIID ${device.uiid} is not supported yet.`);
      this.log.debug(`Params of ${name}: ${JSON.stringify(device.params)}`);
      return;
    }

    this.setSelectDevice(serial, name, undefined, 'hub');
    if (!this.validateDevice([name, serial, deviceid])) return;

    const matterDevice: EWeLinkMatterDevice = {
      device,
      name,
      functions,
      roots: [],
      endpoints: new Map(),
      lastTrigTime: device.params.trigTime ?? device.params.actionTime,
      subscriptions: [],
    };
    const state = deviceState(device, functions);
    matterDevice.coverReported = state.cover;

    const split = functions.length > 1 && (functions.every((fn) => fn.kind === 'security') || functions.some((fn) => SPLIT_KINDS.has(fn.kind)));
    if (split) {
      // Controllers like SmartThings don't show functions nested in one device, so these become separate
      // devices ("NSPanel Away Mode", "SNZB 06P Light", "iFan Light"). A first non-security function keeps
      // the device's own identity so it stays the same device in controllers.
      functions.forEach((fn, index) => {
        const own = fn.kind === 'security' || index > 0;
        const label = SECURITY_MODES.find((mode) => mode.id === fn.id)?.label ?? (fn.id === 'light' ? 'Light' : fn.id);
        const root = this.createRoot(device, own ? `${serial}-${fn.id}` : serial, own ? `${name} ${label}` : name, this.deviceTypes(device, fn));
        this.addFunction(matterDevice, root, fn, state);
        matterDevice.roots.push(root);
      });
    } else {
      const single = functions.length === 1;
      const root = this.createRoot(device, serial, name, single ? this.deviceTypes(device, functions[0]) : []);
      for (const fn of functions) {
        const endpoint = single
          ? root
          : root.addChildDeviceType(fn.id, this.deviceTypes(device, fn) as [DeviceTypeDefinition, ...DeviceTypeDefinition[]], {}, this.config.debug === true);
        this.addFunction(matterDevice, endpoint, fn, state);
      }
      matterDevice.roots.push(root);
    }

    for (const root of matterDevice.roots) {
      root.addRequiredClusterServers();
      await this.registerDevice(root);
    }
    for (const subscribe of matterDevice.subscriptions) subscribe();
    this.devices.set(deviceid, matterDevice);
    this.log.info(`Registered ${name} (${deviceid}, UIID ${device.uiid}) as ${functions.map(describe).join(', ')}${device.online ? '' : ' [offline]'}`);
  }

  /** A bridged Matter device with basic information, power source and identify. */
  private createRoot(device: EWeLinkDevice, serial: string, name: string, types: DeviceTypeDefinition[]): MatterbridgeEndpoint {
    const root = new MatterbridgeEndpoint(
      [...types, bridgedNode, powerSource] as DeviceTypeDefinition[] as [DeviceTypeDefinition, ...DeviceTypeDefinition[]],
      { id: serial },
      this.config.debug === true,
    )
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        0xfff1,
        device.brandName || 'eWeLink',
        device.productModel || `eWeLink UIID ${device.uiid}`,
        parseInt(this.version.replace(/\D/g, '')) || 1,
        this.version,
        1,
        device.fwVersion || '1.0.0',
      );
    if (BATTERY_UIIDS.has(device.uiid)) {
      root.createDefaultPowerSourceReplaceableBatteryClusterServer(100, PowerSource.BatChargeLevel.Ok, 3000, 'CR2032', 1);
    } else {
      root.createDefaultPowerSourceWiredClusterServer();
    }
    root.addCommandHandler('identify', ({ request }) => {
      this.log.info(`Identify request for ${name}: ${JSON.stringify(request)}`);
    });
    return root;
  }

  private deviceTypes(device: EWeLinkDevice, fn: DeviceFunction): DeviceTypeDefinition[] {
    switch (fn.kind) {
      case 'security':
        return [onOffPlugInUnit];
      case 'onOff': {
        const lights = this.ewelinkConfig.lightList ?? [];
        const base = fn.light || lights.includes(device.name) || lights.includes(device.deviceid) ? onOffLight : onOffPlugInUnit;
        return fn.energy ? [base, electricalSensor] : [base];
      }
      case 'temperature':
        return [temperatureSensor];
      case 'humidity':
        return [humiditySensor];
      case 'contact':
        return [contactSensor];
      case 'motion':
        return [occupancySensor];
      case 'illuminance':
        return [lightSensor];
      case 'light':
        return [fn.profile.color ? extendedColorLight : fn.profile.colorTemp ? colorTemperatureLight : dimmableLight];
      case 'cover':
        return [windowCovering];
      case 'fan':
        return [fan];
      case 'thermostat':
        return [thermostat];
      case 'button':
        return [genericSwitch];
      case 'leak':
        return [waterLeakDetector];
      case 'smoke':
        return [smokeCoAlarm];
    }
  }

  private addFunction(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: DeviceFunction, state: DeviceState): void {
    switch (fn.kind) {
      case 'onOff':
        endpoint.createDefaultOnOffClusterServer(state.onOff[fn.id] ?? false);
        if (fn.energy) {
          const power = state.power[fn.id] ?? {};
          endpoint
            .createDefaultPowerTopologyClusterServer()
            .createDefaultElectricalPowerMeasurementClusterServer(milli(power.voltage), milli(power.current), milli(power.power));
        }
        this.addOnOffHandlers(matterDevice, endpoint, fn);
        break;
      case 'security':
        endpoint.createDefaultOnOffClusterServer(state.onOff[fn.id] ?? false);
        this.addOnOffHandlers(matterDevice, endpoint, fn);
        break;
      case 'temperature':
        endpoint.createDefaultTemperatureMeasurementClusterServer(state.temperature === undefined ? null : Math.round(state.temperature * 100));
        break;
      case 'humidity':
        endpoint.createDefaultRelativeHumidityMeasurementClusterServer(state.humidity === undefined ? null : Math.round(state.humidity * 100));
        break;
      case 'contact':
        endpoint.createDefaultBooleanStateClusterServer(state.contact ?? true);
        break;
      case 'motion':
        endpoint.createDefaultOccupancySensingClusterServer(state.motion ?? false);
        break;
      case 'illuminance':
        endpoint.createDefaultIlluminanceMeasurementClusterServer(state.bright === undefined ? null : illuminanceValue(state.bright ? BRIGHT_LUX : DARK_LUX));
        break;
      case 'light':
        this.addLight(matterDevice, endpoint, fn.id, fn.profile, state.lights[fn.id] ?? {});
        break;
      case 'cover':
        endpoint.createDefaultWindowCoveringClusterServer(state.cover === undefined ? null : state.cover * 100);
        this.addCoverHandlers(matterDevice, endpoint, fn);
        break;
      case 'fan': {
        const percent = speedToPercent(state.fan ?? 0);
        endpoint.createBaseFanControlClusterServer(fanMode(state.fan ?? 0), FanControl.FanModeSequence.OffLowMedHigh, percent, percent);
        this.addFanHandlers(matterDevice, endpoint, fn);
        break;
      }
      case 'thermostat': {
        const t = state.thermostat ?? {};
        endpoint.createDefaultHeatingThermostatClusterServer(t.current ?? 20, t.target ?? 20, fn.profile.min, fn.profile.max);
        this.addThermostatHandlers(matterDevice, endpoint, fn);
        break;
      }
      case 'button':
        endpoint.createDefaultSwitchClusterServer();
        break;
      case 'leak':
        endpoint.createDefaultBooleanStateClusterServer(state.leak ?? false);
        break;
      case 'smoke':
        endpoint.createSmokeOnlySmokeCOAlarmClusterServer(state.smoke ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal);
        break;
    }
    endpoint.addRequiredClusterServers();
    matterDevice.endpoints.set(fn.id, endpoint);
  }

  // -------------------------------------------------------------------------------------------------
  // Commands from Matter
  // -------------------------------------------------------------------------------------------------

  /**
   * Send params to a device in order and remember them. Throwing makes the Matter command fail, so
   * controllers show the error and keep the previous state.
   */
  private async send(matterDevice: EWeLinkMatterDevice, label: string, action: string, messages: EWeLinkParams[]): Promise<void> {
    if (messages.length === 0) return;
    this.log.info(`${label}: ${action}...`);
    try {
      if (!matterDevice.device.online) throw new Error('the device is offline in eWeLink');
      for (const params of messages) {
        await this.api.setParams(matterDevice.device.deviceid, params);
        matterDevice.device.params = mergeParams(matterDevice.device.params, params);
      }
      this.log.info(`${label}: ${action} done.`);
    } catch (error) {
      this.log.error(`${label}: ${action} failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  private label(matterDevice: EWeLinkMatterDevice, fn: DeviceFunction): string {
    return matterDevice.functions.length > 1 ? `${matterDevice.name} ${fn.id}` : matterDevice.name;
  }

  private addOnOffHandlers(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: DeviceFunction): void {
    const switchTo = async (on: boolean): Promise<void> => {
      const params = onOffParams(fn, on, matterDevice.device.params);
      await this.send(matterDevice, this.label(matterDevice, fn), on ? 'turn on' : 'turn off', params ? [params] : []);
      // Arming one security mode disarms the others; update their switches once this command is done
      if (fn.kind === 'security') setImmediate(() => void this.applyState(matterDevice));
    };
    endpoint.addCommandHandler('on', () => switchTo(true));
    endpoint.addCommandHandler('off', () => switchTo(false));
    endpoint.addCommandHandler('toggle', () => switchTo(endpoint.getAttribute(OnOff.Cluster.id, 'onOff') !== true));
  }

  private addLight(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, id: string, profile: LightProfile, state: LightState): void {
    endpoint.createDefaultOnOffClusterServer(state.on ?? false);
    endpoint.createDefaultLevelControlClusterServer(toLevel(state.brightness ?? 100));
    const ct = profile.colorTemp;
    if (profile.color) {
      const hs = state.color ?? { h: 0, s: 0 };
      endpoint.createDefaultColorControlClusterServer(
        undefined,
        undefined,
        toMatterHue(hs.h),
        toMatterSat(hs.s),
        kelvinToMireds(state.kelvin ?? ct?.max ?? 4000),
        ct ? kelvinToMireds(ct.max) : 147,
        ct ? kelvinToMireds(ct.min) : 500,
      );
    } else if (ct) {
      endpoint.createCtColorControlClusterServer(kelvinToMireds(state.kelvin ?? ct.max), kelvinToMireds(ct.max), kelvinToMireds(ct.min));
    }

    const label = matterDevice.functions.length > 1 ? `${matterDevice.name} ${id}` : matterDevice.name;
    const command = async (cmd: LightCommand, action: string) => {
      const current = profile.read(matterDevice.device.params);
      await this.send(matterDevice, label, action, profile.write(cmd, current));
    };
    const hueSat = (attributes: unknown): HueSat => {
      const a = attributes as { currentHue?: number; currentSaturation?: number };
      return { h: fromMatterHue(a.currentHue ?? 0), s: fromMatterSat(a.currentSaturation ?? 0) };
    };

    endpoint.addCommandHandler('on', () => command({ on: true }, 'turn on'));
    endpoint.addCommandHandler('off', () => command({ on: false }, 'turn off'));
    endpoint.addCommandHandler('toggle', () => {
      const on = endpoint.getAttribute(OnOff.Cluster.id, 'onOff') !== true;
      return command({ on }, on ? 'turn on' : 'turn off');
    });
    const level = (request: { level: number }, withOnOff: boolean) =>
      withOnOff && request.level <= 1
        ? command({ on: false }, 'turn off')
        : command({ brightness: fromLevel(request.level) }, `set brightness ${fromLevel(request.level)}%`);
    endpoint.addCommandHandler('moveToLevel', ({ request }) => level(request, false));
    endpoint.addCommandHandler('moveToLevelWithOnOff', ({ request }) => level(request, true));
    if (!profile.color && !ct) return;
    endpoint.addCommandHandler('moveToColorTemperature', ({ request }) => {
      const kelvin = miredsToKelvin(request.colorTemperatureMireds);
      return command({ kelvin }, `set colour temperature ${kelvin}K`);
    });
    if (!profile.color) return;
    const setColor = (color: HueSat) => command({ color }, `set colour hue ${Math.round(color.h)} saturation ${Math.round(color.s)}%`);
    endpoint.addCommandHandler('moveToHueAndSaturation', ({ request }) => setColor({ h: fromMatterHue(request.hue), s: fromMatterSat(request.saturation) }));
    endpoint.addCommandHandler('moveToHue', ({ request, attributes }) => setColor({ ...hueSat(attributes), h: fromMatterHue(request.hue) }));
    endpoint.addCommandHandler('moveToSaturation', ({ request, attributes }) => setColor({ ...hueSat(attributes), s: fromMatterSat(request.saturation) }));
    endpoint.addCommandHandler('moveToColor', ({ request }) => setColor(xyToHs(request.colorX / 65536, request.colorY / 65536)));
  }

  private addCoverHandlers(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: Extract<DeviceFunction, { kind: 'cover' }>): void {
    const label = matterDevice.name;
    const act = (action: CoverAction) => this.send(matterDevice, label, action, [fn.profile.action(action)]);
    endpoint.addCommandHandler('upOrOpen', () => act('open'));
    endpoint.addCommandHandler('downOrClose', () => act('close'));
    endpoint.addCommandHandler('stopMotion', () => act('stop'));
    endpoint.addCommandHandler('goToLiftPercentage', ({ request }) => {
      const closed = Math.round(request.liftPercent100thsValue / 100);
      if (!fn.profile.position) return act(closed >= 50 ? 'close' : 'open');
      return this.send(matterDevice, label, `move to ${100 - closed}% open`, [fn.profile.position(closed)]);
    });
  }

  private addFanHandlers(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: Extract<DeviceFunction, { kind: 'fan' }>): void {
    // Controllers write fanMode or percentSetting; the fan server keeps the two in sync, so percentSetting covers both
    matterDevice.subscriptions.push(() =>
      endpoint.subscribeAttribute(
        FanControl.Cluster.id,
        'percentSetting',
        (value: number | null) => {
          const speed = percentToSpeed(value ?? 0);
          if (speed === fn.profile.read(matterDevice.device.params)) return;
          this.send(matterDevice, this.label(matterDevice, fn), speed ? `set speed ${speed}` : 'turn off', [fn.profile.write(speed)]).catch(() => {
            // Restore what the fan really does
            void this.applyState(matterDevice);
          });
        },
        endpoint.log,
      ),
    );
  }

  private addThermostatHandlers(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: Extract<DeviceFunction, { kind: 'thermostat' }>): void {
    const label = matterDevice.name;
    const restore = () => void this.applyState(matterDevice);
    matterDevice.subscriptions.push(() =>
      endpoint.subscribeAttribute(
        Thermostat.Cluster.id,
        'occupiedHeatingSetpoint',
        (value: number) => {
          const target = Math.round(value / 50) / 2;
          const reported = fn.profile.read(matterDevice.device.params).target;
          if (reported !== undefined && Math.abs(reported - target) < 0.05) return;
          this.send(matterDevice, label, `set target ${target}°C`, [fn.profile.setTarget(target, matterDevice.device.params)]).catch(restore);
        },
        endpoint.log,
      ),
    );
    matterDevice.subscriptions.push(() =>
      endpoint.subscribeAttribute(
        Thermostat.Cluster.id,
        'systemMode',
        (value: number) => {
          const on = value !== Thermostat.SystemMode.Off;
          if (fn.profile.read(matterDevice.device.params).on === on) return;
          this.send(matterDevice, label, on ? 'turn on' : 'turn off', [fn.profile.power(on)]).catch(restore);
        },
        endpoint.log,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------------
  // State from eWeLink
  // -------------------------------------------------------------------------------------------------

  /** A live update from the eWeLink WebSocket: only the params that changed. */
  private async handleUpdate(deviceId: string, params: EWeLinkParams): Promise<void> {
    const matterDevice = this.devices.get(deviceId);
    if (!matterDevice) return;
    const button = matterDevice.functions.find((fn) => fn.kind === 'button');
    if (button) {
      const press = buttonPress(params, matterDevice.lastTrigTime);
      if (press) {
        matterDevice.lastTrigTime = params.trigTime ?? params.actionTime;
        this.log.info(`${matterDevice.name}: ${press.toLowerCase()} press.`);
        await matterDevice.endpoints.get(button.id)?.triggerSwitchEvent(press, this.log);
      }
    }
    matterDevice.device.params = mergeParams(matterDevice.device.params, params);
    if (typeof params.online === 'boolean') matterDevice.device.online = params.online;
    await this.applyState(matterDevice);
  }

  /** Poll the device list and push changes (made in the eWeLink app, by hand or by automations) to Matter. */
  private async refreshStates(): Promise<void> {
    if (this.refreshing || this.devices.size === 0) return;
    // Live updates bring changes as they happen; then polling is only a safety net
    if (this.socket.isConnected && Date.now() - this.lastPoll < LIVE_POLL_INTERVAL_MS) return;
    this.refreshing = true;
    try {
      const devices = await this.api.listDevices();
      this.lastPoll = Date.now();
      for (const device of devices) {
        const matterDevice = this.devices.get(device.deviceid);
        if (!matterDevice) continue;
        matterDevice.device = device;
        await this.applyState(matterDevice);
      }
    } catch (error) {
      if (error instanceof EWeLinkNotLoggedInError) this.showLoginHint();
      else this.log.warn(`Failed to refresh eWeLink devices: ${errorMessage(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private async applyState(matterDevice: EWeLinkMatterDevice): Promise<void> {
    const { device, roots, name } = matterDevice;
    const state = deviceState(device, matterDevice.functions);
    try {
      for (const bridged of roots) await update(bridged, BridgedDeviceBasicInformation.Cluster.id, 'reachable', device.online);
      for (const fn of matterDevice.functions) {
        const endpoint = matterDevice.endpoints.get(fn.id)!;
        switch (fn.kind) {
          case 'onOff':
          case 'security':
            if (state.onOff[fn.id] !== undefined) await update(endpoint, OnOff.Cluster.id, 'onOff', state.onOff[fn.id]);
            if (fn.kind === 'onOff' && fn.energy) {
              const power = state.power[fn.id] ?? {};
              if (power.voltage !== undefined) await update(endpoint, ElectricalPowerMeasurement.Cluster.id, 'voltage', milli(power.voltage)!);
              if (power.current !== undefined) await update(endpoint, ElectricalPowerMeasurement.Cluster.id, 'activeCurrent', milli(power.current)!);
              if (power.power !== undefined) await update(endpoint, ElectricalPowerMeasurement.Cluster.id, 'activePower', milli(power.power)!);
            }
            break;
          case 'temperature':
            if (state.temperature !== undefined)
              await update(endpoint, TemperatureMeasurement.Cluster.id, 'measuredValue', Math.round(state.temperature * 100));
            break;
          case 'humidity':
            if (state.humidity !== undefined) await update(endpoint, RelativeHumidityMeasurement.Cluster.id, 'measuredValue', Math.round(state.humidity * 100));
            break;
          case 'contact':
            if (state.contact !== undefined) await update(endpoint, BooleanState.Cluster.id, 'stateValue', state.contact);
            break;
          case 'motion':
            if (state.motion !== undefined) {
              const current = endpoint.getAttribute(OccupancySensing.Cluster.id, 'occupancy') as { occupied?: boolean } | undefined;
              if (current?.occupied !== state.motion)
                await endpoint.setAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: state.motion }, endpoint.log);
            }
            break;
          case 'illuminance':
            if (state.bright !== undefined)
              await update(endpoint, IlluminanceMeasurement.Cluster.id, 'measuredValue', illuminanceValue(state.bright ? BRIGHT_LUX : DARK_LUX));
            break;
          case 'light':
            await this.applyLight(endpoint, fn.profile, state.lights[fn.id] ?? {});
            break;
          case 'cover':
            // Only follow positions eWeLink reports, so the echo of a command doesn't reset a moving curtain
            if (state.cover !== undefined && state.cover !== matterDevice.coverReported) {
              matterDevice.coverReported = state.cover;
              await endpoint.setWindowCoveringTargetAndCurrentPosition(state.cover * 100);
            }
            break;
          case 'fan':
            if (state.fan !== undefined) {
              const percent = speedToPercent(state.fan);
              if (percentToSpeed(endpoint.getAttribute(FanControl.Cluster.id, 'percentSetting') ?? 0) !== state.fan) {
                await update(endpoint, FanControl.Cluster.id, 'percentSetting', percent);
              }
              await update(endpoint, FanControl.Cluster.id, 'percentCurrent', percent);
              await update(endpoint, FanControl.Cluster.id, 'fanMode', fanMode(state.fan));
            }
            break;
          case 'thermostat': {
            const t = state.thermostat ?? {};
            if (t.current !== undefined) await update(endpoint, Thermostat.Cluster.id, 'localTemperature', Math.round(t.current * 100));
            if (t.target !== undefined) await update(endpoint, Thermostat.Cluster.id, 'occupiedHeatingSetpoint', Math.round(t.target * 100));
            if (t.on !== undefined) await update(endpoint, Thermostat.Cluster.id, 'systemMode', t.on ? Thermostat.SystemMode.Heat : Thermostat.SystemMode.Off);
            if (t.heating !== undefined) {
              const running = endpoint.getAttribute(Thermostat.Cluster.id, 'thermostatRunningState') as { heat?: boolean } | undefined;
              if (running && running.heat !== t.heating) {
                await endpoint.setAttribute(Thermostat.Cluster.id, 'thermostatRunningState', { ...running, heat: t.heating }, endpoint.log);
              }
            }
            break;
          }
          case 'leak':
            if (state.leak !== undefined) await update(endpoint, BooleanState.Cluster.id, 'stateValue', state.leak);
            break;
          case 'smoke':
            if (state.smoke !== undefined) {
              const alarm = state.smoke ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal;
              await update(endpoint, SmokeCoAlarm.Cluster.id, 'smokeState', alarm);
              await update(
                endpoint,
                SmokeCoAlarm.Cluster.id,
                'expressedState',
                state.smoke ? SmokeCoAlarm.ExpressedState.SmokeAlarm : SmokeCoAlarm.ExpressedState.Normal,
              );
            }
            break;
          case 'button':
            break;
        }
      }
      if (state.battery !== undefined) {
        for (const root of roots) {
          await update(root, PowerSource.Cluster.id, 'batPercentRemaining', state.battery * 2);
          await update(root, PowerSource.Cluster.id, 'batChargeLevel', chargeLevel(state.battery));
          await update(root, PowerSource.Cluster.id, 'batReplacementNeeded', state.battery <= LOW_BATTERY_PERCENT);
        }
      }
    } catch (error) {
      this.log.debug(`Could not update ${name}: ${errorMessage(error)}`);
    }
  }

  private async applyLight(endpoint: MatterbridgeEndpoint, profile: LightProfile, light: LightState): Promise<void> {
    if (light.on !== undefined) await update(endpoint, OnOff.Cluster.id, 'onOff', light.on);
    if (light.brightness !== undefined) await update(endpoint, LevelControl.Cluster.id, 'currentLevel', toLevel(light.brightness));
    if (!profile.color && !profile.colorTemp) return;
    if (light.mode !== 'color' && light.kelvin !== undefined) {
      await update(endpoint, ColorControl.Cluster.id, 'colorTemperatureMireds', kelvinToMireds(light.kelvin));
      if (profile.color) await update(endpoint, ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds);
    }
    if (profile.color && light.mode !== 'white' && light.color) {
      await update(endpoint, ColorControl.Cluster.id, 'currentHue', toMatterHue(light.color.h));
      await update(endpoint, ColorControl.Cluster.id, 'currentSaturation', toMatterSat(light.color.s));
      await update(endpoint, ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
    }
  }
}

type ClusterIdArg = Parameters<MatterbridgeEndpoint['setAttribute']>[0];

/** Set an attribute only when it changed, to avoid flooding controllers with identical reports. */
async function update(endpoint: MatterbridgeEndpoint, clusterId: ClusterIdArg, attribute: string, value: boolean | number): Promise<void> {
  if (endpoint.getAttribute(clusterId, attribute) === value) return;
  await endpoint.setAttribute(clusterId, attribute, value, endpoint.log);
}

function describe(fn: DeviceFunction): string {
  if (fn.kind === 'light') return `${fn.id} (${fn.profile.color ? 'colour' : fn.profile.colorTemp ? 'white tunable' : 'dimmable'} light)`;
  if (fn.kind === 'onOff' && fn.energy) return `${fn.id} (with power monitoring)`;
  return fn.id;
}

/** Brightness 1-100 to a Matter level 1-254 and back. */
function toLevel(percent: number): number {
  return Math.max(1, Math.min(254, Math.round((percent * 254) / 100)));
}

function fromLevel(level: number): number {
  return Math.max(1, Math.min(100, Math.round((level * 100) / 254)));
}

/** Hue 0-360 / saturation 0-100 to Matter's 0-254 and back. */
function toMatterHue(hue: number): number {
  return Math.max(0, Math.min(254, Math.round((hue * 254) / 360)));
}

function fromMatterHue(hue: number): number {
  return (hue * 360) / 254;
}

function toMatterSat(saturation: number): number {
  return Math.max(0, Math.min(254, Math.round((saturation * 254) / 100)));
}

function fromMatterSat(saturation: number): number {
  return (saturation * 100) / 254;
}

function fanMode(speed: number): FanControl.FanMode {
  return [FanControl.FanMode.Off, FanControl.FanMode.Low, FanControl.FanMode.Medium, FanControl.FanMode.High][Math.max(0, Math.min(3, speed))];
}

/** Volts, amps or watts to the milli-units Matter uses. */
function milli(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value * 1000);
}

function chargeLevel(percent: number): PowerSource.BatChargeLevel {
  if (percent > LOW_BATTERY_PERCENT) return PowerSource.BatChargeLevel.Ok;
  return percent > CRITICAL_BATTERY_PERCENT ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Critical;
}

function redact(config: PlatformConfig): PlatformConfig {
  const copy: PlatformConfig = { ...config };
  for (const key of SENSITIVE_KEYS) if (copy[key]) copy[key] = '********';
  return copy;
}
