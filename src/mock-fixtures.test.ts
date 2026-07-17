import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadFixture(relativePath: string): unknown {
	const absolute = path.resolve(process.cwd(), relativePath);
	return JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
}

describe('mock fixtures', () => {
	it('single-normal fixture is valid JSON object', () => {
		const payload = loadFixture('mock/fixtures/single-normal.json');
		expect(payload).to.be.an('object');
		expect((payload as Record<string, unknown>).vin).to.equal('MOCK_SINGLE_NORMAL_001');
	});

	it('multi-vehicle fixture contains a vehicle array', () => {
		const payload = loadFixture('mock/fixtures/multi-vehicle.json') as Record<string, unknown>;
		expect(payload.vehicles).to.be.an('array');
		expect((payload.vehicles as unknown[]).length).to.equal(2);
	});

	it('sparse-edge fixture contains edge-case values', () => {
		const payload = loadFixture('mock/fixtures/sparse-edge.json') as Record<string, unknown>;
		expect(payload.vehicles).to.be.an('array');
		const vehicles = payload.vehicles as Array<Record<string, unknown>>;
		expect(vehicles[0].vehicleIdentificationNumber).to.equal('MOCK_SPARSE_EDGE_001');
		expect(vehicles[1].vin).to.equal('MOCK_SPARSE_EDGE_002');
	});
});
