import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { METADATA_FIELD_TYPES, MetadataFieldDefinition, MetadataFieldType, MetadataSchema } from './metadata-schemas';
import type { ParsedRunResult } from './parser/base';

export type MetadataValue = string | number | boolean;
export type RunFileKind = 'discovered' | 'referenced';
export type RunDatabaseChange = { runId: string; type: 'updated' | 'deleted' };

/** Application-facing run data returned by database reads. */
export interface RunRecord {
	id: string;
	schemaId: string;
	schemaName: string;
	sourcePath: string | null;
	createdAt: string;
	updatedAt: string;
	metadata: Record<string, MetadataValue>;
}

/** Caller-supplied values used to create a run; timestamps are database-managed. */
export interface CreateRunOptions {
	schemaId: string;
	id?: string;
	sourcePath?: string;
	metadata?: Record<string, MetadataValue>;
}

/** A parsed result paired with the schema it was extracted against. */
export interface ImportParsedRunOptions {
	schemaId: string;
	id?: string;
	result: ParsedRunResult;
}

/** Application-facing file provenance data returned by database reads. */
export interface RunFileRecord {
	id: string;
	runId: string;
	path: string;
	fileName: string;
	kind: RunFileKind;
	presentInExperiment: boolean;
	skippedReason: string | null;
	discoveredFromPath: string | null;
	sha256: string | null;
	sizeBytes: number | null;
	modifiedAt: string | null;
	lastSeenAt: string;
}

/** Parser-supplied file data used to create or update a run file record. */
export interface UpsertRunFileOptions {
	path: string;
	fileName?: string;
	kind: RunFileKind;
	presentInExperiment: boolean;
	skippedReason?: string;
	discoveredFromPath?: string;
	sha256?: string;
	sizeBytes?: number;
	modifiedAt?: string;
}

/** Private SQLite row mapping for the `runs` table. */
interface RunRow {
	id: string;
	schema_id: string;
	schema_name: string;
	source_path: string | null;
	created_at: string;
	updated_at: string;
}

/** Private SQLite row mapping for a metadata value query. */
interface MetadataRow {
	field_key: string;
	value_json: string;
}

/** Private SQLite row mapping for the `metadata_fields` table. */
interface MetadataFieldRow {
	schema_id: string;
	key: string;
	label: string;
	type: MetadataFieldType;
	description: string;
	heuristic_patterns_json: string | null;
	heuristic_match_mode: 'last' | 'all' | null;
	required: number;
	include_in_frontmatter: number;
}

export interface MetadataSchemaRecord {
	id: string;
	name: string;
	importedAt: string;
	active: boolean;
	used: boolean;
	fields: MetadataSchema['fields'];
}

/** Private SQLite row mapping for the `run_files` table. */
interface RunFileRow {
	id: string;
	run_id: string;
	path: string;
	file_name: string;
	kind: RunFileKind;
	present_in_experiment: number;
	skipped_reason: string | null;
	discovered_from_path: string | null;
	sha256: string | null;
	size_bytes: number | null;
	modified_at: string | null;
	last_seen_at: string;
}

/**
 * Desktop-only SQLite persistence for simulation runs and their extensible metadata.
 */
export class RunDatabase {
	private readonly sqlite: DatabaseSync;
	private readonly changeListeners = new Set<(change: RunDatabaseChange) => void>();

	constructor(databasePath: string) {
		mkdirSync(dirname(databasePath), { recursive: true });
		this.sqlite = new DatabaseSync(databasePath);
		this.sqlite.exec('PRAGMA foreign_keys = ON;');
		this.sqlite.exec('PRAGMA journal_mode = WAL;');
		this.sqlite.exec('PRAGMA busy_timeout = 5000;');
	}

