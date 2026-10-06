import {
  DeviceTypeDefinition,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  PlatformMatterbridge,
  bridgedNode,
  contactSensor,
  humiditySensor,
  lightSensor,
  occupancySensor,
  onOffLight,
  onOffPlugInUnit,
  powerSource,
  temperatureSensor,
} from 'matterbridge';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AnsiLogger } from 'matterbridge/logger';
import {
  BooleanState,
  BridgedDeviceBasicInformation,
  IlluminanceMeasurement,
  OccupancySensing,
  OnOff,
  PowerSource,
  RelativeHumidityMeasurement,
  TemperatureMeasurement,
} from 'matterbridge/matter/clusters';

import { BATTERY_UIIDS, BRIGHT_LUX, DARK_LUX, SECURITY_MODES, DeviceFunction, illuminanceValue, DeviceState, deviceFunctions, deviceState, mergeParams, onOffParams } from './deviceMapper.js';
import { BUILTIN_APP_ID, BUILTIN_APP_SECRET, BUILTIN_REDIRECT_URL } from './credentials.js';
import { EWeLinkApi, EWeLinkDevice, EWeLinkNotLoggedInError, EWeLinkTokens, errorMessage } from './ewelinkApi.js';
import { LoginServer } from './loginServer.js';

export interface EWeLinkPlatformConfig extends PlatformConfig {
  loginPort?: number;
  appId?: string;
  appSecret?: string;
  redirectUrl?: string;
  refreshInterval?: number;
  lightList?: string[];
  whiteList?: string[];
  blackList?: string[];
}

interface EWeLinkMatterDevice {
  device: EWeLinkDevice;
  name: string;
  functions: DeviceFunction[];
  /** Bridged Matter devices: one, or one per security mode for panels and bridges. */
  roots: MatterbridgeEndpoint[];
  /** Endpoint holding each function: the root for single-function devices, a child endpoint otherwise. */
  endpoints: Map<string, MatterbridgeEndpoint>;
}

const DEFAULT_REFRESH_INTERVAL_S = 60;
const MIN_REFRESH_INTERVAL_S = 15;
const LOW_BATTERY_PERCENT = 20;
const CRITICAL_BATTERY_PERCENT = 10;
const DEFAULT_LOGIN_PORT = 8284;
const SENSITIVE_KEYS = ['appSecret'];
const TOKENS_FILE = 'tokens.json';

export class EWeLinkPlatform extends MatterbridgeDynamicPlatform {
  private readonly ewelinkConfig: EWeLinkPlatformConfig;
  private readonly api: EWeLinkApi;
  private readonly loginServer: LoginServer;
  private readonly loginPort: number;
  private readonly tokensFile: string;
  private readonly devices = new Map<string, EWeLinkMatterDevice>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
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
    this.api = new EWeLinkApi(
      { appId, appSecret, redirectUrl, tokens: this.loadTokens(), onTokens: (tokens) => this.saveTokens(tokens) },
      this.log,
    );

    const port = Number(this.ewelinkConfig.loginPort ?? DEFAULT_LOGIN_PORT);
    this.loginPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LOGIN_PORT;
    this.loginServer = new LoginServer({
      port: this.loginPort,
      api: this.api,
      log: this.log,
      onLogin: async () => {
        this.loginHintShown = false;
        await this.discoverDevices();
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
      this.log.error(`Could not start the eWeLink login page on port ${this.loginPort}: ${errorMessage(error)}. Choose another "loginPort" in the plugin config.`);
    }

    if (this.api.isLoggedIn) await this.discoverDevices();
    else this.showLoginHint();
  }

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
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await this.loginServer.stop();
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private refreshIntervalSeconds(): number {
    const value = Number(this.ewelinkConfig.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_REFRESH_INTERVAL_S, Math.round(value));
  }

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

    const matterDevice: EWeLinkMatterDevice = { device, name, functions, roots: [], endpoints: new Map() };
    const state = deviceState(device, functions);

    if (functions.every((fn) => fn.kind === 'security') || functions.some((fn) => fn.kind === 'light')) {
      // Controllers like SmartThings don't show functions nested in one device, so these become separate
      // devices ("NSPanel Away Mode", "SNZB 06P Light"). A first non-security function keeps the device's
      // own identity so it stays the same device in controllers.
      functions.forEach((fn, index) => {
        const own = fn.kind === 'security' || index > 0;
        const label = SECURITY_MODES.find((mode) => mode.id === fn.id)?.label ?? (fn.kind === 'light' ? 'Light' : fn.id);
        const root = this.createRoot(device, own ? `${serial}-${fn.id}` : serial, own ? `${name} ${label}` : name, [this.deviceType(device, fn)]);
        this.addFunction(matterDevice, root, fn, state);
        matterDevice.roots.push(root);
      });
    } else {
      const single = functions.length === 1;
      const root = this.createRoot(device, serial, name, single ? [this.deviceType(device, functions[0])] : []);
      for (const fn of functions) {
        const endpoint = single ? root : root.addChildDeviceType(fn.id, [this.deviceType(device, fn)], {}, this.config.debug === true);
        this.addFunction(matterDevice, endpoint, fn, state);
      }
      matterDevice.roots.push(root);
    }

    for (const root of matterDevice.roots) {
      root.addRequiredClusterServers();
      await this.registerDevice(root);
    }
    this.devices.set(deviceid, matterDevice);
    this.log.info(`Registered ${name} (${deviceid}, UIID ${device.uiid}) as ${functions.map((fn) => fn.id).join(', ')}${device.online ? '' : ' [offline]'}`);
  }

