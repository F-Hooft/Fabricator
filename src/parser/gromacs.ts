import { BaseHeuristicParser, HeuristicMetadataValue } from './base';
import { unitNormalizer } from './units';
import { MetadataFieldDefinition } from '../metadata-schemas';

/** Extracts common run metadata from GROMACS .mdp files, topology files, and logs. */
export class GromacsParser extends BaseHeuristicParser {
	readonly name = 'GROMACS';

	protected extractMetadata(content: string, folderName: string, fields: readonly MetadataFieldDefinition[]): Partial<Record<string, HeuristicMetadataValue>> {
		return extractGromacsMetadata(content, folderName, fields);
	}
}

/** Extracts GROMACS metadata from already-loaded text files. */
export function extractGromacsMetadata(content: string, folderName: string, fields: readonly MetadataFieldDefinition[]): Partial<Record<string, HeuristicMetadataValue>> {
	const metadata: Partial<Record<string, HeuristicMetadataValue>> = {};
	for (const field of fields) {
		const value = extractField(field, content, folderName);
		if (value !== undefined) metadata[field.key] = value;
	}
	return metadata;
}

function extractField(field: MetadataFieldDefinition, content: string, folderName: string): HeuristicMetadataValue | undefined {
	const patternValue = extractPatternValue(field, content);
	if (patternValue !== undefined) return coerceFieldValue(field, patternValue);

	switch (field.key) {
		case 'run_name':
		case 'workflow_name':
			return field.key === 'workflow_name' ? inferWorkflow(content) : folderName;
		case 'method':
			return inferMethod(content);
		case 'pressure_coupling':
			return hasEnabledValue(content, 'pcoupl');
		case 'force_field':
			return extractForceFields(content);
		default:
			return undefined;
	}
}

function extractPatternValue(field: MetadataFieldDefinition, content: string): string | undefined {
	const matches = (field.heuristicPatterns ?? []).flatMap((pattern) => [...content.matchAll(new RegExp(pattern, 'gim'))]
		.map((match) => ({ index: match.index ?? 0, value: match[1]?.trim() }))
		.filter((match): match is { index: number; value: string } => Boolean(match.value)));
	if (field.heuristicMatchMode === 'all') {
		return [...new Set(matches.sort((left, right) => left.index - right.index).map((match) => match.value))].join(', ') || undefined;
	}
	return matches.sort((left, right) => right.index - left.index)[0]?.value;
}

function coerceFieldValue(field: MetadataFieldDefinition, value: string): HeuristicMetadataValue {
	if (field.type === 'integer') return Number.parseInt(value.replaceAll('_', ''), 10);
	if (field.type === 'boolean') return /^(?:yes|true|on|1)$/i.test(value);
	return field.type === 'number_with_unit' ? unitNormalizer.normalize(value, field.key) : value;
}

function inferMethod(content: string): string | undefined {
	const integrator = getMdpValue(content, 'integrator')?.toLocaleLowerCase();
	if (!integrator) return undefined;
	if (integrator === 'steep' || integrator === 'cg' || integrator === 'l-bfgs' || integrator === 'nm') return 'minimization';
	if (integrator === 'md' || integrator === 'md-vv' || integrator === 'md-vv-avek' || integrator === 'sd' || integrator === 'bd') return 'molecular_dynamics';
	return integrator;
}

function inferWorkflow(content: string): string | undefined {
	const method = inferMethod(content);
	if (method === 'minimization') return 'minimization';
	if (method === 'molecular_dynamics') {
		if (hasEnabledValue(content, 'pcoupl')) return 'npt_md';
		if (hasEnabledValue(content, 'tcoupl')) return 'nvt_md';
		return 'md';
	}
	return method;
}

function getMdpValue(content: string, key: string): string | undefined {
	const pattern = new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*([^;#\n]+)`, 'im');
	return pattern.exec(content)?.[1]?.trim().split(/\s+/)[0];
}

function hasEnabledValue(content: string, key: string): boolean {
	const value = getMdpValue(content, key);
	return Boolean(value && !/^(?:no|none|false|0)$/i.test(value));
}

function extractForceFields(content: string): string | undefined {
	const includes = [...content.matchAll(/^\s*#include\s+["<]([^">]+)[">]/gim)]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value));
	return [...new Set(includes)].join(', ') || undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
