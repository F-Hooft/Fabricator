import { TFile, TFolder, Vault } from 'obsidian';
import { RunDatabase } from '../db';

/** Creates or updates generated Base properties without overwriting user layout choices. */
export async function writeRunsBase(vault: Vault, database: RunDatabase, runsFolder: string, baseFile: string): Promise<void> {
	const folder = normalizeVaultPath(runsFolder, 'Run notes folder');
	const path = normalizeVaultPath(baseFile, 'Base file');
	const fields = database.listMetadataSchemas(true)
		.flatMap((schema) => database.listMetadataFields(schema.id))
		.filter((field) => field.includeInFrontmatter && field.key !== 'engine_version');
	const properties = fields
		.filter((field, index, all) => all.findIndex((candidate) => candidate.key === field.key) === index)
		.map((field) => `  ${field.key}:\n    displayName: ${JSON.stringify(field.label)}`)
		.join('\n');
	const defaultContent = [
		'filters:',
		'  and:',
		`    - file.folder == "${folder}"`,
		'properties:',
		properties,
		'views:',
		'  - type: table',
		'    name: Runs',
		'    order:',
		...fields
			.map((field) => field.key)
			.filter((key, index, all) => all.indexOf(key) === index)
			.sort(orderRunNameFirst)
			.map((column) => `      - ${column}`),
		'',
	].join('\n');
	const existing = vault.getAbstractFileByPath(path);
	if (!(existing instanceof TFile)) {
		await ensureParentFolder(vault, path);
		await vault.create(path, defaultContent);
		return;
	}

	const currentContent = await vault.read(existing);
	const updatedContent = reconcileProperties(currentContent, properties);
	if (updatedContent !== currentContent) await vault.modify(existing, updatedContent);
}

function reconcileProperties(content: string, properties: string): string {
	const lines = content.split('\n');
	const propertiesIndex = lines.findIndex((line) => line.trim() === 'properties:' && !line.startsWith(' '));
	if (propertiesIndex >= 0) {
		let endIndex = propertiesIndex + 1;
		while (endIndex < lines.length) {
			const line = lines[endIndex];
			if (line === undefined || (!line.startsWith(' ') && line.trim() !== '')) break;
			endIndex++;
		}
		lines.splice(propertiesIndex + 1, endIndex - propertiesIndex - 1, ...(properties ? properties.split('\n') : []));
		return lines.join('\n');
	}

	const viewsIndex = lines.findIndex((line) => line.trim() === 'views:' && !line.startsWith(' '));
	const propertyBlock = ['properties:', ...(properties ? properties.split('\n') : [])];
	if (viewsIndex >= 0) lines.splice(viewsIndex, 0, ...propertyBlock);
	else lines.push(...propertyBlock);
	return lines.join('\n');
}

/**
 * Orders the 'run_name' field first, then sorts the remaining fields alphabetically.
 */
function orderRunNameFirst(left: string, right: string): number {
	if (left === 'run_name') return -1;
	if (right === 'run_name') return 1;
	return left.localeCompare(right);
}

async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
	const segments = path.split('/').slice(0, -1);
	let currentPath = '';
	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (!(vault.getAbstractFileByPath(currentPath) instanceof TFolder)) {
			await vault.createFolder(currentPath);
		}
	}
}

function normalizeVaultPath(value: string, label: string): string {
	const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if (!path || path.startsWith('/') || path.includes('../')) throw new Error(`${label} must be a vault-relative path.`);
	return path;
}