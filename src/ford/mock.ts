import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MOCK_DATA_PATH, DEFAULT_MOCK_PAYLOAD } from './const';

export type MockScenario = 'normal' | 'charging' | 'lowBattery';

/** Parameters for {@link loadMockVehicleData}. */
export interface LoadMockVehicleDataParams {
	/** Configured mock data file path (relative or absolute), if any. */
	configuredPath: string | undefined;
	/** Scenario to apply on top of the loaded payload. */
	scenario: MockScenario;
	/** Adapter installation directory, used to resolve relative mock data paths. */
	adapterDir: string;
	/** Logger used for debug/warn output while resolving and loading mock data. */
	log: Pick<ioBroker.Log, 'debug' | 'warn'>;
}

/**
 * Loads the mock vehicle payload from the configured file (falling back to the
 * built-in default payload if the file is missing) and applies the selected scenario.
 *
 * @param params Mock data source and scenario configuration.
 */
export async function loadMockVehicleData(params: LoadMockVehicleDataParams): Promise<unknown> {
	const mockPath = resolveMockDataPath(params.configuredPath, params.adapterDir);
	params.log.debug(`Using mock data from ${mockPath} (scenario: ${params.scenario})`);

	try {
		const raw = await readFile(mockPath, 'utf8');
		return applyMockScenario(JSON.parse(raw), params.scenario);
	} catch (error) {
		const errnoError = error as NodeJS.ErrnoException;
		if (errnoError.code === 'ENOENT') {
			params.log.warn(`Mock data file not found at ${mockPath}. Falling back to built-in mock payload.`);
			return applyMockScenario(DEFAULT_MOCK_PAYLOAD, params.scenario);
		}

		throw error;
	}
}

/**
 * Resolves the configured mock data path against a set of candidate base directories,
 * falling back to the first candidate if none of them exist.
 *
 * @param configuredPath Configured mock data file path (relative or absolute), if any.
 * @param adapterDir Adapter installation directory, used as one of the candidate bases.
 */
export function resolveMockDataPath(configuredPath: string | undefined, adapterDir: string): string {
	const configured = configuredPath?.trim() || DEFAULT_MOCK_DATA_PATH;
	if (path.isAbsolute(configured)) {
		return configured;
	}

	const candidates = [
		path.resolve(adapterDir, configured),
		path.resolve(adapterDir, '..', configured),
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

/**
 * Applies a mock scenario on top of a loaded payload, overriding battery/charging/status
 * fields on the first vehicle (or the payload itself, if it isn't a `vehicles` collection).
 *
 * @param payload Loaded mock payload (single vehicle, or object with a `vehicles` array).
 * @param scenario Scenario to apply.
 */
export function applyMockScenario(payload: unknown, scenario: MockScenario): unknown {
	if (scenario === 'normal') {
		return payload;
	}

	if (typeof payload !== 'object' || payload === null) {
		return payload;
	}

	const cloned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
	const vehicle = targetVehicleForScenario(cloned);
	if (!vehicle) {
		return cloned;
	}

	if (scenario === 'charging') {
		setDeep(vehicle, ['status'], 'charging');
		setDeep(vehicle, ['battery', 'soc'], 82);
		setDeep(vehicle, ['battery', 'range_km'], 325);
		setDeep(vehicle, ['charging', 'batteryLevel'], 0.82);
		setDeep(vehicle, ['charging', 'power_kw'], 11);
		setDeep(vehicle, ['charging', 'isCharging'], true);
	}

	if (scenario === 'lowBattery') {
		setDeep(vehicle, ['status'], 'low_battery');
		setDeep(vehicle, ['battery', 'soc'], 14);
		setDeep(vehicle, ['battery', 'range_km'], 48);
		setDeep(vehicle, ['charging', 'batteryLevel'], 0.14);
		setDeep(vehicle, ['charging', 'isCharging'], false);
	}

	return cloned;
}

function targetVehicleForScenario(root: Record<string, unknown>): Record<string, unknown> | null {
	const vehicles = root.vehicles;
	if (Array.isArray(vehicles) && vehicles.length > 0) {
		const first = vehicles[0];
		return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
	}

	return root;
}

function setDeep(root: Record<string, unknown>, parts: string[], value: unknown): void {
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
