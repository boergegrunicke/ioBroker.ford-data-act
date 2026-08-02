/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { FordApiClient } from './ford/client';
import { isMockEnabled, normalizeMockScenario } from './ford/config';
import { DEFAULT_TOKEN_URL, DEFAULT_VEHICLE_DATA_URL } from './ford/const';
import { extractVehicles, mapVehicle } from './ford/mapping';
import { loadMockVehicleData } from './ford/mock';

const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const MIN_MOCK_INTERVAL_MINUTES = 0.5;
const MIN_PRODUCTION_INTERVAL_MINUTES = 5;

class FordDataAct extends utils.Adapter {
	private readonly fordClient = new FordApiClient(this);
	private pollingTimer: ioBroker.Interval | undefined;
	private pollingActive = false;

	private isMockMode(): boolean {
		return isMockEnabled(this.config);
	}

	private currentMockScenario(): 'normal' | 'charging' | 'lowBattery' {
		return normalizeMockScenario(this.config.mockScenario?.trim());
	}

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'ford-data-act',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		await this.setStateAsync('info.connection', false, true);
		await this.ensureInfoObjects();
		await this.ensureControlObjects();

		this.subscribeStates('oauth.start');

		if (this.isMockMode()) {
			await this.setStateAsync('oauth.status', { val: 'mock_mode_active', ack: true });
			await this.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			this.log.info('Mock mode active: OAuth and live API auth are bypassed.');
		} else {
			try {
				await this.fordClient.startOauthRedirectServer();
			} catch (error) {
				this.log.error(`Failed to start OAuth redirect server: ${(error as Error).message}`);
				await this.setStateAsync('oauth.status', { val: 'oauth_server_unavailable', ack: true });
			}
			await this.fordClient.updateLoginUrlState(true);
		}

		const intervalMinutes = this.normalizedIntervalMinutes();
		this.pollingTimer = this.setInterval(() => void this.onPollingTick(), intervalMinutes * 60_000);
		this.log.info(`Polling initialized with ${intervalMinutes} minute(s).`);
		void this.onPollingTick();

