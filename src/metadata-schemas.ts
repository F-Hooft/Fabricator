import { DataAdapter } from 'obsidian';

export const METADATA_SCHEMAS_FOLDER = '.metadata_schemas';
export const DEFAULT_METADATA_SCHEMA_FILE = 'default.json';
export const METADATA_FIELD_TYPES = ['string', 'number_with_unit', 'integer', 'boolean'] as const;

export type MetadataFieldType = (typeof METADATA_FIELD_TYPES)[number];

export interface MetadataFieldDefinition {
	key: string;
	label: string;
	type: MetadataFieldType;
	description: string;
	heuristicPatterns?: readonly string[];
	heuristicMatchMode?: 'last' | 'all';
	required: boolean;
	includeInFrontmatter: boolean;
}

export interface MetadataSchema {
	name: string;
	fields: readonly MetadataFieldDefinition[];
}

export interface MetadataSchemaLoadResult {
	schemas: Map<string, MetadataSchema>;
	duplicateFiles: string[];
}

export const DEFAULT_METADATA_SCHEMA: MetadataSchema = {
	name: 'OpenMM molecular dynamics',
	fields: [
		{ key: 'run_name', label: 'Run name', type: 'string', required: false, includeInFrontmatter: true, description: 'Short identifier for the run, kept concise when it is strongly implied by the script or config.' },
		{ key: 'workflow_name', label: 'Workflow', type: 'string', required: false, includeInFrontmatter: true, description: 'Simulation workflow or protocol name such as equilibration, production, heating, or minimization.' },
		{ key: 'engine_version', label: 'Engine version', type: 'string', required: false, includeInFrontmatter: true, description: 'MD engine version if it is explicitly mentioned in code or comments.' },
		{ key: 'method', label: 'Method', type: 'string', required: true, includeInFrontmatter: true, description: 'Simulation type inferred from integrators, ensembles, or setup, such as classical_md, nvt_md, npt_md, minimization, or steered_md.' },
		{ key: 'force_field', label: 'Force field', type: 'string', required: false, includeInFrontmatter: true, description: 'Force field XML file names found in active source code.', heuristicPatterns: ["['\\\"]([^'\\\"]+\\.xml)['\\\"]"], heuristicMatchMode: 'all' },
		{ key: 'temperature', label: 'Temperature', type: 'number_with_unit', required: true, includeInFrontmatter: true, description: 'Temperature as written in the source, for example 300 K, 310 kelvin, or 25 celsius.', heuristicPatterns: ["([0-9]+(?:\\.[0-9]+)?\\s*\\*\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(?:kelvin|celsius|degC|K))"] },
		{ key: 'pressure_coupling', label: 'Pressure coupling', type: 'boolean', required: true, includeInFrontmatter: true, description: 'Boolean flag: true when an active barostat is configured.', heuristicPatterns: ["\\b([A-Za-z_]*barostat[A-Za-z_]*)\\b"] },
		{ key: 'pressure', label: 'Pressure', type: 'number_with_unit', required: false, includeInFrontmatter: true, description: 'Pressure as written in the source, such as 1 bar, 1 atm, or 101.325 kPa.', heuristicPatterns: ["([0-9]+(?:\\.[0-9]+)?\\s*\\*\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(?:bar|atm|atmospheres?|Pa|kPa|MPa))"] },
		{ key: 'time_step', label: 'Time step', type: 'number_with_unit', required: true, includeInFrontmatter: true, description: 'Integrator time step as written in the source, for example 2 fs, 0.004 ps, or 0.000002 ns.', heuristicPatterns: ["([0-9]+(?:\\.[0-9]+)?\\s*\\*\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(?:femtoseconds?|picoseconds?|nanoseconds?|fs|ps|ns))"] },
		{ key: 'total_steps', label: 'Total steps', type: 'integer', required: true, includeInFrontmatter: true, description: 'Total number of integration steps executed by the run.', heuristicPatterns: ["(?:simulation|sim)\\.step\\(\\s*([0-9_]+)\\s*\\)"] },
	],
};

export async function ensureMetadataSchemas(adapter: DataAdapter): Promise<void> {
	// Seed an editable example only when the vault does not already provide one.
	if (!(await adapter.exists(METADATA_SCHEMAS_FOLDER))) {
		await adapter.mkdir(METADATA_SCHEMAS_FOLDER);
	}

	const defaultSchemaPath = metadataSchemaPath(DEFAULT_METADATA_SCHEMA_FILE);
	if (!(await adapter.exists(defaultSchemaPath))) {
		await adapter.write(defaultSchemaPath, `${JSON.stringify(DEFAULT_METADATA_SCHEMA, null, 2)}\n`);
	}
}