  /** A bridged Matter device with basic information, power source and identify. */
  private createRoot(device: EWeLinkDevice, serial: string, name: string, types: DeviceTypeDefinition[]): MatterbridgeEndpoint {
    const root = new MatterbridgeEndpoint([...types, bridgedNode, powerSource] as DeviceTypeDefinition[] as [DeviceTypeDefinition, ...DeviceTypeDefinition[]], { id: serial }, this.config.debug === true)
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

  private addFunction(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: DeviceFunction, state: DeviceState): void {
    this.addFunctionClusters(endpoint, fn, state);
    if (fn.kind === 'onOff' || fn.kind === 'security') this.addOnOffHandlers(matterDevice, endpoint, fn);
    endpoint.addRequiredClusterServers();
    matterDevice.endpoints.set(fn.id, endpoint);
  }

  private deviceType(device: EWeLinkDevice, fn: DeviceFunction): DeviceTypeDefinition {
    switch (fn.kind) {
      case 'security':
        return onOffPlugInUnit;
      case 'onOff': {
        const lights = this.ewelinkConfig.lightList ?? [];
        return lights.includes(device.name) || lights.includes(device.deviceid) ? onOffLight : onOffPlugInUnit;
      }
      case 'temperature':
        return temperatureSensor;
      case 'humidity':
        return humiditySensor;
      case 'contact':
        return contactSensor;
      case 'motion':
        return occupancySensor;
      case 'light':
        return lightSensor;
    }
  }

  private addFunctionClusters(endpoint: MatterbridgeEndpoint, fn: DeviceFunction, state: DeviceState): void {
    switch (fn.kind) {
      case 'onOff':
      case 'security':
        endpoint.createDefaultOnOffClusterServer(state.onOff[fn.id] ?? false);
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
      case 'light':
        endpoint.createDefaultIlluminanceMeasurementClusterServer(state.bright === undefined ? null : illuminanceValue(state.bright ? BRIGHT_LUX : DARK_LUX));
        break;
    }
  }

  private addOnOffHandlers(matterDevice: EWeLinkMatterDevice, endpoint: MatterbridgeEndpoint, fn: DeviceFunction): void {
    // Throwing from a handler fails the Matter command, so controllers show the error
    // and the on/off state is left unchanged.
    const switchTo = async (on: boolean): Promise<void> => {
      const label = matterDevice.functions.length > 1 ? `${matterDevice.name} ${fn.id}` : matterDevice.name;
      this.log.info(`Turning ${label} ${on ? 'on' : 'off'}...`);
      try {
        if (!matterDevice.device.online) throw new Error('the device is offline in eWeLink');
        const params = onOffParams(fn, on, matterDevice.device.params);
        if (!params) return;
        await this.api.setParams(matterDevice.device.deviceid, params);
        matterDevice.device.params = mergeParams(matterDevice.device.params, params);
        this.log.info(`${label} turned ${on ? 'on' : 'off'}.`);
        // Arming one security mode disarms the others; update their switches once this command is done
        if (fn.kind === 'security') setImmediate(() => void this.applyState(matterDevice));
      } catch (error) {
        this.log.error(`Failed to turn ${label} ${on ? 'on' : 'off'}: ${errorMessage(error)}`);
        throw error;
      }
    };
    endpoint.addCommandHandler('on', () => switchTo(true));
    endpoint.addCommandHandler('off', () => switchTo(false));
    endpoint.addCommandHandler('toggle', () => switchTo(endpoint.getAttribute(OnOff.Cluster.id, 'onOff') !== true));
  }

  /** Poll the device list and push changes (made in the eWeLink app, by hand or by automations) to Matter. */
  private async refreshStates(): Promise<void> {
    if (this.refreshing || this.devices.size === 0) return;
    this.refreshing = true;
    try {
      const devices = await this.api.listDevices();
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
    const root = roots[0];
    const state = deviceState(device, matterDevice.functions);
    try {
      for (const bridged of roots) await update(bridged, BridgedDeviceBasicInformation.Cluster.id, 'reachable', device.online);
      for (const fn of matterDevice.functions) {
        const endpoint = matterDevice.endpoints.get(fn.id)!;
        switch (fn.kind) {
          case 'onOff':
          case 'security':
            if (state.onOff[fn.id] !== undefined) await update(endpoint, OnOff.Cluster.id, 'onOff', state.onOff[fn.id]);
            break;
          case 'temperature':
            if (state.temperature !== undefined) await update(endpoint, TemperatureMeasurement.Cluster.id, 'measuredValue', Math.round(state.temperature * 100));
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
              if (current?.occupied !== state.motion) await endpoint.setAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: state.motion }, endpoint.log);
            }
            break;
          case 'light':
            if (state.bright !== undefined) await update(endpoint, IlluminanceMeasurement.Cluster.id, 'measuredValue', illuminanceValue(state.bright ? BRIGHT_LUX : DARK_LUX));
            break;
        }
      }
      if (state.battery !== undefined) {
        await update(root, PowerSource.Cluster.id, 'batPercentRemaining', state.battery * 2);
        await update(root, PowerSource.Cluster.id, 'batChargeLevel', chargeLevel(state.battery));
        await update(root, PowerSource.Cluster.id, 'batReplacementNeeded', state.battery <= LOW_BATTERY_PERCENT);
      }
    } catch (error) {
      this.log.debug(`Could not update ${name}: ${errorMessage(error)}`);
    }
  }
}

type ClusterIdArg = Parameters<MatterbridgeEndpoint['setAttribute']>[0];

/** Set an attribute only when it changed, to avoid flooding controllers with identical reports. */
async function update(endpoint: MatterbridgeEndpoint, clusterId: ClusterIdArg, attribute: string, value: boolean | number): Promise<void> {
  if (endpoint.getAttribute(clusterId, attribute) === value) return;
  await endpoint.setAttribute(clusterId, attribute, value, endpoint.log);
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
