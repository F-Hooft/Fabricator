import { BaseHeuristicParser, HeuristicMetadataValue } from './base';
import { unitNormalizer } from './units';
import { MetadataFieldDefinition } from '../metadata-schemas';

/** Extracts selected schema fields from source text in an OpenMM experiment directory. */
export class OpenMmParser extends BaseHeuristicParser {
	readonly name = 'OpenMM';

	protected extractMetadata(content: string, folderName: string, fields: readonly MetadataFieldDefinition[]): Partial<Record<string, HeuristicMetadataValue>> {
		return extractOpenMmMetadata(content, folderName, fields);
	}
}

/** Extracts selected schema fields from already-loaded OpenMM source text. */
export function extractOpenMmMetadata(content: string, folderName: string, fields: readonly MetadataFieldDefinition[]): Partial<Record<string, HeuristicMetadataValue>> {
	const activeContent = stripPythonComments(content);
	const metadata: Partial<Record<string, HeuristicMetadataValue>> = {};
	for (const field of fields) {
		const value = extractField(field, activeContent, folderName);
		if (value !== undefined) {
			metadata[field.key] = value;
		}
	}
	return metadata;
}

function extractField(field: MetadataFieldDefinition, content: string, folderName: string): HeuristicMetadataValue | undefined {
	const patternValue = extractPatternValue(field, content);
	if (patternValue !== undefined) {
		return coerceFieldValue(field, patternValue);
	}

	switch (field.key) {
		case 'run_name':
		case 'workflow_name':
			return folderName;
		case 'method':
			if (/barostat/i.test(content)) return 'npt_md';
			if (/Langevin(?:Middle)?Integrator|VerletIntegrator/i.test(content)) return 'nvt_md';
			if (/minimizeEnergy\s*\(/i.test(content)) return 'minimization';
			return /openmm|simtk\.openmm/i.test(content) ? 'classical_md' : undefined;
		default:
			return undefined;
	}
}

function extractPatternValue(field: MetadataFieldDefinition, content: string): string | undefined {
	const matches = (field.heuristicPatterns ?? []).flatMap((pattern) => [...content.matchAll(new RegExp(pattern, 'gi'))]
		.map((match) => ({ index: match.index, value: match[1]?.trim() }))
		.filter((match): match is { index: number; value: string } => Boolean(match.value)));
	if (field.heuristicMatchMode === 'all') {
		return [...new Set(matches.sort((left, right) => left.index - right.index).map((match) => match.value))].join(', ') || undefined;
	}
	return matches.sort((left, right) => right.index - left.index)[0]?.value;
}

function coerceFieldValue(field: MetadataFieldDefinition, value: string): HeuristicMetadataValue {
	if (field.type === 'integer') return Number.parseInt(value.replaceAll('_', ''), 10);
	if (field.type === 'boolean') return true;
	return field.type === 'number_with_unit' ? unitNormalizer.normalize(value, field.key) : value;
}

function stripPythonComments(content: string): string {
	return content.split('\n').map((line) => {
		let quote: '"' | "'" | null = null;
		let escaped = false;
		for (let index = 0; index < line.length; index += 1) {
			const character = line[index];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\') {
				escaped = true;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = quote === character ? null : quote ?? character;
				continue;
			}
			if (character === '#' && quote === null) return line.slice(0, index);
		}
		return line;
	}).join('\n');
}