export async function listMetadataSchemaFiles(adapter: DataAdapter): Promise<string[]> {
	await ensureMetadataSchemas(adapter);
	const listing = await adapter.list(METADATA_SCHEMAS_FOLDER);
	return listing.files
		.filter((path) => path.toLowerCase().endsWith('.json'))
		.map((path) => path.slice(`${METADATA_SCHEMAS_FOLDER}/`.length))
		.sort((left, right) => left.localeCompare(right));
}

export async function loadMetadataSchema(adapter: DataAdapter, fileName: string): Promise<MetadataSchema> {
	if (!fileName || fileName.includes('/') || fileName.includes('\\') || !fileName.toLowerCase().endsWith('.json')) {
		throw new Error('Metadata schema selection must be a JSON file in the metadata schemas folder.');
	}

	const schemaPath = metadataSchemaPath(fileName);
	if (!(await adapter.exists(schemaPath))) {
		throw new Error(`Metadata schema file does not exist: ${fileName}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await adapter.read(schemaPath));
	} catch (error) {
		throw new Error(`Metadata schema ${fileName} is not valid JSON: ${String(error)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Metadata schema ${fileName} must contain a name and fields array.`);
	}
	const schema = parsed as Partial<MetadataSchema>;
	if (typeof schema.name !== 'string' || !schema.name.trim()) {
		throw new Error(`Metadata schema ${fileName} must have a non-empty name.`);
	}
	if (!Array.isArray(schema.fields)) {
		throw new Error(`Metadata schema ${fileName} must contain a fields array.`);
	}

	const keys = new Set<string>();
	const fields = schema.fields.map((value, index) => {
		const field = validateMetadataField(value, index);
		if (keys.has(field.key.toLocaleLowerCase())) {
			throw new Error(`Metadata schema ${fileName} defines the key "${field.key}" more than once.`);
		}
		keys.add(field.key.toLocaleLowerCase());
		return field;
	});
	return { name: schema.name.trim(), fields };
}

export async function loadAllMetadataSchemas(adapter: DataAdapter): Promise<MetadataSchemaLoadResult> {
	const schemas = new Map<string, MetadataSchema>();
	const schemaNames = new Set<string>();
	const duplicateFiles: string[] = [];
	for (const fileName of await listMetadataSchemaFiles(adapter)) {
		const schema = await loadMetadataSchema(adapter, fileName);
		const normalizedName = schema.name.toLocaleLowerCase();
		if (schemaNames.has(normalizedName)) {
			// Filename order is deterministic, so the first valid schema remains the winner.
			duplicateFiles.push(`${fileName} (duplicate schema name "${schema.name}")`);
			continue;
		}
		schemaNames.add(normalizedName);
		schemas.set(schema.name, schema);
	}
	return { schemas, duplicateFiles };
}

function metadataSchemaPath(fileName: string): string {
	return `${METADATA_SCHEMAS_FOLDER}/${fileName}`;
}

function validateMetadataField(value: unknown, index: number): MetadataFieldDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Metadata field ${index + 1} must be an object.`);
	}
	const field = value as Partial<MetadataFieldDefinition>;
	if (typeof field.key !== 'string' || !field.key.trim()) {
		throw new Error(`Metadata field ${index + 1} must have a non-empty key.`);
	}
	if (typeof field.label !== 'string' || !field.label.trim()) {
		throw new Error(`Metadata field ${index + 1} must have a non-empty label.`);
	}
	if (!METADATA_FIELD_TYPES.includes(field.type as MetadataFieldType)) {
		throw new Error(`Metadata field "${field.key}" has an unsupported type.`);
	}
	if (typeof field.description !== 'string' || typeof field.required !== 'boolean') {
		throw new Error(`Metadata field "${field.key}" must define description and required.`);
	}
	if (typeof field.includeInFrontmatter !== 'boolean') {
		throw new Error(`Metadata field "${field.key}" must define includeInFrontmatter as true or false.`);
	}
	if (field.heuristicPatterns !== undefined && (!Array.isArray(field.heuristicPatterns) || field.heuristicPatterns.some((pattern) => typeof pattern !== 'string'))) {
		throw new Error(`Metadata field "${field.key}" has invalid heuristicPatterns.`);
	}
	if (field.heuristicMatchMode !== undefined && field.heuristicMatchMode !== 'last' && field.heuristicMatchMode !== 'all') {
		throw new Error(`Metadata field "${field.key}" has an invalid heuristicMatchMode.`);
	}
	for (const pattern of (field.heuristicPatterns ?? []) as unknown[]) {
		if (typeof pattern !== 'string') continue;
		try {
			new RegExp(pattern, 'i');
		} catch {
			throw new Error(`Metadata field "${field.key}" has an invalid heuristic pattern.`);
		}
	}
	return {
		key: field.key.trim(),
		label: field.label.trim(),
		type: field.type as MetadataFieldType,
		description: field.description,
		heuristicPatterns: field.heuristicPatterns,
		heuristicMatchMode: field.heuristicMatchMode,
		required: field.required,
		includeInFrontmatter: field.includeInFrontmatter,
	};
}