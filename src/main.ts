/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { isMockEnabled, normalizeMockScenario, normalizeSoc } from './lib/runtime-config';

const OAUTH_REDIRECT_PORT = 8081;
const OAUTH_REDIRECT_PATH = '/oauth';
const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const MIN_MOCK_INTERVAL_MINUTES = 0.5;
const MIN_PRODUCTION_INTERVAL_MINUTES = 5;
const DEFAULT_MOCK_DATA_PATH = 'mockData.json';
const DEFAULT_AUTHORIZATION_URL = process.env.FORD_AUTHORIZATION_URL?.trim() || '';
const DEFAULT_TOKEN_URL = process.env.FORD_TOKEN_URL?.trim() || '';
const DEFAULT_VEHICLE_DATA_URL = process.env.FORD_VEHICLE_DATA_URL?.trim() || '';
const DEFAULT_MOCK_PAYLOAD = {
	vin: 'VIRTUAL_EXPLORER_123',
	battery: {
		soc: 78,
		range_km: 310,
	},
	status: 'charging',
};

class FordDataAct extends utils.Adapter {
	private oauthServer: Server | null = null;
	private oauthState: string | null = null;
	private oauthRedirectPort = OAUTH_REDIRECT_PORT;
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
				await this.startOauthRedirectServer();
			} catch (error) {
				this.log.error(`Failed to start OAuth redirect server: ${(error as Error).message}`);
				await this.setStateAsync('oauth.status', { val: 'oauth_server_unavailable', ack: true });
			}
			await this.updateLoginUrlState(true);
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
			if (this.oauthServer) {
				this.oauthServer.close();
				this.oauthServer = null;
			}
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
			await this.updateLoginUrlState(true);
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

	private async startOauthRedirectServer(): Promise<void> {
		if (this.oauthServer) {
			return;
		}

		this.oauthServer = createServer((req: IncomingMessage, res: ServerResponse) => {
			void this.handleOauthRequest(req, res);
		});

		try {
			this.oauthRedirectPort = await this.listenOauthServer(OAUTH_REDIRECT_PORT);
		} catch (error) {
			if (!this.isAddressInUseError(error)) {
				throw error;
			}

			this.log.warn(
				`OAuth redirect port ${OAUTH_REDIRECT_PORT} is already in use. Falling back to a random free port.`,
			);
			this.oauthRedirectPort = await this.listenOauthServer(0);
		}

		this.log.info(
			`OAuth redirect server listening on http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`,
		);
	}

	private async listenOauthServer(port: number): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.oauthServer?.removeAllListeners('listening');
				reject(error);
			};

			const onListening = (): void => {
				this.oauthServer?.removeAllListeners('error');
				resolve();
			};

			this.oauthServer?.once('error', onError);
			this.oauthServer?.once('listening', onListening);
			this.oauthServer?.listen(port);
		});

		const address = this.oauthServer?.address() as AddressInfo | string | null;
		if (!address || typeof address === 'string') {
			return port;
		}

		return address.port;
	}

	private isAddressInUseError(error: unknown): boolean {
		const errnoError = error as NodeJS.ErrnoException;
		return errnoError?.code === 'EADDRINUSE';
	}

	private async handleOauthRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!req.url) {
			this.respondText(res, 400, 'Missing request URL');
			return;
		}

		const url = new URL(req.url, `http://localhost:${this.oauthRedirectPort}`);
		if (url.pathname !== OAUTH_REDIRECT_PATH) {
			this.respondText(res, 404, 'Not found');
			return;
		}

		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		const error = url.searchParams.get('error');

		if (error) {
			await this.setStateAsync('oauth.status', { val: `authorization_error:${error}`, ack: true });
			this.respondText(res, 400, `OAuth authorization failed: ${error}`);
			return;
		}

		if (!code) {
			this.respondText(res, 400, 'Missing authorization code');
			return;
		}

		if (!state || state !== this.oauthState) {
			await this.setStateAsync('oauth.status', { val: 'state_mismatch', ack: true });
			this.respondText(res, 400, 'State mismatch');
			return;
		}

		await this.setStateAsync('oauth.authorizationCode', { val: code, ack: true, expire: 120 });
		await this.setStateAsync('oauth.status', { val: 'authorization_code_received', ack: true });

		const exchangeResult = await this.exchangeAuthorizationCode(code);
		if (!exchangeResult.ok) {
			this.respondText(
				res,
				500,
				`Authorization code received, but token exchange failed: ${exchangeResult.message}`,
			);
			return;
		}

		this.respondText(res, 200, 'Login successful. Refresh token stored. You can close this page.');
	}

	private respondText(res: ServerResponse, statusCode: number, message: string): void {
		res.statusCode = statusCode;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end(message);
	}

	private async updateLoginUrlState(logToInfo: boolean): Promise<void> {
		if (!this.oauthServer) {
			await this.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.setStateAsync('oauth.status', { val: 'oauth_server_unavailable', ack: true });
			this.log.warn('OAuth redirect server is unavailable. OAuth login URL cannot be generated.');
			return;
		}

		const authorizationUrl = this.authorizationEndpoint();
		if (!authorizationUrl) {
			await this.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.setStateAsync('oauth.status', { val: 'missing_authorization_endpoint', ack: true });
			this.log.warn(
				'Authorization endpoint is not configured in adapter constants. OAuth login URL cannot be generated.',
			);
			return;
		}

		const authorizationValidation = this.validateAuthorizationUrl(authorizationUrl);
		if (!authorizationValidation.valid) {
			await this.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.setStateAsync('oauth.status', { val: 'invalid_authorization_url', ack: true });
			this.log.error(`Invalid authorizationUrl: ${authorizationValidation.reason}`);
			return;
		}

		if (!this.config.clientId?.trim()) {
			await this.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.setStateAsync('oauth.status', { val: 'missing_client_id', ack: true });
			this.log.warn('clientId is not configured. OAuth login URL cannot be generated.');
			return;
		}

		if (!this.config.clientSecret?.trim()) {
			await this.setStateAsync('oauth.status', { val: 'missing_client_secret', ack: true });
			this.log.warn('clientSecret is not configured. OAuth flow may complete, but token exchange will fail.');
		}

		this.oauthState = randomUUID();
		const redirectUri = `http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`;
		const loginUrl = `${authorizationUrl}?response_type=code&client_id=${encodeURIComponent(this.config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(this.oauthState)}`;

		await this.setStateAsync('oauth.loginUrl', { val: loginUrl, ack: true });
		await this.setStateAsync('oauth.status', { val: 'awaiting_authorization_code', ack: true });

		if (logToInfo) {
			this.log.info(`OAuth login URL: ${loginUrl}`);
		}
	}

	private validateAuthorizationUrl(urlText: string): { valid: boolean; reason?: string } {
		let parsed: URL;
		try {
			parsed = new URL(urlText);
		} catch {
			return {
				valid: false,
				reason: 'URL is not a valid absolute URL',
			};
		}

		if (!['https:', 'http:'].includes(parsed.protocol)) {
			return {
				valid: false,
				reason: `Unsupported protocol ${parsed.protocol}`,
			};
		}

		if (parsed.pathname.includes('access_tokens')) {
			return {
				valid: false,
				reason: 'Looks like token endpoint (access_tokens). Please use the OAuth authorization endpoint.',
			};
		}

		return { valid: true };
	}

	private authorizationEndpoint(): string | null {
		return DEFAULT_AUTHORIZATION_URL || null;
	}

	private tokenEndpoint(): string | null {
		return DEFAULT_TOKEN_URL || null;
	}

	private vehicleDataEndpoint(): string | null {
		return DEFAULT_VEHICLE_DATA_URL || null;
	}

	private async exchangeAuthorizationCode(code: string): Promise<{ ok: boolean; message: string }> {
		if (!this.config.clientId?.trim() || !this.config.clientSecret?.trim()) {
			await this.setStateAsync('oauth.status', { val: 'missing_client_credentials', ack: true });
			return { ok: false, message: 'Missing clientId/clientSecret in adapter config' };
		}

		const tokenEndpoint = this.tokenEndpoint();
		if (!tokenEndpoint) {
			await this.setStateAsync('oauth.status', { val: 'missing_token_endpoint', ack: true });
			return { ok: false, message: 'Missing token endpoint in adapter constants' };
		}

		const redirectUri = `http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`;
		const payload = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
			redirect_uri: redirectUri,
		});

		try {
			const response = await fetch(tokenEndpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body: payload.toString(),
			});

			const responseText = await response.text();
			let data: Record<string, any> = {};
			try {
				data = responseText ? (JSON.parse(responseText) as Record<string, any>) : {};
			} catch {
				data = { raw: responseText };
			}

			if (!response.ok) {
				const errorMessage = `${response.status} ${response.statusText}`;
				this.log.error(`OAuth token exchange failed: ${errorMessage}; body=${JSON.stringify(data)}`);
				await this.setStateAsync('oauth.status', { val: 'token_exchange_failed', ack: true });
				return { ok: false, message: errorMessage };
			}

			const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
			if (!refreshToken) {
				this.log.error(`OAuth token exchange succeeded but no refresh_token returned: ${JSON.stringify(data)}`);
				await this.setStateAsync('oauth.status', { val: 'missing_refresh_token', ack: true });
				return { ok: false, message: 'No refresh_token in response' };
			}

			await this.persistRefreshToken(refreshToken);
			await this.setStateAsync('oauth.status', { val: 'login_successful', ack: true });
			this.log.info('OAuth login successful. Refresh token stored in adapter configuration.');
			return { ok: true, message: 'ok' };
		} catch (error) {
			const message = (error as Error).message;
			this.log.error(`OAuth token exchange request failed: ${message}`);
			await this.setStateAsync('oauth.status', { val: 'token_exchange_request_failed', ack: true });
			return { ok: false, message };
		}
	}

	private async persistRefreshToken(refreshToken: string): Promise<void> {
		const instanceId = `system.adapter.${this.namespace}`;
		const instanceObject = await this.getForeignObjectAsync(instanceId);
		if (!instanceObject) {
			this.log.error(`Cannot persist refresh token. Instance object not found: ${instanceId}`);
			return;
		}

		instanceObject.native = {
			...instanceObject.native,
			refreshToken,
		};

		await this.setForeignObjectAsync(instanceId, instanceObject);
		this.config.refreshToken = refreshToken;
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

		const vehicleDataEndpoint = this.vehicleDataEndpoint();
		const tokenEndpoint = this.tokenEndpoint();

		return (
			Boolean(this.config.clientId?.trim()) &&
			Boolean(this.config.clientSecret?.trim()) &&
			Boolean(this.config.refreshToken?.trim()) &&
			Boolean(tokenEndpoint) &&
			Boolean(vehicleDataEndpoint)
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
			const mockPath = this.resolveMockDataPath();
			const scenario = this.currentMockScenario();
			this.log.debug(`Using mock data from ${mockPath} (scenario: ${scenario})`);
			try {
				const raw = await readFile(mockPath, 'utf8');
				return this.applyMockScenario(JSON.parse(raw));
			} catch (error) {
				const errnoError = error as NodeJS.ErrnoException;
				if (errnoError.code === 'ENOENT') {
					this.log.warn(`Mock data file not found at ${mockPath}. Falling back to built-in mock payload.`);
					return this.applyMockScenario(DEFAULT_MOCK_PAYLOAD);
				}

				throw error;
			}
		}

		const accessToken = await this.refreshOAuthToken();
		const url = this.vehicleDataEndpoint();
		if (!url) {
			throw new Error('Vehicle data endpoint is not configured in adapter constants.');
		}
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		});

		const raw = await response.text();
		if (!response.ok) {
			throw new Error(`Vehicle data request failed: ${response.status} ${response.statusText}; body=${raw}`);
		}

		return raw ? JSON.parse(raw) : {};
	}

	private applyMockScenario(payload: unknown): unknown {
		const scenario = this.currentMockScenario();
		if (scenario === 'normal') {
			return payload;
		}

		if (typeof payload !== 'object' || payload === null) {
			return payload;
		}

		const cloned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
		const vehicle = this.targetVehicleForScenario(cloned);
		if (!vehicle) {
			return cloned;
		}

		if (scenario === 'charging') {
			this.setDeep(vehicle, ['status'], 'charging');
			this.setDeep(vehicle, ['battery', 'soc'], 82);
			this.setDeep(vehicle, ['battery', 'range_km'], 325);
			this.setDeep(vehicle, ['charging', 'batteryLevel'], 0.82);
			this.setDeep(vehicle, ['charging', 'power_kw'], 11);
			this.setDeep(vehicle, ['charging', 'isCharging'], true);
		}

		if (scenario === 'lowBattery') {
			this.setDeep(vehicle, ['status'], 'low_battery');
			this.setDeep(vehicle, ['battery', 'soc'], 14);
			this.setDeep(vehicle, ['battery', 'range_km'], 48);
			this.setDeep(vehicle, ['charging', 'batteryLevel'], 0.14);
			this.setDeep(vehicle, ['charging', 'isCharging'], false);
		}

		return cloned;
	}

	private targetVehicleForScenario(root: Record<string, unknown>): Record<string, unknown> | null {
		const vehicles = root.vehicles;
		if (Array.isArray(vehicles) && vehicles.length > 0) {
			const first = vehicles[0];
			return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
		}

		return root;
	}

	private setDeep(root: Record<string, unknown>, parts: string[], value: unknown): void {
		let cursor: Record<string, unknown> = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const key = parts[i];
			const next = cursor[key];
			if (typeof next !== 'object' || next === null) {
				cursor[key] = {};
			}
			cursor = cursor[key] as Record<string, unknown>;
		}

		cursor[parts[parts.length - 1]] = value;
	}

	private resolveMockDataPath(): string {
		const configured = this.config.mockDataPath?.trim() || DEFAULT_MOCK_DATA_PATH;
		if (path.isAbsolute(configured)) {
			return configured;
		}

		const candidates = [
			path.resolve(this.adapterDir, configured),
			path.resolve(this.adapterDir, '..', configured),
			path.resolve(process.cwd(), configured),
			path.resolve(process.cwd(), '..', configured),
			path.resolve(process.cwd(), '..', '..', configured),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}

		return candidates[0];
	}

	private async refreshOAuthToken(): Promise<string> {
		const tokenEndpoint = this.tokenEndpoint();
		if (!tokenEndpoint) {
			throw new Error('Token endpoint is not configured in adapter constants.');
		}

		if (!this.config.refreshToken?.trim()) {
			throw new Error('refreshToken is missing. Please run OAuth login first.');
		}

		const payload = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: this.config.refreshToken,
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
		});

		const response = await fetch(tokenEndpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body: payload.toString(),
		});

		const raw = await response.text();
		let data: Record<string, unknown> = {};
		try {
			data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		} catch {
			data = { raw };
		}

		if (!response.ok) {
			throw new Error(
				`Token refresh failed: ${response.status} ${response.statusText}; body=${JSON.stringify(data)}`,
			);
		}

		const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
		const nextRefreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
		if (!accessToken) {
			throw new Error(`Token refresh succeeded but no access_token returned: ${JSON.stringify(data)}`);
		}

		if (nextRefreshToken && nextRefreshToken !== this.config.refreshToken) {
			await this.persistRefreshToken(nextRefreshToken);
		}

		return accessToken;
	}

	private async updateVehicleStates(payload: unknown): Promise<number> {
		const vehicles = this.extractVehicles(payload);
		if (vehicles.length === 0) {
			this.log.warn('No vehicle records found in payload.');
			return 0;
		}

		for (const vehicle of vehicles) {
			await this.updateSingleVehicleState(vehicle);
		}

		return vehicles.length;
	}

	private extractVehicles(payload: unknown): Array<Record<string, unknown>> {
		if (Array.isArray(payload)) {
			return payload.filter(
				(entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
			);
		}

		if (typeof payload !== 'object' || payload === null) {
			return [];
		}

		const root = payload as Record<string, unknown>;
		const vehicleArrayCandidate = root.vehicles;
		if (Array.isArray(vehicleArrayCandidate)) {
			return vehicleArrayCandidate.filter(
				(entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
			);
		}

		return [root];
	}

	private async updateSingleVehicleState(vehicle: Record<string, unknown>): Promise<void> {
		const vin =
			this.extractString(vehicle.vin) || this.extractString(vehicle.vehicleIdentificationNumber) || 'unknown';
		const vinId = this.normalizeId(vin);
		const base = `vehicles.${vinId}`;

		await this.setObjectNotExistsAsync(`vehicles.${vinId}`, {
			type: 'channel',
			common: { name: vin },
			native: { vin },
		});

		const socRaw =
			this.extractNumberFromPath(vehicle, ['battery', 'soc']) ??
			this.extractNumberFromPath(vehicle, ['battery', 'stateOfCharge']) ??
			this.extractNumberFromPath(vehicle, ['charging', 'batteryLevel']);
		const soc = normalizeSoc(socRaw);

		if (typeof soc === 'number') {
			await this.setObjectNotExistsAsync(`${base}.battery.soc`, {
				type: 'state',
				common: {
					name: 'Battery SoC',
					type: 'number',
					role: 'value.battery',
					read: true,
					write: false,
					unit: '%',
				},
				native: {},
			});
			await this.setStateAsync(`${base}.battery.soc`, { val: soc, ack: true });
		}

		const range =
			this.extractNumberFromPath(vehicle, ['battery', 'range_km']) ??
			this.extractNumberFromPath(vehicle, ['battery', 'rangeKm']) ??
			this.extractNumberFromPath(vehicle, ['charging', 'estimatedRange']);

		if (typeof range === 'number') {
			await this.setObjectNotExistsAsync(`${base}.battery.range_km`, {
				type: 'state',
				common: {
					name: 'Estimated Range',
					type: 'number',
					role: 'value.range',
					read: true,
					write: false,
					unit: 'km',
				},
				native: {},
			});
			await this.setStateAsync(`${base}.battery.range_km`, { val: range, ack: true });
		}

		const status = this.extractString(vehicle.status) ?? this.extractString(vehicle.chargingStatus) ?? '';
		if (status) {
			await this.setObjectNotExistsAsync(`${base}.status`, {
				type: 'state',
				common: {
					name: 'Vehicle status',
					type: 'string',
					role: 'text',
					read: true,
					write: false,
				},
				native: {},
			});
			await this.setStateAsync(`${base}.status`, { val: status, ack: true });
		}

		const odometer =
			this.extractNumberFromPath(vehicle, ['diagnostics', 'odometer']) ??
			this.extractNumberFromPath(vehicle, ['odometer']) ??
			this.extractNumberFromPath(vehicle, ['mileage']);

		if (typeof odometer === 'number') {
			await this.setObjectNotExistsAsync(`${base}.odometer`, {
				type: 'state',
				common: {
					name: 'Odometer',
					type: 'number',
					role: 'value.distance',
					read: true,
					write: false,
					unit: 'km',
				},
				native: {},
			});
			await this.setStateAsync(`${base}.odometer`, { val: odometer, ack: true });
		}

		const chargingPower = this.extractNumberFromPath(vehicle, ['charging', 'power_kw']);
		if (typeof chargingPower === 'number') {
			await this.setObjectNotExistsAsync(`${base}.charging.power_kw`, {
				type: 'state',
				common: {
					name: 'Charging power',
					type: 'number',
					role: 'value.power',
					read: true,
					write: false,
					unit: 'kW',
				},
				native: {},
			});
			await this.setStateAsync(`${base}.charging.power_kw`, { val: chargingPower, ack: true });
		}

		const isCharging =
			this.extractBooleanFromPath(vehicle, ['charging', 'isCharging']) ??
			this.extractString(vehicle.status)?.toLowerCase() === 'charging';
		if (typeof isCharging === 'boolean') {
			await this.setObjectNotExistsAsync(`${base}.charging.isCharging`, {
				type: 'state',
				common: {
					name: 'Charging active',
					type: 'boolean',
					role: 'indicator',
					read: true,
					write: false,
				},
				native: {},
			});
			await this.setStateAsync(`${base}.charging.isCharging`, { val: isCharging, ack: true });
		}

		const latitude =
			this.extractNumberFromPath(vehicle, ['location', 'latitude']) ??
			this.extractNumberFromPath(vehicle, ['position', 'latitude']);
		const longitude =
			this.extractNumberFromPath(vehicle, ['location', 'longitude']) ??
			this.extractNumberFromPath(vehicle, ['position', 'longitude']);
		if (typeof latitude === 'number' && typeof longitude === 'number') {
			await this.setObjectNotExistsAsync(`${base}.location.latitude`, {
				type: 'state',
				common: {
					name: 'Latitude',
					type: 'number',
					role: 'value.gps.latitude',
					read: true,
					write: false,
				},
				native: {},
			});
			await this.setObjectNotExistsAsync(`${base}.location.longitude`, {
				type: 'state',
				common: {
					name: 'Longitude',
					type: 'number',
					role: 'value.gps.longitude',
					read: true,
					write: false,
				},
				native: {},
			});
			await this.setStateAsync(`${base}.location.latitude`, { val: latitude, ack: true });
			await this.setStateAsync(`${base}.location.longitude`, { val: longitude, ack: true });
		}

		const insideTemp =
			this.extractNumberFromPath(vehicle, ['climate', 'insideTempC']) ??
			this.extractNumberFromPath(vehicle, ['climate', 'interiorTemperature']);
		if (typeof insideTemp === 'number') {
			await this.setObjectNotExistsAsync(`${base}.climate.insideTempC`, {
				type: 'state',
				common: {
					name: 'Inside temperature',
					type: 'number',
					role: 'value.temperature',
					read: true,
					write: false,
					unit: '°C',
				},
				native: {},
			});
			await this.setStateAsync(`${base}.climate.insideTempC`, { val: insideTemp, ack: true });
		}

		const doorsLocked =
			this.extractBooleanFromPath(vehicle, ['doors', 'locked']) ??
			this.extractBooleanFromPath(vehicle, ['security', 'doorsLocked']);
		if (typeof doorsLocked === 'boolean') {
			await this.setObjectNotExistsAsync(`${base}.doors.locked`, {
				type: 'state',
				common: {
					name: 'Doors locked',
					type: 'boolean',
					role: 'indicator.lock',
					read: true,
					write: false,
				},
				native: {},
			});
			await this.setStateAsync(`${base}.doors.locked`, { val: doorsLocked, ack: true });
		}

		await this.setObjectNotExistsAsync(`${base}.rawJson`, {
			type: 'state',
			common: {
				name: 'Raw vehicle payload',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setStateAsync(`${base}.rawJson`, { val: JSON.stringify(vehicle), ack: true });
	}

	private extractNumberFromPath(root: Record<string, unknown>, pathParts: string[]): number | null {
		let cursor: unknown = root;
		for (const part of pathParts) {
			if (typeof cursor !== 'object' || cursor === null) {
				return null;
			}
			cursor = (cursor as Record<string, unknown>)[part];
		}

		if (typeof cursor === 'number' && Number.isFinite(cursor)) {
			return cursor;
		}

		if (typeof cursor === 'object' && cursor !== null) {
			const value = (cursor as Record<string, unknown>).value;
			if (typeof value === 'number' && Number.isFinite(value)) {
				return value;
			}
		}

		return null;
	}

	private extractString(value: unknown): string | null {
		if (typeof value !== 'string') {
			return null;
		}

		const normalized = value.trim();
		return normalized ? normalized : null;
	}

	private extractBooleanFromPath(root: Record<string, unknown>, pathParts: string[]): boolean | null {
		let cursor: unknown = root;
		for (const part of pathParts) {
			if (typeof cursor !== 'object' || cursor === null) {
				return null;
			}
			cursor = (cursor as Record<string, unknown>)[part];
		}

		if (typeof cursor === 'boolean') {
			return cursor;
		}

		if (typeof cursor === 'number') {
			if (cursor === 1) {
				return true;
			}
			if (cursor === 0) {
				return false;
			}
		}

		if (typeof cursor === 'string') {
			const normalized = cursor.toLowerCase();
			if (['true', 'on', 'locked', 'yes'].includes(normalized)) {
				return true;
			}
			if (['false', 'off', 'unlocked', 'no'].includes(normalized)) {
				return false;
			}
		}

		return null;
	}

	private normalizeId(value: string): string {
		return value.replace(/[^a-zA-Z0-9_-]/g, '_');
	}
}
if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new FordDataAct(options);
} else {
	(() => new FordDataAct())();
}
