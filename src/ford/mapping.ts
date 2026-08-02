import { normalizeSoc } from './config';

/** A single ioBroker state to create/update, relative to a vehicle's base channel. */
export interface VehicleStateSpec {
	/** State id relative to the vehicle base channel, e.g. `battery.soc`. */
	id: string;
	/** ioBroker object definition for this state. */
	common: ioBroker.StateCommon;
	/** Value to write to the state. */
	value: ioBroker.StateValue;
}

/** The result of mapping a raw Ford vehicle record to ioBroker states. */
export interface VehicleMapping {
	/** Vehicle identification number as reported by the payload. */
	vin: string;
	/** VIN normalized to a safe ioBroker object id segment. */
	vinId: string;
	/** States to create/update for this vehicle. */
	states: VehicleStateSpec[];
}

/**
 * Extracts individual vehicle records from a raw API/mock payload, which may be a
 * single vehicle object, an array of vehicles, or an object with a `vehicles` array.
 *
 * @param payload Raw payload as returned by the Ford API or the mock data source.
 */
export function extractVehicles(payload: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(payload)) {
		return payload.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
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

/**
 * Maps a single Ford vehicle record to the ioBroker states that should be created for it.
 * Kept free of ioBroker/adapter calls so the mapping itself is unit-testable in isolation.
 *
 * @param vehicle A single vehicle record extracted from the raw payload.
 */
export function mapVehicle(vehicle: Record<string, unknown>): VehicleMapping {
	const vin = extractString(vehicle.vin) || extractString(vehicle.vehicleIdentificationNumber) || 'unknown';
	const vinId = normalizeId(vin);
	const states: VehicleStateSpec[] = [];

	const socRaw =
		extractNumberFromPath(vehicle, ['battery', 'soc']) ??
		extractNumberFromPath(vehicle, ['battery', 'stateOfCharge']) ??
		extractNumberFromPath(vehicle, ['charging', 'batteryLevel']);
	const soc = normalizeSoc(socRaw);
	if (typeof soc === 'number') {
		states.push({
			id: 'battery.soc',
			common: {
				name: 'Battery SoC',
				type: 'number',
				role: 'value.battery',
				read: true,
				write: false,
				unit: '%',
			},
			value: soc,
		});
	}

	const range =
		extractNumberFromPath(vehicle, ['battery', 'range_km']) ??
		extractNumberFromPath(vehicle, ['battery', 'rangeKm']) ??
		extractNumberFromPath(vehicle, ['charging', 'estimatedRange']);
	if (typeof range === 'number') {
		states.push({
			id: 'battery.range_km',
			common: {
				name: 'Estimated Range',
				type: 'number',
				role: 'value.range',
				read: true,
				write: false,
				unit: 'km',
			},
			value: range,
		});
	}

	const status = extractString(vehicle.status) ?? extractString(vehicle.chargingStatus) ?? '';
	if (status) {
		states.push({
			id: 'status',
			common: {
				name: 'Vehicle status',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			},
			value: status,
		});
	}

	const odometer =
		extractNumberFromPath(vehicle, ['diagnostics', 'odometer']) ??
		extractNumberFromPath(vehicle, ['odometer']) ??
		extractNumberFromPath(vehicle, ['mileage']);
	if (typeof odometer === 'number') {
		states.push({
			id: 'odometer',
			common: {
				name: 'Odometer',
				type: 'number',
				role: 'value.distance',
				read: true,
				write: false,
				unit: 'km',
			},
			value: odometer,
		});
	}

	const chargingPower = extractNumberFromPath(vehicle, ['charging', 'power_kw']);
	if (typeof chargingPower === 'number') {
		states.push({
			id: 'charging.power_kw',
			common: {
				name: 'Charging power',
				type: 'number',
				role: 'value.power',
				read: true,
				write: false,
				unit: 'kW',
			},
			value: chargingPower,
		});
	}

	const isCharging =
		extractBooleanFromPath(vehicle, ['charging', 'isCharging']) ??
		extractString(vehicle.status)?.toLowerCase() === 'charging';
	if (typeof isCharging === 'boolean') {
		states.push({
			id: 'charging.isCharging',
			common: {
				name: 'Charging active',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
			},
			value: isCharging,
		});
	}

	const latitude =
		extractNumberFromPath(vehicle, ['location', 'latitude']) ??
		extractNumberFromPath(vehicle, ['position', 'latitude']);
	const longitude =
		extractNumberFromPath(vehicle, ['location', 'longitude']) ??
		extractNumberFromPath(vehicle, ['position', 'longitude']);
	if (typeof latitude === 'number' && typeof longitude === 'number') {
		states.push({
			id: 'location.latitude',
			common: {
				name: 'Latitude',
				type: 'number',
				role: 'value.gps.latitude',
				read: true,
				write: false,
			},
			value: latitude,
		});
		states.push({
			id: 'location.longitude',
			common: {
				name: 'Longitude',
				type: 'number',
				role: 'value.gps.longitude',
				read: true,
				write: false,
			},
			value: longitude,
		});
	}

	const insideTemp =
		extractNumberFromPath(vehicle, ['climate', 'insideTempC']) ??
		extractNumberFromPath(vehicle, ['climate', 'interiorTemperature']);
	if (typeof insideTemp === 'number') {
		states.push({
			id: 'climate.insideTempC',
			common: {
				name: 'Inside temperature',
				type: 'number',
				role: 'value.temperature',
				read: true,
				write: false,
				unit: '°C',
			},
			value: insideTemp,
		});
	}

	const doorsLocked =
		extractBooleanFromPath(vehicle, ['doors', 'locked']) ??
		extractBooleanFromPath(vehicle, ['security', 'doorsLocked']);
	if (typeof doorsLocked === 'boolean') {
		states.push({
			id: 'doors.locked',
			common: {
				name: 'Doors locked',
				type: 'boolean',
				role: 'indicator.lock',
				read: true,
				write: false,
			},
			value: doorsLocked,
		});
	}

	states.push({
		id: 'rawJson',
		common: {
			name: 'Raw vehicle payload',
			type: 'string',
			role: 'json',
			read: true,
			write: false,
		},
		value: JSON.stringify(vehicle),
	});

	return { vin, vinId, states };
}

function extractNumberFromPath(root: Record<string, unknown>, pathParts: string[]): number | null {
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

function extractString(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const normalized = value.trim();
	return normalized ? normalized : null;
}

function extractBooleanFromPath(root: Record<string, unknown>, pathParts: string[]): boolean | null {
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

function normalizeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
