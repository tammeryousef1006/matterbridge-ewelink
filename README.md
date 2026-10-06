# Matterbridge eWeLink Plugin

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that brings your eWeLink (Sonoff) devices to Matter, so you can control them from Apple Home, Google Home, Alexa, Home Assistant, SmartThings and any other Matter controller.

## Features

- Signs in with your eWeLink email, password and country code. The account's region (EU/US/Asia/China) is detected automatically.
- Discovers every device on your account, including devices shared with you.
- Changes made in the eWeLink app, with a wall button or by eWeLink scenes are picked up by polling.
- Offline devices show as "not responding" in your controller.
- Choose which devices to expose with a whitelist/blacklist, and expose any switch as a light instead of an outlet.

## Supported devices

| Device | Examples | Exposed as |
|--------|----------|------------|
| Single channel switches and plugs | BASIC/BASICR2/RFR2, MINI/MINIR2, S26/S40, POW, M5 1C | Outlet (or light) |
| Multi channel switches | DUALR3, 4CH Pro, T1/TX 2C/3C, M5 2C/3C | One outlet per channel |
| Temperature/humidity switches | TH10, TH16, THR316/THR320 | Outlet + temperature + humidity sensor |
| Zigbee temperature/humidity sensor | SNZB-02 | Temperature + humidity sensor with battery |
| Zigbee door/window sensor | SNZB-04 | Contact sensor with battery |
| Zigbee motion sensor | SNZB-03 | Occupancy sensor with battery |

Other devices are skipped and logged with their UIID. Open an issue with the UIID and the device's params from the debug log to get one added.

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) 3.0.0 or later
- Node.js 20 or later
- An eWeLink account with your devices added in the eWeLink app

## Installation

```bash
npm install -g matterbridge-ewelink
matterbridge -add matterbridge-ewelink
```

Or install it from the Matterbridge frontend by searching for `matterbridge-ewelink`.

## Configuration

Open the plugin config in the Matterbridge frontend and enter:

| Option | Required | Description |
|--------|----------|-------------|
| `email` | Yes | The email you use to sign in to the eWeLink app |
| `password` | Yes | Your eWeLink password |
| `countryCode` | Yes | Phone country code of your account, e.g. `+1`, `+44`, `+20`, `+971` |
| `refreshInterval` | No | Seconds between state refreshes (default `60`, minimum `15`, `0` disables) |
| `lightList` | No | Switches (names or device IDs) to expose as lights instead of outlets |
| `whiteList` | No | Only expose devices with these names or device IDs |
| `blackList` | No | Never expose devices with these names or device IDs |
| `appId` / `appSecret` | No | Advanced: your own eWeLink developer app from https://dev.ewelink.cc |
| `debug` | No | Enable debug logging |

Example:

```json
{
  "name": "matterbridge-ewelink",
  "type": "DynamicPlatform",
  "email": "you@example.com",
  "password": "your-password",
  "countryCode": "+1"
}
```

> **Note:** eWeLink allows one session per app per account. Signing in to eWeLink with the same App ID somewhere else (for example a second Matterbridge, or Home Assistant using the same app) signs this plugin out. The plugin then signs in again automatically on its next request.

## Troubleshooting

- **"wrong account or password"**: check the email, password and country code. The country code must be the one chosen when the account was created.
- **A device is skipped as unsupported**: enable `debug`, restart, and include the logged UIID in an issue.
- **A command fails with "device is offline"**: the device is not connected to the eWeLink cloud. Check its Wi-Fi or Zigbee bridge.

## For maintainers: the built-in eWeLink app

eWeLink only accepts API calls from a registered developer app. To let users sign in with just their email, password and country code, the plugin ships with a built-in App ID and App Secret:

1. Create an app at https://dev.ewelink.cc (choose a role that allows account login with email/password).
2. Put its App ID and App Secret in `DEFAULT_APP_ID` and `DEFAULT_APP_SECRET` in `src/platform.ts`.
3. Build and publish.

Users can override them with the advanced `appId` / `appSecret` options.

## Development

```bash
npm install
npm install --no-save matterbridge   # provided by Matterbridge at runtime
npm test
```

## License

ISC
