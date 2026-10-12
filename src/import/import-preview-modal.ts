import { App, Modal, Notice, Setting } from 'obsidian';
import type WP3Plugin from '../main';
import { MetadataSchema } from '../metadata-schemas';
import { ParsedRunResult } from '../parser/base';
import { HeuristicMetadataValue } from '../parser/base';

export interface ParsedRunWithMetadata {
	sourcePath: string;
	heuristic: Partial<Record<string, HeuristicMetadataValue>>;
	llmAugment: Partial<Record<string, HeuristicMetadataValue>>;
	final: Partial<Record<string, HeuristicMetadataValue>>;
	files: ParsedRunResult['files'];
	skippedFiles: ParsedRunResult['skippedFiles'];
}

export interface RunGroup {
	workflowName: string;
	runs: ParsedRunWithMetadata[];
}

/**
 * Preview modal for import results, showing how metadata is prioritized (heuristic → llm-augment → final)
 * and allowing editing before committing the import.
 */
export class ImportPreviewModal extends Modal {
	private runGroups: Map<string, RunGroup> = new Map();
	private readonly runs: ParsedRunWithMetadata[] = [];
	private selectedRunKey = '';
	private workflowNameOverride: string = '';
	private applyWorkflowNameToAll: boolean = true;
	private isImporting = false;

	constructor(
		app: App,
		private readonly plugin: WP3Plugin,
		private readonly schema: MetadataSchema & { id: string },
		private readonly parserName: string,
		private readonly defaultFolderName: string,
		parsedRuns: ParsedRunResult[],
		private readonly onImport: (groups: Map<string, RunGroup>) => Promise<void>,
	) {
		super(app);
		this.initializeRunGroups(parsedRuns);
	}

	private initializeRunGroups(parsedRuns: ParsedRunResult[]): void {
		for (const parsed of parsedRuns) {
			const heuristic = parsed.metadata;
			const llmAugment = parsed.llmAugment ?? {};
			const final: Partial<Record<string, HeuristicMetadataValue>> = {};

			// Compute final values: llm-augment takes priority over heuristic
			for (const field of this.schema.fields) {
				if (field.key in llmAugment && llmAugment[field.key] !== undefined) {
					final[field.key] = llmAugment[field.key];
				} else if (field.key in heuristic && heuristic[field.key] !== undefined) {
					final[field.key] = heuristic[field.key];
				}
			}

			const runData: ParsedRunWithMetadata = {
				sourcePath: parsed.sourcePath,
				heuristic,
				llmAugment,
				final,
				files: parsed.files,
				skippedFiles: parsed.skippedFiles,
			};

			this.runs.push(runData);
		}

		this.workflowNameOverride = this.defaultFolderName;
		this.rebuildRunGroups();
	}

	private rebuildRunGroups(): void {
		this.runGroups = new Map();
		this.runs.forEach((run, index) => {
			const runKey = `run-${index}`;
			const workflowName = this.applyWorkflowNameToAll
				? this.defaultFolderName
				: String(run.final['workflow_name'] ?? run.heuristic['workflow_name'] ?? this.parserName);
			this.runGroups.set(runKey, { workflowName, runs: [run] });
		});
		this.workflowNameOverride = this.defaultFolderName;
		if (!this.runGroups.has(this.selectedRunKey)) {
			this.selectedRunKey = this.runGroups.keys().next().value ?? '';
		}
	}

