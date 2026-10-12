import { App, TFile, TFolder } from 'obsidian';
import { MetadataValue, RunDatabase, RunFileRecord, RunRecord } from '../db';

const RUN_ID_PROPERTY = 'wp3-run-id';
const SCHEMA_PROPERTY = 'wp3-schema';
const UPDATED_AT_PROPERTY = 'wp3-updated-at';
const FILES_START = '> [!info] Managed section\n> <!-- wp3:files:start -->';
const FILES_END = '> <!-- wp3:files:end -->';

/** Synchronizes database runs with editable vault notes while preserving user content. */
export class RunNotes {
	private readonly writingNotePaths = new Set<string>();
	private readonly pendingFolderCreations = new Map<string, Promise<void>>();

	constructor(
		private readonly app: App,
		private readonly database: RunDatabase,
		private readonly getRunsFolder: () => string,
	) {}

	async syncAll(): Promise<void> {
		for (const run of this.database.listRuns()) {
			await this.syncRun(run.id);
		}
	}

	async syncRun(runId: string): Promise<void> {
		const run = this.database.getRun(runId);
		if (!run) return;
		const path = this.notePath(run);
		await this.ensureFolder(this.folderPath());
		const existing = await this.findRunNote(run.id) ?? this.app.vault.getAbstractFileByPath(path);
		const file = existing
			? await this.renameIfNeeded(existing instanceof TFile ? existing : null, path)
			: await this.app.vault.create(path, `# ${this.noteTitle(run)}\n\n${this.filesBlock(this.database.listRunFiles(run.id))}\n`);
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter?.[UPDATED_AT_PROPERTY] === run.updatedAt) return;
		this.writingNotePaths.add(path);
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				const managedFrontmatter = frontmatter as Record<string, unknown>;
				managedFrontmatter[RUN_ID_PROPERTY] = run.id;
				managedFrontmatter[SCHEMA_PROPERTY] = run.schemaId;
				managedFrontmatter[UPDATED_AT_PROPERTY] = run.updatedAt;
				for (const field of this.managedFields(run)) {
					if (field.key in run.metadata) managedFrontmatter[field.key] = run.metadata[field.key];
					else delete managedFrontmatter[field.key];
				}
			});
			await this.app.vault.process(file, (content) => this.moveRunNameToFirstFrontmatter(
				this.replaceFilesBlock(content, this.filesBlock(this.database.listRunFiles(run.id))),
				run.metadata.run_name,
			));
		} finally {
			this.writingNotePaths.delete(path);
		}
	}

	async handleModifiedNote(file: TFile): Promise<void> {
		if (this.writingNotePaths.has(file.path)) return;
		if (!this.isManagedNotePath(file.path)) return;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) return;
		const runId: unknown = frontmatter[RUN_ID_PROPERTY];
		if (typeof runId !== 'string') return;
		const run = this.database.getRun(runId);
		const schemaId: unknown = frontmatter[SCHEMA_PROPERTY];
		if (!run || schemaId !== run.schemaId) return;
		const noteVersion: unknown = frontmatter[UPDATED_AT_PROPERTY];
		if (noteVersion === run.updatedAt) return;
		if (Date.parse(run.updatedAt) >= file.stat.mtime) {
			await this.syncRun(run.id);
			return;
		}
		for (const field of this.managedFields(run)) {
			const value: unknown = frontmatter[field.key];
			if (!this.isMetadataValue(value) || run.metadata[field.key] === value) continue;
			this.database.setMetadata(run.id, field.key, value);
		}
	}

	private managedFields(run: RunRecord) {
		return this.database.listMetadataFields(run.schemaId).filter((field) => field.includeInFrontmatter);
	}

	private folderPath(): string {
		const folder = this.getRunsFolder().trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
		if (!folder || folder.startsWith('/') || folder.includes('../')) {
			throw new Error('Run notes folder must be a vault-relative path.');
		}
		return folder;
	}

	private notePath(run: RunRecord): string {
		return `${this.folderPath()}/${this.fileName(run)}.md`;
	}

	private isManagedNotePath(path: string): boolean {
		return path.startsWith(`${this.folderPath()}/`) && path.endsWith('.md');
	}

	private noteTitle(run: RunRecord): string {
		return typeof run.metadata.run_name === 'string' && run.metadata.run_name.trim()
			? run.metadata.run_name
			: run.id;
	}

	private fileName(run: RunRecord): string {
		const name = this.noteTitle(run).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
		return `${name || 'run'} [${run.id.slice(0, 8)}]`;
	}

	private filesBlock(files: RunFileRecord[]): string {
		const lines = [
			FILES_START,
			'> This section is managed by WP3. Edits in this block will be overwritten.',
			'>',
			'> ## File discovery',
			'>',
		];
		if (files.length === 0) {
			lines.push('> No files recorded.');
		} else {
			const existing = files.filter((f) => f.presentInExperiment);
			const missing = files.filter((f) => !f.presentInExperiment);

			if (existing.length > 0) {
				lines.push('> ### Existing in folder', '>', '> | File | Source | Skipped |', '> | --- | --- | --- |');
				for (const file of existing) {
					const fileLink = `[${escapeCell(file.fileName)}](file://${escapeCell(file.path)})`;
					lines.push(`> | ${fileLink} | ${file.kind} | ${escapeCell(file.skippedReason ?? '')} |`);
				}
			}

			if (missing.length > 0) {
				if (existing.length > 0) lines.push('>');
				lines.push('> ### Missing', '>', '> | File | Source | Skipped |', '> | --- | --- | --- |');
				for (const file of missing) {
					lines.push(`> | ${escapeCell(file.fileName)} | ${file.kind} | ${escapeCell(file.skippedReason ?? '')} |`);
				}
			}
		}
		lines.push(FILES_END);
		return lines.join('\n');
	}

	private replaceFilesBlock(content: string, filesBlock: string): string {
		const start = content.indexOf(FILES_START);
		const end = content.indexOf(FILES_END);
		if (start >= 0 && end >= start) {
			return `${content.slice(0, start)}${filesBlock}${content.slice(end + FILES_END.length)}`;
		}
		return `${content.replace(/\s*$/, '')}\n\n${filesBlock}\n`;
	}

	private moveRunNameToFirstFrontmatter(content: string, value: MetadataValue | undefined): string {
		if (value === undefined || !content.startsWith('---\n')) return content;
		const frontmatterEnd = content.indexOf('\n---\n', 4);
		if (frontmatterEnd < 0) return content;
		const frontmatter = content.slice(4, frontmatterEnd).replace(/^run_name:.*\n/gm, '');
		return `---\nrun_name: ${JSON.stringify(value)}\n${frontmatter}\n---\n${content.slice(frontmatterEnd + 5)}`;
	}

	private async ensureFolder(path: string): Promise<void> {
		const pending = this.pendingFolderCreations.get(path);
		if (pending) {
			await pending;
			return;
		}

		const creation = this.createFolder(path);
		this.pendingFolderCreations.set(path, creation);
		try {
			await creation;
		} finally {
			if (this.pendingFolderCreations.get(path) === creation) this.pendingFolderCreations.delete(path);
		}
	}

	private async createFolder(path: string): Promise<void> {
		const segments = path.split('/');
		let currentPath = '';
		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			if (!(this.app.vault.getAbstractFileByPath(currentPath) instanceof TFolder)) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private async findRunNote(runId: string): Promise<TFile | null> {
		return this.app.vault.getMarkdownFiles().find((file) => {
			if (!this.isManagedNotePath(file.path)) return false;
			return this.app.metadataCache.getFileCache(file)?.frontmatter?.[RUN_ID_PROPERTY] === runId;
		}) ?? null;
	}

	private async renameIfNeeded(file: TFile | null, path: string): Promise<TFile> {
		if (!file) return await this.app.vault.create(path, '');
		if (file.path === path) return file;
		const destination = this.app.vault.getAbstractFileByPath(path);
		if (destination && destination !== file) return file;
		await this.app.vault.rename(file, path);
		const renamed = this.app.vault.getAbstractFileByPath(path);
		if (!(renamed instanceof TFile)) throw new Error(`Could not rename run note to ${path}.`);
		return renamed;
	}

	private isMetadataValue(value: unknown): value is MetadataValue {
		return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
	}
}

function escapeCell(value: string): string {
	return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}