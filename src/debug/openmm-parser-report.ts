import { TFile, Vault } from 'obsidian';
import { ParsedRunResult } from '../parser/base';

export const OPENMM_PARSER_REPORT_PATH = 'WP3 OpenMM parser debug.md';

/** Writes a parsed result and its scan diagnostics after it has been imported. */
export async function writeOpenMmParserReport(vault: Vault, result: ParsedRunResult, runId: string): Promise<string> {
	const lines = ['# WP3 OpenMM parser debug report', '', '## Extracted metadata', ''];
	lines.splice(1, 0, `Run ID: ${runId}`, `Source path: ${result.sourcePath}`, '');
	for (const [key, value] of Object.entries(result.metadata)) lines.push(`- ${key}: ${JSON.stringify(value)}`);
	if (Object.keys(result.metadata).length === 0) lines.push('_No selected schema fields were found._');
	lines.push('', '## Files', '', '| Kind | Present in experiment | Path | Referenced by |', '| --- | --- | --- | --- |');
	for (const file of result.files) {
		lines.push(`| ${file.kind} | ${file.isPresentInExperiment ? 'yes' : 'no'} | ${file.path} | ${file.discoveredFromPath ?? ''} |`);
	}
	if (result.files.length === 0) lines.push('| _No files found or referenced_ | | | |');
	lines.push('', '## Skipped files', '');
	for (const skipped of result.skippedFiles) lines.push(`- ${skipped.path}: ${skipped.reason}`);
	if (result.skippedFiles.length === 0) lines.push('_No files skipped._');
	const report = `${lines.join('\n')}\n`;
	const existingFile = vault.getAbstractFileByPath(OPENMM_PARSER_REPORT_PATH);
	if (existingFile instanceof TFile) await vault.modify(existingFile, report);
	else await vault.create(OPENMM_PARSER_REPORT_PATH, report);
	return OPENMM_PARSER_REPORT_PATH;
}