	initialize(): void {
		this.sqlite.exec(`
			CREATE TABLE IF NOT EXISTS metadata_schemas (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL CHECK (length(trim(name)) > 0),
				imported_at TEXT NOT NULL,
				active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
				used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
			);

			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				schema_id TEXT NOT NULL REFERENCES metadata_schemas(id),
				source_path TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE (id, schema_id)
			);

			CREATE TABLE IF NOT EXISTS metadata_fields (
				schema_id TEXT NOT NULL REFERENCES metadata_schemas(id) ON DELETE CASCADE,
				key TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(key)) > 0),
				label TEXT NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('string', 'number_with_unit', 'integer', 'boolean')),
				description TEXT NOT NULL DEFAULT '',
				heuristic_patterns_json TEXT,
				heuristic_match_mode TEXT CHECK (heuristic_match_mode IS NULL OR heuristic_match_mode IN ('last', 'all')),
				required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
				include_in_frontmatter INTEGER NOT NULL CHECK (include_in_frontmatter IN (0, 1)),
				is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
				PRIMARY KEY (schema_id, key)
			);

			CREATE TABLE IF NOT EXISTS run_metadata (
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				schema_id TEXT NOT NULL,
				field_key TEXT NOT NULL COLLATE NOCASE,
				value_json TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (run_id, field_key),
				FOREIGN KEY (run_id, schema_id) REFERENCES runs(id, schema_id) ON DELETE CASCADE,
				FOREIGN KEY (schema_id, field_key) REFERENCES metadata_fields(schema_id, key) ON DELETE RESTRICT
			);

			CREATE TABLE IF NOT EXISTS run_files (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				path TEXT NOT NULL,
				file_name TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('discovered', 'referenced')),
				present_in_experiment INTEGER NOT NULL CHECK (present_in_experiment IN (0, 1)),
				skipped_reason TEXT,
				discovered_from_path TEXT,
				sha256 TEXT,
				size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
				modified_at TEXT,
				last_seen_at TEXT NOT NULL,
				UNIQUE (run_id, path)
			);

			CREATE INDEX IF NOT EXISTS run_metadata_field_key_idx ON run_metadata(schema_id, field_key);
			CREATE INDEX IF NOT EXISTS run_files_run_id_idx ON run_files(run_id);
			CREATE INDEX IF NOT EXISTS run_files_sha256_idx ON run_files(sha256) WHERE sha256 IS NOT NULL;
		`);

	}

	close(): void {
		this.sqlite.close();
	}

	createRun(options: CreateRunOptions): RunRecord {
		const run = this.withTransaction(() => this.createRunInternal(options));
		this.notifyChange({ runId: run.id, type: 'updated' });
		return run;
	}

	/** Creates a run from the shared parser/LLM result shape and persists its file provenance. */
	importParsedRun(options: ImportParsedRunOptions): RunRecord {
		const run = this.withTransaction(() => {
			const run = this.createRunInternal({
				schemaId: options.schemaId,
				id: options.id,
				sourcePath: options.result.sourcePath,
				metadata: Object.fromEntries(
					Object.entries(options.result.metadata)
						.filter((entry): entry is [string, MetadataValue] => entry[1] !== undefined),
				),
			});
			this.sqlite.prepare('UPDATE metadata_schemas SET used = 1 WHERE id = ?').run(options.schemaId);
			for (const file of options.result.files) {
				this.upsertRunFile(run.id, {
					...file,
					presentInExperiment: file.isPresentInExperiment,
				});
			}
			return this.getRun(run.id) as RunRecord;
		});
		this.notifyChange({ runId: run.id, type: 'updated' });
		return run;
	}