	onOpen(): void {
		this.modalEl.addClass('wp3-import-preview-modal');
		const fontSize = this.plugin.settings.importModalFontSize;
		this.contentEl.style.fontSize = `${Number.isInteger(fontSize) && fontSize >= 10 && fontSize <= 24 ? fontSize : 14}px`;
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Import preview' });

		// Workflow name setting container
		const workflowContainer = contentEl.createDiv({ cls: 'wp3-workflow-container' });
		
		new Setting(workflowContainer)
			.setName('Apply workflow name to all runs')
			.setDesc('Use one workflow name for every imported run')
			.addToggle((toggle) => toggle
				.setValue(this.applyWorkflowNameToAll)
				.onChange((value) => {
					this.applyWorkflowNameToAll = value;
					this.rebuildRunGroups();
					this.render();
				}));

		if (this.applyWorkflowNameToAll) {
			new Setting(workflowContainer)
				.setName('Workflow name')
				.setDesc('Name for this group of runs (default is the folder name)')
				.addText((text) => text
					.setPlaceholder(this.defaultFolderName)
					.setValue(this.workflowNameOverride)
					.onChange((value) => {
						this.workflowNameOverride = value.trim() || this.defaultFolderName;
					}));
		}

		// Run selector: show one run at a time to keep the preview compact.
		if (this.runs.length > 1) {
			const selectorContainer = contentEl.createDiv({ cls: 'wp3-workflow-selector' });
			const selectorDiv = selectorContainer.createDiv({ cls: 'wp3-selector-buttons' });

			for (const [runKey, group] of this.runGroups) {
				const run = group.runs[0];
				const runName = String(run?.final['run_name'] ?? run?.heuristic['run_name'] ?? run?.sourcePath.split(/[\\/]/).pop() ?? runKey);
				const button = selectorDiv.createEl('button', {
					text: runName,
					cls: ['wp3-workflow-button', this.selectedRunKey === runKey ? 'active' : ''].filter(Boolean),
				});
				button.addEventListener('click', () => {
					this.selectedRunKey = runKey;
					this.render();
				});
			}
		}

		// Preview table for selected workflow
		const selectedGroup = this.runGroups.get(this.selectedRunKey);
		if (selectedGroup) {
			const previewContainer = contentEl.createDiv({ cls: 'wp3-preview-container' });
			previewContainer.createEl('h3', { text: `Workflow: ${selectedGroup.workflowName}` });

			for (const run of selectedGroup.runs) {
				this.renderRunPreview(previewContainer, run);
			}
		}

		// Import button
		const buttonContainer = contentEl.createDiv({ cls: 'wp3-import-buttons' });
		const importButton = buttonContainer.createEl('button', {
			text: this.isImporting ? 'Importing...' : 'Import runs',
			cls: 'mod-cta',
		});
		if (this.isImporting) {
			importButton.disabled = true;
			importButton.addClass('wp3-import-progress');
		} else {
			importButton.addEventListener('click', () => void this.performImport());
		}

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => this.close());
	}

	private renderRunPreview(container: HTMLElement, run: ParsedRunWithMetadata): void {
		const runDiv = container.createDiv({ cls: 'wp3-run-preview' });
		runDiv.createEl('h4', { text: `Run: ${run.sourcePath}` });

		const table = runDiv.createEl('table', { cls: 'wp3-preview-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: 'Key' });
		headerRow.createEl('th', { text: 'Parser result' });
		if (this.plugin.settings.LLMShowCompareInPreview) {
			headerRow.createEl('th', { text: 'AI suggestion' });
		}
		headerRow.createEl('th', { text: 'Import value' });

		const tbody = table.createEl('tbody');

		for (const field of this.schema.fields) {
			const row = tbody.createEl('tr');
			const heuristicValue = run.heuristic[field.key];
			const llmValue = run.llmAugment[field.key];
			const llmDiffers = llmValue !== undefined && !Object.is(llmValue, heuristicValue);
			if (llmDiffers) row.addClass('wp3-llm-difference-row');

			// Key column
			const keyCell = row.createEl('td', { cls: 'wp3-key-cell' });
			keyCell.createEl('strong', { text: field.key });
			if (field.required) {
				keyCell.createSpan({ text: ' *', cls: 'wp3-required' });
			}

			// Heuristic column
			const heuristicCell = row.createEl('td', { cls: 'wp3-heuristic-cell' });
			if (heuristicValue !== undefined) {
				heuristicCell.setText(String(heuristicValue));
			}

			if (this.plugin.settings.LLMShowCompareInPreview) {
				const llmCell = row.createEl('td', {
					cls: llmDiffers ? 'wp3-llm-cell wp3-llm-difference' : 'wp3-llm-cell',
					attr: llmDiffers ? { title: 'This AI suggestion differs from the parser result.' } : {},
				});
				if (llmValue !== undefined) {
					llmCell.setText(String(llmValue));
				}
			}

			// Final column (editable)
			const finalCell = row.createEl('td', { cls: 'wp3-final-cell' });
			if (llmDiffers && !this.plugin.settings.LLMShowCompareInPreview) {
				finalCell.addClass('wp3-llm-difference');
				finalCell.setAttribute('title', 'The imported AI suggestion differs from the parser result.');
			}
			const finalValue = run.final[field.key];
			const isManagedField = field.key === 'wp3-run-id' || field.key === 'wp3-schema' || field.key === 'wp3-updated-at';

			if (isManagedField) {
				// Managed fields are not editable
				if (finalValue !== undefined) {
					finalCell.setText(String(finalValue));
				}
				finalCell.addClass('wp3-managed');
			} else {
				// Editable fields
				const input = finalCell.createEl('input', {
					type: field.type === 'integer' ? 'number' : 'text',
					value: finalValue !== undefined ? String(finalValue) : '',
					placeholder: '',
					cls: 'wp3-final-input',
				});
				input.addEventListener('change', (e) => {
					const target = e.target as HTMLInputElement;
					const newValue = this.parseFieldValue(target.value, field.type);
					if (newValue !== null) {
						run.final[field.key] = newValue;
					}
				});
			}
		}
	}

	private parseFieldValue(value: string, fieldType: string): HeuristicMetadataValue | null {
		if (!value.trim()) return null;
		switch (fieldType) {
			case 'integer':
				return parseInt(value, 10);
			case 'number_with_unit':
				return value;
			case 'boolean':
				return value.toLowerCase() === 'true' || value === '1';
			case 'string':
			default:
				return value;
		}
	}

	private async performImport(): Promise<void> {
		if (this.isImporting) return;
		this.isImporting = true;
		this.render();
		try {
			// If workflow name override is enabled, apply it to all runs in all groups
			if (this.applyWorkflowNameToAll) {
				for (const group of this.runGroups.values()) {
					for (const run of group.runs) {
						run.final['workflow_name'] = this.workflowNameOverride;
					}
				}
			}

			// Call the import handler with all groups
			await this.onImport(this.runGroups);
			new Notice(`Imported ${this.getTotalRunCount()} run${this.getTotalRunCount() === 1 ? '' : 's'}.`);
			this.close();
		} catch (error) {
			new Notice(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
			this.isImporting = false;
			this.render();
		}
	}

	private getTotalRunCount(): number {
		let count = 0;
		for (const group of this.runGroups.values()) {
			count += group.runs.length;
		}
		return count;
	}
}
