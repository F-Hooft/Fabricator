import { App, Modal, Notice, Setting } from 'obsidian';
import { readdir } from 'fs/promises';
import { basename, resolve } from 'path';
import type WP3Plugin from '../main';
import { MetadataSchema } from '../metadata-schemas';
import { BaseHeuristicParser, ParsedRunResult } from '../parser/base';
import { GromacsParser } from '../parser/gromacs';
import { OpenMmParser } from '../parser/openmm';
import { pickPathBrowser } from '../utils';
import { unitNormalizer } from '../parser/units';
import { LlmImportClient } from '../llm/llm-import';
import { ImportPreviewModal, type RunGroup } from './import-preview-modal';

type ImportMode = 'single-run' | 'multiple-runs';
type ImportProgressStage = 'preparing' | 'inferring';

/** Collects one or more experiment directories and imports them with one selected parser/schema pair. */
export class ImportRunsModal extends Modal {
	private readonly parsers: BaseHeuristicParser[] = [new OpenMmParser(), new GromacsParser()];
	private schemas = new Map<string, MetadataSchema & { id: string }>();
	private selectedPath: string;
	private selectedSchemaName = '';
	private selectedParserName = this.parsers[0]?.name ?? '';
	private importMode: ImportMode;
	private augmentWithLlm: boolean;
	private isImporting = false;
	private importProgressStage: ImportProgressStage = 'preparing';
	private progressRunIndex = 0;
	private progressCompleted = 0;
	private progressTotal = 0;

	constructor(app: App, private readonly plugin: WP3Plugin) {
		super(app);
		this.selectedPath = plugin.settings.lastImportPath;
		this.importMode = plugin.settings.lastImportMode;
		this.selectedSchemaName = plugin.settings.lastImportSchemaName;
		this.selectedParserName = plugin.settings.lastImportParserName || this.selectedParserName;
		this.augmentWithLlm = plugin.settings.lastImportAugmentWithLlm;
	}

