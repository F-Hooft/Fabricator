import { TFile, Vault } from 'obsidian';
import { RunDatabase } from '../db';

export const DATABASE_REPORT_PATH = 'WP3 database debug.md';

/** Writes a human-readable snapshot of the database's schema catalog, runs, metadata, and files. */
export async function writeDatabaseReport(vault: Vault, database: RunDatabase): Promise<string> {
	const report = createDatabaseReport(database);
	// A stable path makes repeated command runs refresh the same inspection note.
	const existingFile = vault.getAbstractFileByPath(DATABASE_REPORT_PATH);
	if (existingFile instanceof TFile) {
		await vault.modify(existingFile, report);
	} else {
		await vault.create(DATABASE_REPORT_PATH, report);
	}
	return DATABASE_REPORT_PATH;
}

function createDatabaseReport(database: RunDatabase): string {
	// Build markdown from the public database API so this diagnostic stays independent of SQLite internals.
	const lines = [
		'# WP3 database debug report',
		'',
		`Generated: ${new Date().toISOString()}`,
		'',
		'## Schema catalog',
		'',
	];

	const schemas = database.listMetadataSchemas();
	if (schemas.length === 0) {
		lines.push('_No metadata schemas stored._', '');
	} else {
		for (const schema of schemas) {
			lines.push(`### ${schema.name}`, '', `- ID: ${schema.id}`, `- Active: ${schema.active ? 'yes' : 'no'}`, `- Used: ${schema.used ? 'yes' : 'no'}`, '', '| Key | Type | Required | Frontmatter | Label |', '| --- | --- | --- | --- | --- |');
			const fields = database.listMetadataFields(schema.id);
			for (const field of fields) {
				lines.push(`| ${markdownCell(field.key)} | ${field.type} | ${field.required ? 'yes' : 'no'} | ${field.includeInFrontmatter ? 'yes' : 'no'} | ${markdownCell(field.label)} |`);
			}
			if (fields.length === 0) {
				lines.push('| _No fields_ | | | | |');
			}
			lines.push('');
		}
	}

	const runs = database.listRuns();
	lines.push('## Runs', '');
	if (runs.length === 0) {
		lines.push('_No runs stored._', '');
	} else {
		for (const run of runs) {
			lines.push(`### ${run.id}`, '', `- Schema: ${run.schemaName}`, `- Source path: ${run.sourcePath ?? '_None_'}`, `- Created: ${run.createdAt}`, `- Updated: ${run.updatedAt}`, '');
			lines.push('#### Metadata', '', '| Key | Value |', '| --- | --- |');
			const metadataEntries = Object.entries(run.metadata);
			for (const [key, value] of metadataEntries) {
				lines.push(`| ${markdownCell(key)} | ${markdownCell(JSON.stringify(value))} |`);
			}
			if (metadataEntries.length === 0) {
				lines.push('| _No metadata_ | |');
			}

			lines.push('', '#### Files', '', '| Kind | Present in experiment | File | Path | Skipped reason | SHA-256 | Bytes | Modified | Referenced by |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
			const files = database.listRunFiles(run.id);
			for (const file of files) {
				lines.push(`| ${file.kind} | ${file.presentInExperiment ? 'yes' : 'no'} | ${markdownCell(file.fileName)} | ${markdownCell(file.path)} | ${markdownCell(file.skippedReason ?? '')} | ${file.sha256 ?? ''} | ${file.sizeBytes ?? ''} | ${file.modifiedAt ?? ''} | ${markdownCell(file.discoveredFromPath ?? '')} |`);
			}
			if (files.length === 0) {
				lines.push('| _No files_ | | | | | | | | |');
			}
			lines.push('');
		}
	}

	return `${lines.join('\n')}\n`;
}

function markdownCell(value: string): string {
	return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}