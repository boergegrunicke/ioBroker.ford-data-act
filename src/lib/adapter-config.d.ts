// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
				mock: boolean;
			mockScenario: 'normal' | 'charging' | 'lowBattery';
			clientId: string;
			clientSecret: string;
				refreshToken?: string;
			interval: number;
			mockDataPath: string;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
