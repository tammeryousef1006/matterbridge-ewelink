# Changelog

## 1.1.1
- Live updates: take the account apikey from the device list instead of the user profile, which eWeLink doesn't allow for Standard role apps (error 407)
- Live updates: the reason they can't connect is now logged as a warning (once per cause) instead of only in the debug log
- Live updates: accept eWeLink's login answer even without the request sequence, and give up on a login that gets no answer within 20 seconds

## 1.1.0 (2026-10-09)
- Live updates over eWeLink's WebSocket: changes show up in Matter right away instead of after the next poll (polling every 5 minutes remains as a safety net; `liveUpdates` option to turn it off)
- New device types, built from the official eWeLink UIID protocol and SonoffLAN (not yet tested with real devices):
  - Dimmers and lights: D1, KING-M4, MINI-DIM, B02/B05 bulbs, L1/L2/L3 strips, single colour bulbs, Zigbee white, CCT and RGBCW lights (brightness, colour temperature, colour)
  - Curtains: KingArt/BINTHEN motors, ZBCurtain, DUALR3 in motor mode, TX Ultimate 3C in curtain mode
  - Fans: iFan02/03/04 (fan with three speeds plus a separate light device) and three-speed fans
  - Thermostats: TRVZB and Wi-Fi thermostats
  - Zigbee buttons (single, double, long press), water leak sensors and smoke sensors
  - Power, voltage and current on POW, POWR2, POWR3, S40, S60 and DUALR3
- Battery level for Zigbee buttons, leak and smoke sensors, ZBCurtain and TRVZB

## 1.0.1 (2026-10-06)
- Buy Me a Coffee sponsor link in Matterbridge, on GitHub and in the README

## 1.0.0 (2026-10-06)
- Initial release
- Log in once in the browser with eWeLink's OAuth login page (served from a small login page on the Matterbridge host); the login is saved and renewed automatically
- Single and multi channel switches and plugs exposed as Matter outlets (or lights via `lightList`)
- TH10/TH16/THR3xx temperature and humidity readings
- Zigbee SNZB-02/02D temperature/humidity, SNZB-04 door/window and SNZB-03 motion sensors with battery level, and the SNZB-06P presence sensor with its bright/dark light sensor
- NSPanel Pro / Bridge security modes (Home, Away, Sleep) as switches, and eWeLink virtual switches
- TX Ultimate T5 1C–4C, NSPanel and M5 multi-gang switches with the right number of channels
- State polling (`refreshInterval`, default 60 seconds) and offline devices reported as unreachable
- `whiteList`/`blackList` to choose which devices are exposed
