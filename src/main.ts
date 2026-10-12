import {
	Notice,
	Plugin,
	Platform,
} from 'obsidian';
import { posix, win32 } from 'path';
import {
	DEFAULT_SETTINGS,
	WP3Settings,
	WP3SettingTab,
} from './settings';
import { MetadataSchemaRecord, RunDatabase } from './db';
import { DATABASE_REPORT_PATH, writeDatabaseReport } from './debug/database-report';
import { OPENMM_PARSER_REPORT_PATH, writeOpenMmParserReport } from './debug/openmm-parser-report';
import { OpenMmParser } from './parser/openmm';
import { ImportRunsModal } from './import/import-runs-modal';
import { RunNotes } from './notes/run-notes';
import { writeRunsBase } from './notes/runs-base';
import {
	DEFAULT_METADATA_SCHEMA,
	ensureMetadataSchemas,
	loadAllMetadataSchemas,
} from './metadata-schemas';


export default class WP3Plugin extends Plugin {
	settings!: WP3Settings;
	database: RunDatabase | null = null;
	private runNotes: RunNotes | null = null;
	private artifactsSyncScheduled = false;
	private readonly pendingRunNoteIds = new Set<string>();
	private refreshAllRunNotes = false;
	private databaseDataVersion = 0;

	async onload() {
		await this.loadSettings();
		this.reopenDatabase();
		await this.refreshMetadataSchemas();
		this.initializeRunNotes();
		this.app.workspace.onLayoutReady(() => this.scheduleArtifactSync(undefined, true));
		this.databaseDataVersion = this.database?.getDataVersion() ?? 0;
		this.registerInterval(window.setInterval(() => this.checkForExternalDatabaseChanges(), 15_000));
		this.addRibbonIcon('folder-plus', 'Import experiment runs', () => {
			new ImportRunsModal(this.app, this).open();
		});

		this.addCommand({
			id: 'show-db-path',
			name: 'Show database path',
			callback: () => {
				new Notice(`Database path: ${this.settings.dbPath}`);
			},
		});

		this.addCommand({
			id: 'write-database-debug-report',
			name: 'Write database debug report',
			callback: async () => {
				if (!this.database) {
					new Notice('Database is not available.');
					return;
				}
				await writeDatabaseReport(this.app.vault, this.database);
				new Notice(`Database debug report written to ${DATABASE_REPORT_PATH}`);
			},
		});

		this.addCommand({
			id: 'run-openmm-parser-on-test-folder',
			name: 'Run openmm parser on test folder',
			callback: async () => {
				try {
					if (!this.database) {
						new Notice('Database is not available.');
						return;
					}
					const schema = this.database.findMetadataSchemaByName(DEFAULT_METADATA_SCHEMA.name, true)[0];
					if (!schema) throw new Error('Default metadata schema is not available.');
					const result = await new OpenMmParser().parse(this.normalizePathWP3('./test'), DEFAULT_METADATA_SCHEMA.fields);
					const run = this.database.importParsedRun({
						schemaId: schema.id,
						result,
					});
					await writeOpenMmParserReport(this.app.vault, result, run.id);
					new Notice(`Imported ${run.id} and wrote OpenMM parser report to ${OPENMM_PARSER_REPORT_PATH}`);
				} catch (error) {
					new Notice(`OpenMM parser failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		});

		this.addCommand({
			id: 'scheduleArtifactSync',
			name: 'Schedule artifact sync',
			callback: async () => {
				this.scheduleArtifactSync(undefined, true);
			},
		});

		this.addCommand({
			id: 'refresh-metadata-schemas',
			name: 'Refresh metadata schemas',
			callback: async () => {
				try {
					await this.refreshMetadataSchemas();
					new Notice('Metadata schemas refreshed.');
				} catch (error) {
					new Notice(`Could not refresh metadata schemas: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		});

		this.addSettingTab(new WP3SettingTab(this.app, this));
	}

	onunload() {
		this.runNotes = null;
		this.database?.close();
		this.database = null;
	}

	
	async loadSettings() {
		const normalizedDefaultSettings: WP3Settings = {
			...DEFAULT_SETTINGS,
			dbPath: this.normalizePathWP3(DEFAULT_SETTINGS.dbPath),
			LLMDebugFile: this.normalizePathWP3(DEFAULT_SETTINGS.LLMDebugFile),
		};

		this.settings = Object.assign(
			{},
			normalizedDefaultSettings,
			(await this.loadData()) as Partial<WP3Settings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async updateDatabasePath(databasePath: string): Promise<void> {
		const previousPath = this.settings.dbPath;
		this.settings.dbPath = databasePath;
		try {
			this.reopenDatabase();
			await this.saveSettings();
		} catch (error) {
			this.settings.dbPath = previousPath;
			throw error;
		}
	}

	async loadMetadataSchemas(): Promise<Map<string, MetadataSchemaRecord>> {
		await ensureMetadataSchemas(this.app.vault.adapter);
		return new Map((this.database?.listMetadataSchemas(true) ?? []).map((schema) => [schema.name, schema]));
	}

	async refreshMetadataSchemas(): Promise<void> {
		const { schemas, duplicateFiles } = await loadAllMetadataSchemas(this.app.vault.adapter);
		if (duplicateFiles.length > 0) new Notice(`Skipped duplicate metadata schemas: ${duplicateFiles.join(', ')}`);
		if (!this.database) return;
		for (const schema of schemas.values()) {
			const existing = this.database.findMetadataSchemaByName(schema.name);
			const active = existing.find((candidate) => candidate.active);
			if (active && metadataFieldsMatch(active.fields, schema.fields)) continue;
			for (const candidate of existing) {
				if (candidate.used) {
					const legacyName = `(Legacy+${candidate.importedAt.slice(0, 16).replace('T', '-')}) ${candidate.name}`;
					this.database.deactivateMetadataSchema(candidate.id, legacyName);
				} else {
					this.database.deleteMetadataSchema(candidate.id);
				}
			}
			this.database.synchronizeMetadataSchema(schema);
		}
		this.scheduleArtifactSync(undefined, true);
	}

	reopenDatabase(): void {
		const nextDatabase = new RunDatabase(this.settings.dbPath);
		try {
			nextDatabase.initialize();
		} catch (error) {
			nextDatabase.close();
			throw error;
		}

		this.database?.close();
		this.database = nextDatabase;
	}

	private initializeRunNotes(): void {
		if (!this.database) return;
		this.runNotes = new RunNotes(this.app, this.database, () => this.settings.runsFolder);
		this.register(this.database.onChange((change) => this.scheduleArtifactSync(change.runId)));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			void this.runNotes?.handleModifiedNote(file);
		}));
	}

	private scheduleArtifactSync(runId?: string, refreshAll = false): void {
		if (runId) this.pendingRunNoteIds.add(runId);
		this.refreshAllRunNotes ||= refreshAll;
		if (this.artifactsSyncScheduled || !this.runNotes || !this.database) return;
		this.artifactsSyncScheduled = true;
		void Promise.resolve().then(async () => {
			let operation = 'run notes';
			try {
				if (this.refreshAllRunNotes) {
					await this.runNotes?.syncAll();
				} else {
					for (const id of this.pendingRunNoteIds) await this.runNotes?.syncRun(id);
				}
				this.pendingRunNoteIds.clear();
				this.refreshAllRunNotes = false;
				if (this.database) {
					operation = `Base file ${this.settings.baseFile}`;
					await writeRunsBase(this.app.vault, this.database, this.settings.runsFolder, this.settings.baseFile);
				}
			} catch (error) {
				throw new Error(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}).catch((error: unknown) => {
			new Notice(`Could not synchronize run notes: ${error instanceof Error ? error.message : String(error)}`);
			this.pendingRunNoteIds.clear();
			this.refreshAllRunNotes = false;
		}).finally(() => {
			this.artifactsSyncScheduled = false;
			if (this.pendingRunNoteIds.size > 0 || this.refreshAllRunNotes) this.scheduleArtifactSync();
		});
	}

	private checkForExternalDatabaseChanges(): void {
		if (!this.database) return;
		const currentVersion = this.database.getDataVersion();
		if (currentVersion === this.databaseDataVersion) return;
		this.databaseDataVersion = currentVersion;
		this.scheduleArtifactSync(undefined, true);
	}

	normalizePathWP3(path: string): string {
		const trimmedPath = path.trim();
		const pathModule = Platform.isWin ? win32 : posix;
		if (!trimmedPath.startsWith('./') && !trimmedPath.startsWith('.\\')) {
			return pathModule.normalize(trimmedPath);
		}

		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		return vaultPath
			? pathModule.normalize(pathModule.join(vaultPath, trimmedPath.slice(2)))
			: pathModule.normalize(trimmedPath);
	}

	formatPathWP3(path: string): string {
		const normalizedPath = this.normalizePathWP3(path);
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
			return normalizedPath.replaceAll('\\', '/');
		}

		const normalizedVaultPath = this.normalizePathWP3(vaultPath).replace(/[\\/]+$/, '');
		if (
			normalizedPath !== normalizedVaultPath &&
			!normalizedPath.startsWith(`${normalizedVaultPath}${Platform.isWin ? '\\' : '/'}`)
		) {
			return normalizedPath.replaceAll('\\', '/');
		}

		const relativePath = normalizedPath
			.slice(normalizedVaultPath.length)
			.replace(/^[\\/]+/, '');
		return relativePath ? `./${relativePath}` : './';
	}
}

function metadataFieldsMatch(left: MetadataSchemaRecord['fields'], right: MetadataSchemaRecord['fields']): boolean {
	const normalize = (fields: MetadataSchemaRecord['fields']) => fields
		.map((field) => ({
			key: field.key,
			label: field.label,
			type: field.type,
			description: field.description,
			heuristicPatterns: field.heuristicPatterns ?? [],
			heuristicMatchMode: field.heuristicMatchMode ?? null,
			required: field.required,
			includeInFrontmatter: field.includeInFrontmatter,
		}))
		.sort((first, second) => first.key.localeCompare(second.key));

	return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}