// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			option1: string;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
