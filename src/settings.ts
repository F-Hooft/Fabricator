import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import { pickPathBrowser } from './utils';
import WP3Plugin from './main';
import { validateBaseUrl } from './llm/url';

export interface WP3Settings {
	dbPath: string;
	runsFolder: string;
	baseFile: string;
	lastImportPath: string;
	lastImportMode: 'single-run' | 'multiple-runs';
	lastImportSchemaName: string;
	lastImportParserName: string;
	lastImportAugmentWithLlm: boolean;
	LLMServerUrl: string;
	LLMApiKeySecretName: string;
	LLMTimeoutMs: number;
	LLMIncludeLargeMolecularStructureFiles: boolean;
	LLMUseSchema: boolean;
	LLMDebugEnabled: boolean;
	LLMDebugFile: string;
	LLMShowCompareInPreview: boolean;
	LLMEnableThinking: boolean;
	importModalFontSize: number;
}

export const DEFAULT_SETTINGS: WP3Settings = {
	dbPath: "./data.db",
	runsFolder: "Runs",
	baseFile: "Runs.base",
	lastImportPath: "",
	lastImportMode: 'single-run',
	lastImportSchemaName: '',
	lastImportParserName: '',
	lastImportAugmentWithLlm: false,
	LLMServerUrl: "http://127.0.0.1:8080",
	LLMApiKeySecretName: '',
	LLMTimeoutMs: 30000,
	LLMIncludeLargeMolecularStructureFiles: false,
	LLMUseSchema: false,
	LLMDebugEnabled: false,
	LLMDebugFile: "./debug.ndjson",
	LLMShowCompareInPreview: true,
	LLMEnableThinking: false,
	importModalFontSize: 14,
};

export class WP3SettingTab extends PluginSettingTab {
	plugin: WP3Plugin;