		if (!this.hasRequiredPollingConfig()) {
			this.log.warn('Polling prerequisites are incomplete. Waiting for configuration values.');
		}
	}

	private onUnload(callback: () => void): void {
		try {
			if (this.pollingTimer !== undefined) {
				this.clearInterval(this.pollingTimer);
				this.pollingTimer = undefined;
			}
			this.fordClient.stopOauthRedirectServer();
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${(error as Error).message}`);
			callback();
		}
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state) {
			return;
		}

		if (!id.endsWith('.oauth.start') || state.ack || !state.val) {
			return;
		}

		if (this.isMockMode()) {
			void this.setStateAsync('oauth.start', { val: false, ack: true });
			void this.setStateAsync('oauth.status', { val: 'mock_mode_active', ack: true });
			this.log.info('OAuth is disabled in mock mode.');
			return;
		}

		void (async (): Promise<void> => {
			await this.fordClient.updateLoginUrlState(true);
			await this.setStateAsync('oauth.start', { val: false, ack: true });
		})();
	}

	private async ensureControlObjects(): Promise<void> {
		await this.setObjectNotExistsAsync('oauth', {
			type: 'channel',
			common: {
				name: 'OAuth',
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('oauth.start', {
			type: 'state',
			common: {
				name: 'Regenerate OAuth login URL',
				type: 'boolean',
				role: 'button',
				read: false,
				write: true,
				def: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('oauth.loginUrl', {
			type: 'state',
			common: {
				name: 'OAuth login URL',
				type: 'string',
				role: 'text.url',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('oauth.status', {
			type: 'state',
			common: {
				name: 'OAuth status',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('oauth.authorizationCode', {
			type: 'state',
			common: {
				name: 'OAuth authorization code (temporary)',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setStateAsync('oauth.start', { val: false, ack: true });
		await this.setStateAsync('oauth.status', {
			val: this.isMockMode() ? 'mock_mode_active' : 'idle',
			ack: true,
		});
	}

	private async ensureInfoObjects(): Promise<void> {
		await this.setObjectNotExistsAsync('info.lastUpdate', {
			type: 'state',
			common: {
				name: 'Last successful update',
				type: 'number',
				role: 'value.time',
				read: true,
				write: false,
				unit: 'ms',
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.lastError', {
			type: 'state',
			common: {
				name: 'Last polling error',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.vehicleCount', {
			type: 'state',
			common: {
				name: 'Detected vehicle count',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync('info.mappingOk', {
			type: 'state',
			common: {
				name: 'Vehicle state mapping successful',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
				def: true,
			},
			native: {},
		});
	}

	private normalizedIntervalMinutes(): number {
		const configured = Number(this.config.interval);
		const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_INTERVAL_MINUTES;
		const minAllowed = this.isMockMode() ? MIN_MOCK_INTERVAL_MINUTES : MIN_PRODUCTION_INTERVAL_MINUTES;
		if (fallback < minAllowed) {
			this.log.warn(`Configured interval ${fallback}m is below minimum ${minAllowed}m. Minimum will be used.`);
			return minAllowed;
		}
		return fallback;
	}

	private hasRequiredPollingConfig(): boolean {
		if (this.isMockMode()) {
			return true;
		}

		return (
			Boolean(this.config.clientId?.trim()) &&
			Boolean(this.config.clientSecret?.trim()) &&
			Boolean(this.config.refreshToken?.trim()) &&
			Boolean(DEFAULT_TOKEN_URL) &&
			Boolean(DEFAULT_VEHICLE_DATA_URL)
		);
	}

	private async onPollingTick(): Promise<void> {
		if (this.pollingActive) {
			this.log.debug('Polling still active; skipping overlapping cycle.');
			return;
		}

		if (!this.hasRequiredPollingConfig()) {
			await this.setStateAsync('info.connection', false, true);
			await this.setStateAsync('info.lastError', { val: 'missing configuration', ack: true });
			return;
		}

		this.pollingActive = true;
		try {
			const data = await this.fetchVehicleData();

			// Connection reflects API/mock read success. Mapping errors are tracked separately.
			await this.setStateAsync('info.connection', true, true);

			try {
				const vehicleCount = await this.updateVehicleStates(data);
				await this.setStateAsync('info.vehicleCount', { val: vehicleCount, ack: true });
				await this.setStateAsync('info.lastUpdate', { val: Date.now(), ack: true });
				await this.setStateAsync('info.lastError', { val: '', ack: true });
				await this.setStateAsync('info.mappingOk', { val: true, ack: true });
			} catch (mappingError) {
				this.log.error(`State mapping failed: ${(mappingError as Error).message}`);
				await this.setStateAsync('info.lastError', {
					val: `mapping_error: ${(mappingError as Error).message}`,
					ack: true,
				});
				await this.setStateAsync('info.mappingOk', { val: false, ack: true });
			}
		} catch (error) {
			this.log.error(`Polling failed: ${(error as Error).message}`);
			await this.setStateAsync('info.lastError', { val: (error as Error).message, ack: true });
			await this.setStateAsync('info.connection', false, true);
		} finally {
			this.pollingActive = false;
		}
	}

	private async fetchVehicleData(): Promise<unknown> {
		if (this.isMockMode()) {
			return loadMockVehicleData({
				configuredPath: this.config.mockDataPath,
				scenario: this.currentMockScenario(),
				adapterDir: this.adapterDir,
				log: this.log,
			});
		}

		return this.fordClient.fetchVehicleData();
	}

	private async updateVehicleStates(payload: unknown): Promise<number> {
		const vehicles = extractVehicles(payload);
		if (vehicles.length === 0) {
			this.log.warn('No vehicle records found in payload.');
			return 0;
		}

		for (const vehicle of vehicles) {
			await this.updateSingleVehicleState(vehicle);
		}

		return vehicles.length;
	}

	private async updateSingleVehicleState(vehicle: Record<string, unknown>): Promise<void> {
		const { vin, vinId, states } = mapVehicle(vehicle);
		const base = `vehicles.${vinId}`;

		await this.setObjectNotExistsAsync(base, {
			type: 'channel',
			common: { name: vin },
			native: { vin },
		});

		for (const state of states) {
			await this.setObjectNotExistsAsync(`${base}.${state.id}`, {
				type: 'state',
				common: state.common,
				native: {},
			});
			await this.setStateAsync(`${base}.${state.id}`, { val: state.value, ack: true });
		}
	}
}
if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new FordDataAct(options);
} else {
	(() => new FordDataAct())();
}
