# Changelog

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