	constructor(app: App, plugin: WP3Plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const contentEl = this.containerEl;
		contentEl.empty();

		new Setting(contentEl).setName("Local").setHeading();

		new Setting(contentEl)
			.setName('Import modal font size')
			.setDesc('Font size in pixels for the import and preview modals.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '10';
				text.inputEl.max = '24';
				text.inputEl.step = '1';
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.importModalFontSize))
					.setValue(String(this.plugin.settings.importModalFontSize))
					.onChange(async (value) => {
						const fontSize = Number.parseInt(value, 10);
						if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) return;
						this.plugin.settings.importModalFontSize = fontSize;
						await this.plugin.saveSettings();
					});
				return text;
			});


		new Setting(contentEl)
			.setName('Database path')
			.setDesc("Path to the database file.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.dbPath)
					.setValue(this.plugin.formatPathWP3(this.plugin.settings.dbPath))
					.onChange(async (value) => {
						await this.plugin.updateDatabasePath(this.plugin.normalizePathWP3(value));
					}),
			)      
			.addButton((button) =>
				button.setButtonText("Browse").onClick(async () => {
					const defaultPath = this.plugin.settings.dbPath;
					const selected = await pickPathBrowser("openFile", defaultPath);
					if (!selected) {
						return;
					}

					await this.plugin.updateDatabasePath(this.plugin.normalizePathWP3(selected));
					this.display();
					}));

		new Setting(contentEl)
			.setName("Run notes folder")
			.setDesc("Vault-relative folder for generated run notes.")
			.addText((text) =>
				text
				.setPlaceholder(DEFAULT_SETTINGS.runsFolder)
				.setValue(this.plugin.settings.runsFolder)
				.onChange(async (value) => {
					this.plugin.settings.runsFolder = value.trim() || DEFAULT_SETTINGS.runsFolder;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(contentEl)
 			.setName("Base file")
 			.setDesc("Vault-relative path of the generated .base file used for table view.")
 			.addText((text) =>
 				text
 					.setPlaceholder(DEFAULT_SETTINGS.baseFile)
 					.setValue(this.plugin.settings.baseFile)
 					.onChange(async (value) => {
 						this.plugin.settings.baseFile = value.trim() || DEFAULT_SETTINGS.baseFile;
 						await this.plugin.saveSettings();
 					}),
 			);

		new Setting(contentEl).setName("Local AI assist").setHeading();

			new Setting(contentEl)
				.setName("OpenAI-compatible base URL of LLM server")
				.setDesc("Run source text and metadata are sent to this server. HTTP is supported for loopback addresses; use HTTPS for other hosts.")
				.addText((text) => {
					text
						.setPlaceholder(DEFAULT_SETTINGS.LLMServerUrl)
						.setValue(this.plugin.settings.LLMServerUrl)
						.onChange(async (value) => {
							try {
								const url = validateBaseUrl(value.trim() || DEFAULT_SETTINGS.LLMServerUrl);
								text.inputEl.setCustomValidity('');
								this.plugin.settings.LLMServerUrl = url.toString().replace(/\/$/, '');
								await this.plugin.saveSettings();
							} catch (error) {
								text.inputEl.setCustomValidity(error instanceof Error ? error.message : String(error));
							}
						});
					text.inputEl.addEventListener('blur', () => {
						if (text.inputEl.validationMessage) text.inputEl.reportValidity();
					});
					try {
						validateBaseUrl(this.plugin.settings.LLMServerUrl);
					} catch (error) {
						text.inputEl.setCustomValidity(error instanceof Error ? error.message : String(error));
					}
					return text;
				});

			new Setting(contentEl)
				.setName('LLM API key')
				.setDesc("Optional bearer token selected from Obsidian's secret storage.")
				.addComponent((container) => new SecretComponent(this.app, container)
					.setValue(this.plugin.settings.LLMApiKeySecretName)
					.onChange(async (value) => {
						this.plugin.settings.LLMApiKeySecretName = value;
						await this.plugin.saveSettings();
					}));

			new Setting(contentEl)
				.setName("Request timeout (ms)")
				.setDesc("Timeout for each run-level AI enrichment request.")
				.addText((text) =>
					text
						.setPlaceholder(String(DEFAULT_SETTINGS.LLMTimeoutMs))
						.setValue(String(this.plugin.settings.LLMTimeoutMs))
						.onChange(async (value) => {
							const timeoutMs = Number.parseInt(value, 10);
							this.plugin.settings.LLMTimeoutMs =
								Number.isFinite(timeoutMs) && timeoutMs > 0
									? timeoutMs
									: DEFAULT_SETTINGS.LLMTimeoutMs;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(contentEl)
				.setName("Enable thinking in API requests")
				.setDesc(
					"Send requests with thinking enabled for models that support extended reasoning (requires compatible model and server).",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.LLMEnableThinking)
						.onChange(async (value) => {
							this.plugin.settings.LLMEnableThinking = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(contentEl)
				.setName("Include large molecular structure files in LLM context")
				.setDesc(
					"Off by default. When enabled, include text structure files over 50 kilobytes (up to 5 megabytes); binary files are always excluded.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.LLMIncludeLargeMolecularStructureFiles)
						.onChange(async (value) => {
							this.plugin.settings.LLMIncludeLargeMolecularStructureFiles = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(contentEl)
				.setName("Use schema-constrained AI output")
				.setDesc(
					"Constrain output with a llama.cpp grammar generated from the selected metadata schema (requires compatible server).",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.LLMUseSchema)
						.onChange(async (value) => {
							this.plugin.settings.LLMUseSchema = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(contentEl)
				.setName("Show manual vs LLM columns in import preview")
				.setDesc(
					"Display side-by-side comparison columns in the import preview modal.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.LLMShowCompareInPreview)
						.onChange(async (value) => {
							this.plugin.settings.LLMShowCompareInPreview = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(contentEl)
				.setName("Write AI debug logs")
				.setDesc(
					"Write full prompts and responses, which may contain source code and experiment metadata, to a local file. The file may be synced or backed up.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.LLMDebugEnabled)
						.onChange(async (value) => {
							this.plugin.settings.LLMDebugEnabled = value;
							await this.plugin.saveSettings();
							this.display();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.LLMDebugFile)
						.setValue(this.plugin.formatPathWP3(this.plugin.settings.LLMDebugFile))
						.onChange(async (value) => {
							this.plugin.settings.LLMDebugFile = this.plugin.normalizePathWP3(value);
							await this.plugin.saveSettings();
						}),
				);

	}
}