	onChange(listener: (change: RunDatabaseChange) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	getDataVersion(): number {
		const row = this.sqlite.prepare('PRAGMA data_version').get() as { data_version: number };
		return row.data_version;
	}

	private createRunInternal(options: CreateRunOptions): RunRecord {
		if (!options.schemaId?.trim()) {
			throw new Error('Runs must record the ID of the metadata schema used for extraction.');
		}
		const schema = this.sqlite.prepare('SELECT id FROM metadata_schemas WHERE id = ? AND active = 1').get(options.schemaId) as { id: string } | undefined;
		if (!schema) throw new Error(`Cannot use unknown or inactive metadata schema: ${options.schemaId}`);
		const id = options.id ?? randomUUID();
		const now = this.timestamp();
		this.sqlite
			.prepare('INSERT INTO runs (id, schema_id, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
			.run(id, options.schemaId.trim(), options.sourcePath ?? null, now, now);
		for (const [key, value] of Object.entries(options.metadata ?? {})) {
			this.setMetadata(id, key, value);
		}
		return this.getRun(id) as RunRecord;
	}

	getRun(id: string): RunRecord | null {
		const run = this.sqlite.prepare('SELECT runs.*, metadata_schemas.name AS schema_name FROM runs JOIN metadata_schemas ON metadata_schemas.id = runs.schema_id WHERE runs.id = ?').get(id) as RunRow | undefined;
		if (!run) {
			return null;
		}

		const rows = this.sqlite
			.prepare('SELECT field_key, value_json FROM run_metadata WHERE run_id = ? ORDER BY field_key')
			.all(id) as unknown as MetadataRow[];
		const metadata: Record<string, MetadataValue> = {};
		for (const row of rows) {
			metadata[row.field_key] = this.decodeValue(row.value_json);
		}

		return {
			id: run.id,
			schemaId: run.schema_id,
			schemaName: run.schema_name,
			sourcePath: run.source_path,
			createdAt: run.created_at,
			updatedAt: run.updated_at,
			metadata,
		};
	}

	listRuns(): RunRecord[] {
		const rows = this.sqlite.prepare('SELECT id FROM runs ORDER BY created_at DESC').all() as Array<{ id: string }>;
		return rows.map((row) => this.getRun(row.id) as RunRecord);
	}

	listMetadataSchemaNames(): string[] {
		return (this.sqlite.prepare('SELECT name FROM metadata_schemas ORDER BY name COLLATE NOCASE').all() as Array<{ name: string }>)
			.map((row) => row.name);
	}

	listMetadataSchemas(activeOnly = false): MetadataSchemaRecord[] {
		const condition = activeOnly ? ' WHERE active = 1' : '';
		return (this.sqlite.prepare(`SELECT id, name, imported_at, active, used FROM metadata_schemas${condition} ORDER BY name COLLATE NOCASE, imported_at`).all() as Array<{ id: string; name: string; imported_at: string; active: number; used: number }>)
			.map((row) => ({
				id: row.id,
				name: row.name,
				importedAt: row.imported_at,
				active: row.active === 1,
				used: row.used === 1,
				fields: this.listMetadataFields(row.id),
			}));
	}

	getMetadataSchema(id: string): MetadataSchemaRecord | null {
		const row = this.sqlite.prepare('SELECT id, name, imported_at, active, used FROM metadata_schemas WHERE id = ?').get(id) as { id: string; name: string; imported_at: string; active: number; used: number } | undefined;
		if (!row) return null;
		return { id: row.id, name: row.name, importedAt: row.imported_at, active: row.active === 1, used: row.used === 1, fields: this.listMetadataFields(id) };
	}

	findMetadataSchemaByName(name: string, activeOnly = false): MetadataSchemaRecord[] {
		const condition = activeOnly ? ' AND active = 1' : '';
		return (this.sqlite.prepare(`SELECT id, name, imported_at, active, used FROM metadata_schemas WHERE name = ? COLLATE NOCASE${condition} ORDER BY imported_at`).all(name).map((row) => row as { id: string; name: string; imported_at: string; active: number; used: number }))
			.map((row) => ({ id: row.id, name: row.name, importedAt: row.imported_at, active: row.active === 1, used: row.used === 1, fields: this.listMetadataFields(row.id) }));
	}

	deactivateMetadataSchema(id: string, name: string): void {
		this.sqlite.prepare('UPDATE metadata_schemas SET name = ?, active = 0 WHERE id = ?').run(name, id);
	}

	deleteMetadataSchema(id: string): boolean {
		const schema = this.getMetadataSchema(id);
		if (!schema || schema.used) return false;
		return this.sqlite.prepare('DELETE FROM metadata_schemas WHERE id = ?').run(id).changes > 0;
	}

	setMetadata(runId: string, key: string, value: MetadataValue): void {
		this.assertMetadataKey(key);
		// A run's schema determines which catalog field definition owns this value.
		const schemaId = this.getRunSchemaId(runId);
		this.ensureMetadataField(schemaId, key);
		const now = this.timestamp();
		this.sqlite
			.prepare(`
				INSERT INTO run_metadata (run_id, schema_id, field_key, value_json, updated_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(run_id, field_key) DO UPDATE SET
					value_json = excluded.value_json,
					updated_at = excluded.updated_at
			`)
			.run(runId, schemaId, key, JSON.stringify(value), now);
		this.sqlite.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(now, runId);
		this.notifyChange({ runId, type: 'updated' });
	}

	removeMetadata(runId: string, key: string): boolean {
		const result = this.sqlite
			.prepare('DELETE FROM run_metadata WHERE run_id = ? AND field_key = ?')
			.run(runId, key);
		if (result.changes > 0) {
			this.sqlite.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(this.timestamp(), runId);
			this.notifyChange({ runId, type: 'updated' });
			return true;
		}
		return false;
	}

	listMetadataFields(schemaId: string): MetadataFieldDefinition[] {
		return this.sqlite
			.prepare('SELECT schema_id, key, label, type, description, heuristic_patterns_json, heuristic_match_mode, required, include_in_frontmatter FROM metadata_fields WHERE schema_id = ? ORDER BY is_builtin DESC, label COLLATE NOCASE')
			.all(schemaId)
			.map((row) => {
				const field = row as unknown as MetadataFieldRow;
				return {
					key: field.key,
					label: field.label,
					type: field.type,
					description: field.description,
					heuristicPatterns: field.heuristic_patterns_json ? JSON.parse(field.heuristic_patterns_json) as string[] : undefined,
					heuristicMatchMode: field.heuristic_match_mode ?? undefined,
					required: field.required === 1,
					includeInFrontmatter: field.include_in_frontmatter === 1,
				};
			});
	}

	upsertMetadataField(schemaId: string, definition: MetadataFieldDefinition, isBuiltin = false): void {
		this.ensureMetadataSchema(schemaId);
		this.assertMetadataKey(definition.key);
		if (!METADATA_FIELD_TYPES.includes(definition.type)) {
			throw new Error(`Unsupported metadata field type: ${definition.type}`);
		}
		this.sqlite
			.prepare(`
				INSERT INTO metadata_fields (schema_id, key, label, type, description, heuristic_patterns_json, heuristic_match_mode, required, include_in_frontmatter, is_builtin)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(schema_id, key) DO UPDATE SET
					label = excluded.label,
					type = excluded.type,
					description = excluded.description,
					heuristic_patterns_json = excluded.heuristic_patterns_json,
					heuristic_match_mode = excluded.heuristic_match_mode,
					required = excluded.required,
					include_in_frontmatter = excluded.include_in_frontmatter,
					is_builtin = MAX(metadata_fields.is_builtin, excluded.is_builtin)
			`)
			.run(schemaId, definition.key, definition.label, definition.type, definition.description, definition.heuristicPatterns ? JSON.stringify(definition.heuristicPatterns) : null, definition.heuristicMatchMode ?? null, Number(definition.required), Number(definition.includeInFrontmatter), Number(isBuiltin));
	}

	synchronizeMetadataSchema(schema: MetadataSchema, isBuiltin = false): MetadataSchemaRecord {
		const existing = this.findMetadataSchemaByName(schema.name, true)[0];
		const schemaId = existing?.id ?? randomUUID();
		this.withTransaction(() => {
			if (!existing) this.sqlite.prepare('INSERT INTO metadata_schemas (id, name, imported_at, active, used) VALUES (?, ?, ?, 1, 0)').run(schemaId, schema.name, this.timestamp());
			for (const definition of schema.fields) {
				this.upsertMetadataField(schemaId, definition, isBuiltin);
			}
		});
		return this.getMetadataSchema(schemaId) as MetadataSchemaRecord;
	}

	upsertRunFile(runId: string, options: UpsertRunFileOptions): RunFileRecord {
		this.getRunSchemaId(runId);
		if (!options.path.trim()) {
			throw new Error('Run file paths must not be empty.');
		}
		if (options.kind !== 'discovered' && options.kind !== 'referenced') {
			throw new Error(`Unsupported run file kind: ${String(options.kind)}`);
		}
		if (options.sizeBytes !== undefined && (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 0)) {
			throw new Error('Run file size must be a non-negative integer.');
		}
		const now = this.timestamp();
		const fileName = options.fileName?.trim() || this.fileNameFromPath(options.path);
		this.sqlite
			.prepare(`
				INSERT INTO run_files (id, run_id, path, file_name, kind, present_in_experiment, skipped_reason, discovered_from_path, sha256, size_bytes, modified_at, last_seen_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(run_id, path) DO UPDATE SET
					file_name = excluded.file_name,
					kind = excluded.kind,
					present_in_experiment = excluded.present_in_experiment,
					skipped_reason = excluded.skipped_reason,
					discovered_from_path = excluded.discovered_from_path,
					sha256 = excluded.sha256,
					size_bytes = excluded.size_bytes,
					modified_at = excluded.modified_at,
					last_seen_at = excluded.last_seen_at
			`)
			.run(randomUUID(), runId, options.path, fileName, options.kind, Number(options.presentInExperiment), options.skippedReason ?? null, options.discoveredFromPath ?? null, options.sha256 ?? null, options.sizeBytes ?? null, options.modifiedAt ?? null, now);
		this.sqlite.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(now, runId);
		this.notifyChange({ runId, type: 'updated' });
		return this.getRunFile(runId, options.path) as RunFileRecord;
	}

	listRunFiles(runId: string): RunFileRecord[] {
		return (this.sqlite.prepare('SELECT * FROM run_files WHERE run_id = ? ORDER BY path').all(runId) as unknown as RunFileRow[])
			.map((row) => this.toRunFileRecord(row));
	}

	removeRunFile(runId: string, path: string): boolean {
		return this.sqlite.prepare('DELETE FROM run_files WHERE run_id = ? AND path = ?').run(runId, path).changes > 0;
	}

	deleteCustomMetadataField(schemaId: string, key: string): boolean {
		const result = this.sqlite
			.prepare('DELETE FROM metadata_fields WHERE schema_id = ? AND key = ? AND is_builtin = 0')
			.run(schemaId, key);
		return result.changes > 0;
	}

	deleteRun(id: string): boolean {
		const result = this.sqlite.prepare('DELETE FROM runs WHERE id = ?').run(id);
		if (result.changes > 0) this.notifyChange({ runId: id, type: 'deleted' });
		return result.changes > 0;
	}

	private ensureMetadataField(schemaId: string, key: string): void {
		const field = this.sqlite.prepare('SELECT key FROM metadata_fields WHERE schema_id = ? AND key = ?').get(schemaId, key);
		if (!field) {
			this.upsertMetadataField(schemaId, {
				key,
				label: key,
				type: 'string',
				description: 'User-defined metadata field.',
				required: false,
				includeInFrontmatter: false,
			});
		}
	}

	private getRunSchemaId(id: string): string {
		const run = this.sqlite.prepare('SELECT schema_id FROM runs WHERE id = ?').get(id) as { schema_id: string } | undefined;
		if (!run) {
			throw new Error(`Cannot store metadata for unknown run: ${id}`);
		}
		return run.schema_id;
	}

	private ensureMetadataSchema(id: string): void {
		if (!id.trim()) {
			throw new Error('Metadata schema IDs must not be empty.');
		}
		const schema = this.sqlite.prepare('SELECT id FROM metadata_schemas WHERE id = ?').get(id);
		if (!schema) throw new Error(`Unknown metadata schema: ${id}`);
	}

	private assertMetadataKey(key: string): void {
		if (!key.trim()) {
			throw new Error('Metadata field keys must not be empty.');
		}
	}

	private decodeValue(value: string): MetadataValue {
		const decoded: unknown = JSON.parse(value);
		if (typeof decoded !== 'string' && typeof decoded !== 'number' && typeof decoded !== 'boolean') {
			throw new Error('Stored metadata value is not a supported primitive.');
		}
		return decoded;
	}

	private timestamp(): string {
		return new Date().toISOString();
	}

	private getRunFile(runId: string, path: string): RunFileRecord | null {
		const row = this.sqlite.prepare('SELECT * FROM run_files WHERE run_id = ? AND path = ?').get(runId, path) as unknown as RunFileRow | undefined;
		return row ? this.toRunFileRecord(row) : null;
	}

	private toRunFileRecord(row: RunFileRow): RunFileRecord {
		return {
			id: row.id,
			runId: row.run_id,
			path: row.path,
			fileName: row.file_name,
			kind: row.kind,
			presentInExperiment: row.present_in_experiment === 1,
			skippedReason: row.skipped_reason,
			discoveredFromPath: row.discovered_from_path,
			sha256: row.sha256,
			sizeBytes: row.size_bytes,
			modifiedAt: row.modified_at,
			lastSeenAt: row.last_seen_at,
		};
	}

	private fileNameFromPath(path: string): string {
		const segments = path.replaceAll('\\', '/').split('/');
		return segments.at(-1) || path;
	}

	private withTransaction<T>(action: () => T): T {
		// Keep multi-step imports atomic: either every write succeeds or none are kept.
		this.sqlite.exec('BEGIN IMMEDIATE;');
		try {
			const result = action();
			this.sqlite.exec('COMMIT;');
			return result;
		} catch (error) {
			this.sqlite.exec('ROLLBACK;');
			throw error;
		}
	}

	private notifyChange(change: RunDatabaseChange): void {
		for (const listener of this.changeListeners) listener(change);
	}
}