	onOpen(): void {
		this.modalEl.addClass('wp3-import-modal');
		this.contentEl.style.fontSize = `${this.getModalFontSize()}px`;
		void this.loadSchemas();
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadSchemas(): Promise<void> {
		try {
			await this.plugin.refreshMetadataSchemas();
			this.schemas = await this.plugin.loadMetadataSchemas();
			if (!this.schemas.has(this.selectedSchemaName)) {
				this.selectedSchemaName = this.schemas.keys().next().value ?? '';
			}
			this.render();
		} catch (error) {
			new Notice(`Could not load metadata schemas: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Import experiment runs' });

		new Setting(contentEl)
			.setName('Source folder')
			.addText((text) => text
				.setPlaceholder('/path/to/run-or-run-folder')
				.setValue(this.selectedPath)
				.onChange((value) => { this.selectedPath = value.trim(); }))
			.addButton((button) => button
				.setButtonText('Browse')
				.onClick(async () => {
					const path = await pickPathBrowser('openDirectory', this.selectedPath);
					if (path) {
						this.selectedPath = this.plugin.normalizePathWP3(path);
						this.render();
					}
				}));

		new Setting(contentEl)
			.setName('Import mode')
			.addDropdown((dropdown) => dropdown
				.addOption('single-run', 'This folder is one run')
				.addOption('multiple-runs', 'Each child folder is one run')
				.setValue(this.importMode)
				.onChange((value) => { this.importMode = value as ImportMode; }));

		new Setting(contentEl)
			.setName('Metadata schema')
			.addDropdown((dropdown) => {
				for (const schemaName of this.schemas.keys()) dropdown.addOption(schemaName, schemaName);
				dropdown.setValue(this.selectedSchemaName);
				dropdown.onChange((value) => { this.selectedSchemaName = value; });
			});

		new Setting(contentEl)
			.setName('Parser')
			.addDropdown((dropdown) => {
				for (const parser of this.parsers) dropdown.addOption(parser.name, parser.name);
				dropdown.setValue(this.selectedParserName);
				dropdown.onChange((value) => { this.selectedParserName = value; });
			});

		new Setting(contentEl)
			.setName('Augment with LLM')
			.setDesc('Send run source text and heuristic results to the configured OpenAI-compatible server for schema metadata suggestions.')
			.addToggle((toggle) => toggle
				.setValue(this.augmentWithLlm)
				.onChange((value) => { this.augmentWithLlm = value; }));

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText(this.getImportButtonText())
				.setCta()
				.onClick(() => { void this.importRuns(); })
				.then((button) => {
					if (this.isImporting) {
						button.setDisabled(true);
						button.buttonEl.addClass('wp3-import-progress');
					}
				}));
		if (this.isImporting && this.progressTotal > 0) {
			const progress = contentEl.createDiv({ cls: 'wp3-import-progress-status' });
			const status = this.importProgressStage === 'inferring'
				? `Inferring with LLM for run ${this.progressRunIndex} of ${this.progressTotal}…`
				: `Preparing run ${this.progressRunIndex} of ${this.progressTotal}…`;
			progress.createSpan({ text: status });
			const meter = progress.createEl('progress');
			meter.max = this.progressTotal;
			meter.value = this.progressCompleted;
			meter.setAttribute('aria-label', 'Import progress');
			progress.createSpan({
				text: `${this.progressCompleted} of ${this.progressTotal} runs complete`,
				cls: 'wp3-import-progress-count',
			});
		}
	}

	private async importRuns(): Promise<void> {
		if (this.isImporting) return;
		this.isImporting = true;
		this.render();
		const schema = this.schemas.get(this.selectedSchemaName);
		const parser = this.parsers.find((candidate) => candidate.name === this.selectedParserName);
		if (!this.plugin.database || !schema || !parser || !this.selectedPath) {
			this.isImporting = false;
			this.render();
			new Notice('Select a source folder, metadata schema, and parser before importing.');
			return;
		}
		try {
			const sourcePath = this.selectedPath;
			const paths = this.importMode === 'single-run' ? [sourcePath] : await this.childDirectories(sourcePath);
			if (paths.length === 0) throw new Error('The selected folder contains no child directories to import.');
			this.progressRunIndex = 0;
			this.progressCompleted = 0;
			this.progressTotal = paths.length;

			const llmClient = this.augmentWithLlm
				? new LlmImportClient(this.plugin.settings, (secretName) => {
					const secretStorage = this.app.secretStorage;
					return secretStorage.getSecret(secretName);
				})
				: null;
			const parsedRuns: ParsedRunResult[] = [];
			for (const [index, path] of paths.entries()) {
				this.importProgressStage = 'preparing';
				this.progressRunIndex = index + 1;
				this.render();
				const parsed = await parser.parse(path, schema.fields, {
					includeLargeMolecularStructureFilesForLlm: this.plugin.settings.LLMIncludeLargeMolecularStructureFiles,
				});
				let result = parsed;
				if (llmClient) {
					this.importProgressStage = 'inferring';
					this.render();
					result = { ...parsed, llmAugment: unitNormalizer.normalizeMetadata(schema.fields, await llmClient.augment(parsed, schema)) };
				}
				parsedRuns.push(result);
				this.progressCompleted = index + 1;
				this.render();
			}

			// Save settings before showing preview
			this.plugin.settings.lastImportPath = this.selectedPath;
			this.plugin.settings.lastImportMode = this.importMode;
			this.plugin.settings.lastImportSchemaName = this.selectedSchemaName;
			this.plugin.settings.lastImportParserName = this.selectedParserName;
			this.plugin.settings.lastImportAugmentWithLlm = this.augmentWithLlm;
			await this.plugin.saveSettings();

			// Determine default folder name for workflow
			const defaultFolderName = this.getDefaultWorkflowName(sourcePath);

			// Show preview modal
			const previewModal = new ImportPreviewModal(
				this.app,
				this.plugin,
				{ ...schema, id: schema.id ?? '' },
				parser.name,
				defaultFolderName,
				parsedRuns,
				this.handleImportConfirmed.bind(this),
			);
			previewModal.open();
			this.close();
		} catch (error) {
			this.isImporting = false;
			this.resetImportProgress();
			this.render();
			new Notice(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private getImportButtonText(): string {
		if (!this.isImporting) return 'Import runs';
		return this.importProgressStage === 'inferring' ? 'Inferring...' : 'Preparing import...';
	}

	private getModalFontSize(): number {
		const value = this.plugin.settings.importModalFontSize;
		return Number.isInteger(value) && value >= 10 && value <= 24 ? value : 14;
	}

	private resetImportProgress(): void {
		this.progressRunIndex = 0;
		this.progressCompleted = 0;
		this.progressTotal = 0;
		this.importProgressStage = 'preparing';
	}

	private async handleImportConfirmed(runGroups: Map<string, RunGroup>): Promise<void> {
		const schema = this.schemas.get(this.selectedSchemaName);
		if (!this.plugin.database || !schema) {
			throw new Error('Database or schema not available.');
		}

		for (const group of runGroups.values()) {
			for (const run of group.runs) {
				// Create a ParsedRunResult with the final values
				const finalResult: ParsedRunResult = {
					sourcePath: run.sourcePath,
					metadata: run.final,
					files: run.files,
					skippedFiles: run.skippedFiles,
				};
				this.plugin.database.importParsedRun({ schemaId: schema.id, result: finalResult });
			}
		}
	}

	private async childDirectories(path: string): Promise<string[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(path, entry.name));
	}

	private getDefaultWorkflowName(sourcePath: string): string {
		// For multi-run imports, use the parent folder name
		// For single-run imports, use the folder name itself
		if (this.importMode === 'multiple-runs') {
			const parent = resolve(sourcePath, '..');
			return basename(parent);
		}
		return basename(sourcePath);
	}
}