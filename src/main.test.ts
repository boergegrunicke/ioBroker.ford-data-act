import { expect } from 'chai';
import { isMockEnabled, normalizeMockScenario, normalizeSoc } from './lib/runtime-config.ts';

describe('runtime-config helpers', () => {
	describe('isMockEnabled', () => {
		it('uses the explicit mock boolean only', () => {
			expect(isMockEnabled({ mock: true })).to.equal(true);
			expect(isMockEnabled({ mock: false })).to.equal(false);
		});
	});

	describe('normalizeMockScenario', () => {
		it('accepts supported scenarios and defaults unknown values', () => {
			expect(normalizeMockScenario('normal')).to.equal('normal');
			expect(normalizeMockScenario('charging')).to.equal('charging');
			expect(normalizeMockScenario('lowBattery')).to.equal('lowBattery');
			expect(normalizeMockScenario('somethingElse')).to.equal('normal');
			expect(normalizeMockScenario(undefined)).to.equal('normal');
		});
	});

	describe('normalizeSoc', () => {
		it('maps fractional values to percent and rounds', () => {
			expect(normalizeSoc(0.781)).to.equal(78);
			expect(normalizeSoc(0)).to.equal(0);
			expect(normalizeSoc(1)).to.equal(100);
		});

		it('accepts percent values directly', () => {
			expect(normalizeSoc(12.6)).to.equal(13);
			expect(normalizeSoc(100)).to.equal(100);
		});

		it('rejects out-of-range and invalid values', () => {
			expect(normalizeSoc(-1)).to.equal(null);
			expect(normalizeSoc(101)).to.equal(null);
			expect(normalizeSoc(null)).to.equal(null);
			expect(normalizeSoc(Number.NaN)).to.equal(null);
		});
	});
});
