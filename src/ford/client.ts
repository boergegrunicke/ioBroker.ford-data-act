import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as utils from '@iobroker/adapter-core';
import {
	DEFAULT_AUTHORIZATION_URL,
	DEFAULT_TOKEN_URL,
	DEFAULT_VEHICLE_DATA_URL,
	OAUTH_REDIRECT_PATH,
	OAUTH_REDIRECT_PORT,
} from './const';

/**
 * The subset of adapter functionality the Ford client needs to log, persist state
 * and store the refresh token. Kept narrow so it stays decoupled from the adapter class.
 */
export type FordClientHost = Pick<
	InstanceType<typeof utils.Adapter>,
	'log' | 'config' | 'namespace' | 'setStateAsync' | 'getForeignObjectAsync' | 'setForeignObjectAsync'
>;

/**
 * Everything needed to talk to Ford: the local OAuth redirect server, the
 * authorization-code/refresh-token lifecycle, and the live vehicle data request.
 */
export class FordApiClient {
	private oauthServer: Server | null = null;
	private oauthState: string | null = null;
	private oauthRedirectPort = OAUTH_REDIRECT_PORT;

	/**
	 * @param host Narrow adapter facade used for logging, state updates and refresh-token persistence.
	 */
	public constructor(private readonly host: FordClientHost) {}

	/** Starts the local OAuth redirect server, falling back to a random port if the default is taken. */
	public async startOauthRedirectServer(): Promise<void> {
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

			this.host.log.warn(
				`OAuth redirect port ${OAUTH_REDIRECT_PORT} is already in use. Falling back to a random free port.`,
			);
			this.oauthRedirectPort = await this.listenOauthServer(0);
		}

