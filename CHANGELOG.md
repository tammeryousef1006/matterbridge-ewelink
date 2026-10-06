# Changelog

## 1.0.0 (2026-10-06)
- Initial release
- Sign in with eWeLink email, password and country code, with automatic region detection and token renewal
- Single and multi channel switches and plugs exposed as Matter outlets (or lights via `lightList`)
- TH10/TH16/THR3xx temperature and humidity readings
- Zigbee SNZB-02 temperature/humidity, SNZB-04 door/window and SNZB-03 motion sensors, with battery level
- State polling (`refreshInterval`, default 60 seconds) and offline devices reported as unreachable
- `whiteList`/`blackList` to choose which devices are exposed
