![Logo](admin/ford-data-act.svg)
# ioBroker.ford-data-act

[![NPM version](https://img.shields.io/npm/v/iobroker.ford-data-act.svg)](https://www.npmjs.com/package/iobroker.ford-data-act)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ford-data-act.svg)](https://www.npmjs.com/package/iobroker.ford-data-act)
![Number of Installations](https://iobroker.live/badges/ford-data-act-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ford-data-act-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ford-data-act.png?downloads=true)](https://nodei.co/npm/iobroker.ford-data-act/)

**Tests:** ![Test and Release](https://github.com/boergegrunicke/ioBroker.ford-data-act/workflows/Test%20and%20Release/badge.svg)

## ford-data-act adapter for ioBroker

Read-only ioBroker adapter for Ford vehicle data (EU Data Act context).

Current focus is a stable baseline with strong mock-mode support and robust state mapping.

## Current status (v1 baseline)

Implemented:
- Polling scheduler with overlap guard and clean shutdown.
- Mock mode with local JSON source and scenario simulation.
- OAuth callback server and token lifecycle scaffolding.
- Vehicle state mapping for key telemetry.
- Operational states for diagnostics (`info.connection`, `info.lastUpdate`, `info.lastError`, `info.vehicleCount`).

Not finalized yet:
- Real Ford endpoint binding and production OAuth credentials flow against confirmed live endpoints.

## Configuration

Admin settings are intentionally minimal:
- `mock`: enable or disable mock mode.
- `mockScenario`: simulation profile in mock mode (`normal`, `charging`, `lowBattery`).
- `clientId`: OAuth client id (live mode).
- `clientSecret`: OAuth client secret (live mode).
- `interval`: polling interval in minutes.
- `mockDataPath`: local JSON file path for mock payload.

If `mock` is disabled, the adapter runs in live mode.

## Endpoint configuration (developer/internal)

Live endpoints are not configured in the Admin UI.
They are provided via environment variables:

- `FORD_AUTHORIZATION_URL`
- `FORD_TOKEN_URL`
- `FORD_VEHICLE_DATA_URL`

Example:

```bash
export FORD_AUTHORIZATION_URL="https://example.com/oauth/authorize"
export FORD_TOKEN_URL="https://example.com/oauth/token"
export FORD_VEHICLE_DATA_URL="https://example.com/vehicle-data"
```

## Mock mode quick start

1. Set `mock = true` in adapter config.
2. Choose a `mockScenario`.
3. Start adapter and inspect states under `vehicles.*`.
4. Optional: choose one of the fixture files or set custom `mockDataPath`.

Available fixture files:
- `mock/fixtures/single-normal.json`
- `mock/fixtures/multi-vehicle.json`
- `mock/fixtures/sparse-edge.json`

## Mapped states (current)

Detailed source-to-target mapping is documented in [docs/mapping-matrix.md](docs/mapping-matrix.md).

Per vehicle:
- `battery.soc`
- `battery.range_km`
- `status`
- `odometer`
- `charging.power_kw`
- `charging.isCharging`
- `location.latitude`
- `location.longitude`
- `climate.insideTempC`
- `doors.locked`
- `rawJson`

Global info:
- `info.connection`
- `info.lastUpdate`
- `info.lastError`
- `info.vehicleCount`

## Development

Useful scripts:

```bash
npm run check
npm run lint
npm run test
npm run test:integration
```

Manual dev-server usage:

```bash
npm install --global @iobroker/dev-server
dev-server setup
dev-server watch
```

## Disclaimer

Ford is a trademark of Ford Motor Company. This project is independent and not affiliated with or endorsed by Ford.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (boergegrunicke) simplify config to mock toggle + essential credentials
* (boergegrunicke) add mock scenarios and expanded vehicle state mapping
* (boergegrunicke) add runtime helper unit tests and update documentation
* (boergegrunicke) add mock fixture set and mapping matrix documentation

## License
MIT License

Copyright (c) 2026 boergegrunicke <boerge@grunicke.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.