		this.host.log.info(
			`OAuth redirect server listening on http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`,
		);
	}

	/** Closes the OAuth redirect server, if running. */
	public stopOauthRedirectServer(): void {
		if (this.oauthServer) {
			this.oauthServer.close();
			this.oauthServer = null;
		}
	}

	/**
	 * Rebuilds the OAuth login URL from current config and publishes it to `oauth.loginUrl`.
	 *
	 * @param logToInfo Whether to also log the generated URL at info level.
	 */
	public async updateLoginUrlState(logToInfo: boolean): Promise<void> {
		if (!this.oauthServer) {
			await this.host.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.host.setStateAsync('oauth.status', { val: 'oauth_server_unavailable', ack: true });
			this.host.log.warn('OAuth redirect server is unavailable. OAuth login URL cannot be generated.');
			return;
		}

		const authorizationUrl = this.authorizationEndpoint();
		if (!authorizationUrl) {
			await this.host.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.host.setStateAsync('oauth.status', { val: 'missing_authorization_endpoint', ack: true });
			this.host.log.warn(
				'Authorization endpoint is not configured in adapter constants. OAuth login URL cannot be generated.',
			);
			return;
		}

		const authorizationValidation = this.validateAuthorizationUrl(authorizationUrl);
		if (!authorizationValidation.valid) {
			await this.host.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.host.setStateAsync('oauth.status', { val: 'invalid_authorization_url', ack: true });
			this.host.log.error(`Invalid authorizationUrl: ${authorizationValidation.reason}`);
			return;
		}

		if (!this.host.config.clientId?.trim()) {
			await this.host.setStateAsync('oauth.loginUrl', { val: '', ack: true });
			await this.host.setStateAsync('oauth.status', { val: 'missing_client_id', ack: true });
			this.host.log.warn('clientId is not configured. OAuth login URL cannot be generated.');
			return;
		}

		if (!this.host.config.clientSecret?.trim()) {
			await this.host.setStateAsync('oauth.status', { val: 'missing_client_secret', ack: true });
			this.host.log.warn(
				'clientSecret is not configured. OAuth flow may complete, but token exchange will fail.',
			);
		}

		this.oauthState = randomUUID();
		const redirectUri = `http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`;
		const loginUrl = `${authorizationUrl}?response_type=code&client_id=${encodeURIComponent(this.host.config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(this.oauthState)}`;

		await this.host.setStateAsync('oauth.loginUrl', { val: loginUrl, ack: true });
		await this.host.setStateAsync('oauth.status', { val: 'awaiting_authorization_code', ack: true });

		if (logToInfo) {
			this.host.log.info(`OAuth login URL: ${loginUrl}`);
		}
	}

	/** Refreshes the access token and requests the live vehicle data payload from Ford. */
	public async fetchVehicleData(): Promise<unknown> {
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
			await this.host.setStateAsync('oauth.status', { val: `authorization_error:${error}`, ack: true });
			this.respondText(res, 400, `OAuth authorization failed: ${error}`);
			return;
		}

		if (!code) {
			this.respondText(res, 400, 'Missing authorization code');
			return;
		}

		if (!state || state !== this.oauthState) {
			await this.host.setStateAsync('oauth.status', { val: 'state_mismatch', ack: true });
			this.respondText(res, 400, 'State mismatch');
			return;
		}

		await this.host.setStateAsync('oauth.authorizationCode', { val: code, ack: true, expire: 120 });
		await this.host.setStateAsync('oauth.status', { val: 'authorization_code_received', ack: true });

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
		if (!this.host.config.clientId?.trim() || !this.host.config.clientSecret?.trim()) {
			await this.host.setStateAsync('oauth.status', { val: 'missing_client_credentials', ack: true });
			return { ok: false, message: 'Missing clientId/clientSecret in adapter config' };
		}

		const tokenEndpoint = this.tokenEndpoint();
		if (!tokenEndpoint) {
			await this.host.setStateAsync('oauth.status', { val: 'missing_token_endpoint', ack: true });
			return { ok: false, message: 'Missing token endpoint in adapter constants' };
		}

		const redirectUri = `http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`;
		const payload = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: this.host.config.clientId,
			client_secret: this.host.config.clientSecret,
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
				this.host.log.error(`OAuth token exchange failed: ${errorMessage}; body=${JSON.stringify(data)}`);
				await this.host.setStateAsync('oauth.status', { val: 'token_exchange_failed', ack: true });
				return { ok: false, message: errorMessage };
			}

			const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
			if (!refreshToken) {
				this.host.log.error(
					`OAuth token exchange succeeded but no refresh_token returned: ${JSON.stringify(data)}`,
				);
				await this.host.setStateAsync('oauth.status', { val: 'missing_refresh_token', ack: true });
				return { ok: false, message: 'No refresh_token in response' };
			}

			await this.persistRefreshToken(refreshToken);
			await this.host.setStateAsync('oauth.status', { val: 'login_successful', ack: true });
			this.host.log.info('OAuth login successful. Refresh token stored in adapter configuration.');
			return { ok: true, message: 'ok' };
		} catch (error) {
			const message = (error as Error).message;
			this.host.log.error(`OAuth token exchange request failed: ${message}`);
			await this.host.setStateAsync('oauth.status', { val: 'token_exchange_request_failed', ack: true });
			return { ok: false, message };
		}
	}

	private async persistRefreshToken(refreshToken: string): Promise<void> {
		const instanceId = `system.adapter.${this.host.namespace}`;
		const instanceObject = await this.host.getForeignObjectAsync(instanceId);
		if (!instanceObject) {
			this.host.log.error(`Cannot persist refresh token. Instance object not found: ${instanceId}`);
			return;
		}

		instanceObject.native = {
			...instanceObject.native,
			refreshToken,
		};

		await this.host.setForeignObjectAsync(instanceId, instanceObject);
		this.host.config.refreshToken = refreshToken;
	}

	private async refreshOAuthToken(): Promise<string> {
		const tokenEndpoint = this.tokenEndpoint();
		if (!tokenEndpoint) {
			throw new Error('Token endpoint is not configured in adapter constants.');
		}

		if (!this.host.config.refreshToken?.trim()) {
			throw new Error('refreshToken is missing. Please run OAuth login first.');
		}

		const payload = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: this.host.config.refreshToken,
			client_id: this.host.config.clientId,
			client_secret: this.host.config.clientSecret,
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

		if (nextRefreshToken && nextRefreshToken !== this.host.config.refreshToken) {
			await this.persistRefreshToken(nextRefreshToken);
		}

		return accessToken;
	}
}
