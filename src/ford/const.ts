/**
 * Constants describing Ford's OAuth/API surface. Endpoint URLs are resolved from
 * environment variables since they are not exposed in the Admin UI (see concept.md).
 */
export const OAUTH_REDIRECT_PORT = 8081;
export const OAUTH_REDIRECT_PATH = '/oauth';

export const DEFAULT_MOCK_DATA_PATH = 'mockData.json';

export const DEFAULT_AUTHORIZATION_URL = process.env.FORD_AUTHORIZATION_URL?.trim() || '';
export const DEFAULT_TOKEN_URL = process.env.FORD_TOKEN_URL?.trim() || '';
export const DEFAULT_VEHICLE_DATA_URL = process.env.FORD_VEHICLE_DATA_URL?.trim() || '';

export const DEFAULT_MOCK_PAYLOAD = {
	vin: 'VIRTUAL_EXPLORER_123',
	battery: {
		soc: 78,
		range_km: 310,
	},
	status: 'charging',
};
