import { MetadataFieldDefinition } from '../metadata-schemas';

interface UnitDefinition {
	dimension: string;
	/** Multiplier to the canonical unit of the dimension. */
	factor: number;
	/** Offset added after scaling, used for temperature scales. */
	offset?: number;
}

const CANONICAL_UNITS: Readonly<Record<string, string>> = {
	temperature: 'K',
	pressure: 'bar',
	time: 'ps',
	length: 'nm',
	energy: 'kJ/mol',
};

/** Per-field overrides of the canonical unit; the time step stays in fs while other durations use ps. */
const FIELD_CANONICAL_UNITS: Readonly<Record<string, { unit: string; dimension: string; factor: number }>> = {
	time_step: { unit: 'fs', dimension: 'time', factor: 1e-3 },
};

const UNITS: Readonly<Record<string, UnitDefinition>> = {
	k: { dimension: 'temperature', factor: 1 },
	kelvin: { dimension: 'temperature', factor: 1 },
	kelvins: { dimension: 'temperature', factor: 1 },
	c: { dimension: 'temperature', factor: 1, offset: 273.15 },
	degc: { dimension: 'temperature', factor: 1, offset: 273.15 },
	celsius: { dimension: 'temperature', factor: 1, offset: 273.15 },
	f: { dimension: 'temperature', factor: 5 / 9, offset: 255.372222222222 },
	degf: { dimension: 'temperature', factor: 5 / 9, offset: 255.372222222222 },
	fahrenheit: { dimension: 'temperature', factor: 5 / 9, offset: 255.372222222222 },

	bar: { dimension: 'pressure', factor: 1 },
	bars: { dimension: 'pressure', factor: 1 },
	mbar: { dimension: 'pressure', factor: 0.001 },
	atm: { dimension: 'pressure', factor: 1.01325 },
	atmosphere: { dimension: 'pressure', factor: 1.01325 },
	atmospheres: { dimension: 'pressure', factor: 1.01325 },
	pa: { dimension: 'pressure', factor: 1e-5 },
	pascal: { dimension: 'pressure', factor: 1e-5 },
	kpa: { dimension: 'pressure', factor: 1e-2 },
	mpa: { dimension: 'pressure', factor: 10 },
	gpa: { dimension: 'pressure', factor: 1e4 },

	as: { dimension: 'time', factor: 1e-6 },
	fs: { dimension: 'time', factor: 1e-3 },
	femtosecond: { dimension: 'time', factor: 1e-3 },
	femtoseconds: { dimension: 'time', factor: 1e-3 },
	ps: { dimension: 'time', factor: 1 },
	picosecond: { dimension: 'time', factor: 1 },
	picoseconds: { dimension: 'time', factor: 1 },
	ns: { dimension: 'time', factor: 1e3 },
	nanosecond: { dimension: 'time', factor: 1e3 },
	nanoseconds: { dimension: 'time', factor: 1e3 },
	us: { dimension: 'time', factor: 1e6 },
	'µs': { dimension: 'time', factor: 1e6 },
	microsecond: { dimension: 'time', factor: 1e6 },
	microseconds: { dimension: 'time', factor: 1e6 },
	ms: { dimension: 'time', factor: 1e9 },

	nm: { dimension: 'length', factor: 1 },
	nanometer: { dimension: 'length', factor: 1 },
	nanometers: { dimension: 'length', factor: 1 },
	a: { dimension: 'length', factor: 0.1 },
	'å': { dimension: 'length', factor: 0.1 },
	angstrom: { dimension: 'length', factor: 0.1 },
	angstroms: { dimension: 'length', factor: 0.1 },
	pm: { dimension: 'length', factor: 1e-3 },
	um: { dimension: 'length', factor: 1e3 },
	m: { dimension: 'length', factor: 1e9 },

	'kj/mol': { dimension: 'energy', factor: 1 },
	'kilojoule/mole': { dimension: 'energy', factor: 1 },
	'kilojoules/mole': { dimension: 'energy', factor: 1 },
	'j/mol': { dimension: 'energy', factor: 1e-3 },
	'kcal/mol': { dimension: 'energy', factor: 4.184 },
	'kilocalorie/mole': { dimension: 'energy', factor: 4.184 },
	'kilocalories/mole': { dimension: 'energy', factor: 4.184 },
};

const QUANTITY_PATTERN = /^([+-]?(?:\d+(?:[._]\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*(?:\*\s*)?(.*)$/i;
const SIGNIFICANT_DIGITS = 10;

/** Standardizes number-with-unit values to one canonical unit per physical dimension. */
export class UnitNormalizer {
	/** Normalizes one quantity such as "0.002 ps" or "2 * openmm.unit.femtoseconds" to "2 fs". Unknown units are kept as written. */
	normalize(value: string, fieldKey?: string): string {
		const text = value.trim().replace(/\s+/g, ' ');
		const match = QUANTITY_PATTERN.exec(text);
		if (!match) return text;

		const amount = Number.parseFloat(match[1]!.replaceAll('_', ''));
		const unitText = this.cleanUnitText(match[2] ?? '');
		if (!Number.isFinite(amount) || !unitText) return text;

		const unit = UNITS[unitText.toLocaleLowerCase()];
		if (!unit) return `${match[1]} ${unitText}`;

		const override = fieldKey ? FIELD_CANONICAL_UNITS[fieldKey] : undefined;
		if (override && override.dimension === unit.dimension) {
			const scaled = (amount * unit.factor) / override.factor;
			return `${this.formatNumber(scaled)} ${override.unit}`;
		}
		const converted = amount * unit.factor + (unit.offset ?? 0);
		return `${this.formatNumber(converted)} ${CANONICAL_UNITS[unit.dimension]}`;
	}

	/** Normalizes every number_with_unit value in a metadata record, leaving other fields untouched. */
	normalizeMetadata<T extends string | number | boolean | null | undefined>(
		fields: readonly MetadataFieldDefinition[],
		metadata: Partial<Record<string, T>>,
	): Partial<Record<string, T>> {
		const result = { ...metadata };
		for (const field of fields) {
			const value = result[field.key];
			if (field.type === 'number_with_unit' && typeof value === 'string') result[field.key] = this.normalize(value, field.key) as T;
		}
		return result;
	}

	private cleanUnitText(unitText: string): string {
		return unitText
			.trim()
			.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, '')
			.replace(/\s*\/\s*/g, '/')
			.replace(/^°\s*/, '')
			.replace(/\.$/, '');
	}

	private formatNumber(value: number): string {
		return String(Number.parseFloat(value.toPrecision(SIGNIFICANT_DIGITS)));
	}
}

export const unitNormalizer = new UnitNormalizer();
