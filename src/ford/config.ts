/**
 * Minimal subset of runtime config used by helper normalization functions.
 */
export interface RuntimeConfigLike {
	/** New v1 config flag: true -> mock mode, false -> live mode. */
	mock: boolean;
	/** Optional mock scenario identifier. */
	mockScenario?: string;
}

/**
 * Determines if mock mode is active.
 *
 * @param config Runtime config fragment from adapter settings.
 */
export function isMockEnabled(config: RuntimeConfigLike): boolean {
	return config.mock;
}

/**
 * Normalizes mock scenario values to the supported set.
 *
 * @param raw Raw scenario value from adapter config.
 */
export function normalizeMockScenario(raw: string | undefined): 'normal' | 'charging' | 'lowBattery' {
	if (raw === 'charging' || raw === 'lowBattery') {
		return raw;
	}
	return 'normal';
}

/**
 * Normalizes state-of-charge values to integer percent values.
 *
 * @param value State-of-charge input in fraction or percent form.
 */
export function normalizeSoc(value: number | null): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}

	if (value >= 0 && value <= 1) {
		return Math.round(value * 100);
	}

	if (value >= 0 && value <= 100) {
		return Math.round(value);
	}

	return null;
}
