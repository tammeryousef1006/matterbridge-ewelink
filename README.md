# Matterbridge eWeLink Plugin

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/6sjde6vkzl)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that brings your eWeLink (Sonoff) devices to Matter, so you can control them from Apple Home, Google Home, Alexa, Home Assistant, SmartThings and any other Matter controller.

## Features

- Log in once in your browser on eWeLink's own login page. No developer account and no settings to fill in; the login is renewed automatically.
- Discovers every device on your account, including devices shared with you.
- Live updates: changes made in the eWeLink app, with a wall switch or by eWeLink scenes show up in Matter right away (with polling as a fallback).
- Offline devices show as "not responding" in your controller.
- Choose which devices to expose with a whitelist/blacklist, and expose any switch as a light instead of an outlet.

## Supported devices

**Tested with real devices:**

| Device | Examples | Exposed as |
|--------|----------|------------|
| Single channel switches and plugs | BASIC/BASICR2/RFR2, MINI/MINIR2, S26/S40, M5 1C | Outlet (or light) |
| Multi channel switches | DUALR3, 4CH Pro, T1/TX 2C/3C, TX Ultimate T5 1C–4C, M5 2C/3C, NSPanel | One outlet per channel |
| Temperature/humidity switches | TH10, TH16, THR316/THR320 | Outlet + temperature + humidity sensor (when a probe is connected) |
| Zigbee presence sensor | SNZB-06P | Occupancy sensor, plus a separate light sensor ("SNZB 06P Light": ~300 lux when bright, ~5 lux when dark) |
| Security modes | NSPanel Pro | Three separate switches, e.g. "NSPanel Away Mode"; turning one on arms that mode, turning it off disarms |
| Virtual switches | eWeLink virtual switches | Outlet |

**Supported from the eWeLink protocol, not yet tested with real devices** (please [report](https://github.com/tammeryousef1006/matterbridge-ewelink/issues) what works and what doesn't):

| Device | Examples | Exposed as |
|--------|----------|------------|
| Zigbee sensors | SNZB-02/02D temperature/humidity, SNZB-03 motion, SNZB-04 door/window | Sensors with battery |
| Dimmers | D1, KING-M4, MINI-DIM | Dimmable light |
| White bulbs | B02 (B02-F, B02-BL), Zigbee CCT lights | White light with brightness and colour temperature |
| Colour bulbs and strips | B05 (B05-B, B05-BL), L1/L2/L3 strips, Zigbee RGBCW lights | Colour light with brightness, colour and colour temperature |
| Single colour bulbs | Mosquito killer lamp (UIID 57), Zigbee white lights | Dimmable light |
| Curtains | KingArt/BINTHEN curtain motors, ZBCurtain, DUALR3 in motor mode, TX Ultimate 3C in curtain mode | Window covering with position |
| Fans | iFan02/03/04, three-speed fans | Fan with Low/Medium/High, plus a separate "… Light" for the iFan light |
| Thermostats | TRVZB radiator valve, Wi-Fi thermostats (UIID 127) | Heating thermostat (on/off, target temperature, current temperature) |
| Zigbee buttons | SNZB-01, SNZB-01P | Button with single, double and long press (needs live updates) |
| Water leak sensors | SNZB-05, SNZB-05P | Water leak detector with battery |
| Smoke sensors | Zigbee smoke sensor | Smoke alarm with battery |
| Power monitoring | POW, POWR2, POWR3, S40, S60, DUALR3 | Outlet with power, voltage and current |

Not supported: RF Bridge and remotes, cameras. Bridges and hubs (ZBBridge, Bridge-M/U) need nothing of their own: their Zigbee devices appear individually. Other devices are skipped and logged with their UIID; turn on `debug` and open an issue with the UIID and the logged params to get one added.

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

## Logging in

1. Add the plugin in Matterbridge and restart it.
2. The Matterbridge log shows: `Not logged in to eWeLink. Open http://192.168.1.50:8284 ...` (your Matterbridge address).
3. Open that address on a phone or computer **on the same network** and click **Log in with eWeLink**.
4. Sign in with the email and password you use in the eWeLink app. Your password is entered on eWeLink's own page; Matterbridge never sees it.
5. You are sent back to Matterbridge and your devices are added.

The plugin renews the login in the background. You only log in again if Matterbridge was off for about two months, or after you change your eWeLink password. Open the same page and click **Log in again** to switch accounts.

## Configuration

Nothing is required. Optional settings:

| Option | Description |
|--------|-------------|
| `loginPort` | Port of the login page (default `8284`) |
| `liveUpdates` | Receive changes from eWeLink instantly (default on). Needed for Zigbee buttons |
| `refreshInterval` | Seconds between state refreshes when live updates are off or disconnected (default `60`, minimum `15`, `0` disables). While live updates are connected the plugin only checks every 5 minutes |
| `lightList` | Switches (names or device IDs) to expose as lights instead of outlets |
| `whiteList` | Only expose devices with these names or device IDs |
| `blackList` | Never expose devices with these names or device IDs |
| `appId` / `appSecret` / `redirectUrl` | Advanced: use your own eWeLink developer app instead of the built-in one |
| `debug` | Enable debug logging |

The login is stored in `~/Matterbridge/matterbridge-ewelink/tokens.json`. Delete it to log out.

> **Note:** eWeLink allows one session per app per account. Logging in to the same eWeLink account with this plugin on a second Matterbridge logs the first one out.

## Troubleshooting

- **The login page doesn't open**: check that your phone/computer is on the same network as Matterbridge and that port 8284 is not blocked or used by another program (change `loginPort` if it is).
- **"Returning to Matterbridge..." never finishes**: the browser could not reach the Matterbridge address. Open the login page again from a device on the same network.
- **Devices don't appear after logging in**: restart Matterbridge.
- **A device is skipped as unsupported**: enable `debug`, restart, and include the logged UIID in an issue.
- **A command fails with "device is offline"**: the device is not connected to the eWeLink cloud. Check its Wi-Fi or Zigbee bridge.

## For maintainers

The plugin uses one eWeLink developer app (OAuth 2.0, Standard Role) for everybody:

- **App ID / App Secret**: stored as the `EWELINK_APP_ID` and `EWELINK_APP_SECRET` repository secrets. The publish workflow writes them into `src/credentials.ts` before building, so they are in the npm package but never in the repository.
- **Redirect URL**: `https://tammeryousef1006.github.io/matterbridge-ewelink/`, the page in `docs/index.html` published with GitHub Pages (Settings → Pages → Deploy from a branch → `main` / `docs`). eWeLink sends the browser there after login; the page forwards it to the plugin's login page on the user's network, whose address travels in the OAuth `state`.

For local development, set `EWELINK_APP_ID` and `EWELINK_APP_SECRET` in the environment of Matterbridge.

## Development

```bash
npm install
npm install --no-save matterbridge   # provided by Matterbridge at runtime
npm test
```

## Support

If this plugin is useful to you, you can support its development:

<a href="https://buymeacoffee.com/6sjde6vkzl"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee"></a>

## License

ISC
