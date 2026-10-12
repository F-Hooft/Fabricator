import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { MetadataFieldDefinition } from '../metadata-schemas';

export type HeuristicMetadataValue = string | number | boolean;
export type ParsedRunFileKind = 'discovered' | 'referenced';

/** File provenance collected while parsing an experiment directory. */
export interface ParsedRunFile {
	path: string;
	kind: ParsedRunFileKind;
	isPresentInExperiment: boolean;
	discoveredFromPath?: string;
	sha256?: string;
	sizeBytes?: number;
	modifiedAt?: string;
	skippedReason?: string;
}

/** Shared output for heuristic parsing and any later LLM augmentation. */
export interface ParsedRunResult {
	sourcePath: string;
	metadata: Partial<Record<string, HeuristicMetadataValue>>;
	llmAugment?: Partial<Record<string, HeuristicMetadataValue>>;
	sourceTexts?: Array<{ path: string; content: string }>;
	files: ParsedRunFile[];
	skippedFiles: Array<{ path: string; reason: string }>;
}

export interface HeuristicParserOptions {
	includeLargeMolecularStructureFilesForLlm?: boolean;
}

export type HeuristicParseResult = ParsedRunResult;

const MAX_TEXT_FILE_BYTES = 1_000_000;
const LARGE_MOLECULAR_STRUCTURE_FILE_BYTES = 50_000;
const MAX_LLM_MOLECULAR_STRUCTURE_FILE_BYTES = 5_000_000;
const MAX_HASH_FILE_BYTES = 100 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set(['dcd', 'xtc', 'trr', 'nc', 'h5', 'hdf5', 'png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'gz']);
const MOLECULAR_STRUCTURE_EXTENSIONS = new Set(['pdb', 'ent', 'cif', 'mmcif', 'gro', 'mol', 'sdf', 'mol2', 'xyz', 'pqr', 'pdbqt']);
const MAX_LLM_SOURCE_CHARACTERS = 50_000;

/** Shared filesystem scanning for parsers that extract metadata from one experiment directory. */
export abstract class BaseHeuristicParser {
	abstract readonly name: string;

	async parse(
		experimentPath: string,
		fields: readonly MetadataFieldDefinition[],
		options: HeuristicParserOptions = {},
	): Promise<HeuristicParseResult> {
		const absolutePath = resolve(experimentPath);
		const directory = await stat(absolutePath);
		if (!directory.isDirectory()) throw new Error(`Experiment path is not a directory: ${absolutePath}`);

		const filesByPath = new Map<string, ParsedRunFile>();
		const skippedFiles: Array<{ path: string; reason: string }> = [];
		const sourceFiles: Array<{ path: string; content: string }> = [];
		const llmSourceFiles: Array<{ path: string; content: string; sizeBytes: number }> = [];
		for (const path of await this.collectFiles(absolutePath)) {
			const file = await stat(path);
			const extension = extname(path).slice(1).toLocaleLowerCase();
			const isMolecularStructureFile = MOLECULAR_STRUCTURE_EXTENSIONS.has(extension);
			const isLargeMolecularStructureFile = isMolecularStructureFile && file.size > LARGE_MOLECULAR_STRUCTURE_FILE_BYTES;
			filesByPath.set(path, {
				path,
				kind: 'discovered',
				isPresentInExperiment: true,
				sha256: file.size <= MAX_HASH_FILE_BYTES ? await this.hashFile(path) : undefined,
				sizeBytes: file.size,
				modifiedAt: file.mtime.toISOString(),
			});
			if (BINARY_EXTENSIONS.has(extension)) {
				this.markSkippedFile(filesByPath, skippedFiles, path, 'known binary extension');
				continue;
			}
			const includeLargeStructureForLlm = options.includeLargeMolecularStructureFilesForLlm
				&& isLargeMolecularStructureFile
				&& file.size <= MAX_LLM_MOLECULAR_STRUCTURE_FILE_BYTES;
			if (file.size > MAX_TEXT_FILE_BYTES && !includeLargeStructureForLlm) {
				this.markSkippedFile(filesByPath, skippedFiles, path, `larger than ${MAX_TEXT_FILE_BYTES} bytes`);
				continue;
			}
			const fileContent = await readFile(path);
			let content: string;
			try {
				content = new TextDecoder('utf-8', { fatal: true }).decode(fileContent);
			} catch {
				this.markSkippedFile(filesByPath, skippedFiles, path, 'invalid UTF-8 text');
				continue;
			}
			if (content.includes('\0')) {
				this.markSkippedFile(filesByPath, skippedFiles, path, 'binary content');
				continue;
			}
			const extractedContent = this.extractNotebookCode(path, content);
			if (file.size > MAX_TEXT_FILE_BYTES) {
				llmSourceFiles.push({ path, content: extractedContent, sizeBytes: file.size });
				this.markSkippedFile(
					filesByPath,
					skippedFiles,
					path,
					`larger than ${MAX_TEXT_FILE_BYTES} bytes; included only in LLM context`,
				);
				continue;
			}
			sourceFiles.push({ path, content: extractedContent });
			llmSourceFiles.push({ path, content: extractedContent, sizeBytes: file.size });
		}

		for (const sourceFile of sourceFiles) {
			for (const reference of this.extractFileReferences(sourceFile.content)) {
				const path = this.resolveFileReference(reference, sourceFile.path);
				if (!path) {
					skippedFiles.push({ path: reference, reason: `invalid file reference in ${sourceFile.path}` });
					continue;
				}
				if (!filesByPath.has(path)) {
					filesByPath.set(path, {
						path,
						kind: 'referenced',
						isPresentInExperiment: false,
						discoveredFromPath: sourceFile.path,
					});
				}
			}
		}

		const sourceTexts: NonNullable<ParsedRunResult['sourceTexts']> = [];
		let remainingLlmCharacters = MAX_LLM_SOURCE_CHARACTERS;
		for (const sourceFile of llmSourceFiles) {
			const relativePath = relative(absolutePath, sourceFile.path).replaceAll('\\', '/');
			const extension = extname(sourceFile.path).slice(1).toLocaleLowerCase();
			const isLargeStructure = MOLECULAR_STRUCTURE_EXTENSIONS.has(extension)
				&& sourceFile.sizeBytes > LARGE_MOLECULAR_STRUCTURE_FILE_BYTES;
			if (isSensitiveSourcePath(relativePath)
				|| remainingLlmCharacters === 0
				|| (isLargeStructure && !options.includeLargeMolecularStructureFilesForLlm)) continue;
			const content = redactCredentialAssignments(sourceFile.content).slice(0, remainingLlmCharacters);
			if (!content) continue;
			sourceTexts.push({ path: relativePath, content });
			remainingLlmCharacters -= content.length;
		}

		return {
			sourcePath: absolutePath,
			metadata: this.extractMetadata(sourceFiles.map((sourceFile) => sourceFile.content).join('\n'), basename(absolutePath), fields),
			sourceTexts,
			files: [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
			skippedFiles,
		};
	}

	protected abstract extractMetadata(content: string, folderName: string, fields: readonly MetadataFieldDefinition[]): Partial<Record<string, HeuristicMetadataValue>>;

	private async collectFiles(directoryPath: string): Promise<string[]> {
		const entries = await readdir(directoryPath, { withFileTypes: true });
		const files = await Promise.all(entries.map(async (entry) => {
			const path = join(directoryPath, entry.name);
			if (entry.isFile()) return [path];
			return entry.isDirectory() ? this.collectFiles(path) : [];
		}));
		return files.flat();
	}

	private async hashFile(path: string): Promise<string> {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
		return hash.digest('hex');
	}

	private extractNotebookCode(path: string, content: string): string {
		if (extname(path).toLocaleLowerCase() !== '.ipynb') return content;
		try {
			const notebook = JSON.parse(content) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
			return (notebook.cells ?? []).filter((cell) => cell.cell_type === 'code')
				.map((cell) => Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '').join('\n');
		} catch {
			return '';
		}
	}

	private extractFileReferences(content: string): string[] {
		const extensions = 'xml|pdb|cif|gro|top|itp|prm|psf|dcd|xtc|trr|nc|h5|hdf5|log|txt|csv|json|yaml|yml|ndx|mdp|tpr';
		const pattern = new RegExp(`['"]([^'"\\n]+?\\.(?:${extensions}))['"]`, 'gi');
		const quotedReferences = [...content.matchAll(pattern)]
			.map((match) => match[1]?.trim())
			.filter((path): path is string => Boolean(path))
			.filter((path) => this.isFileReferenceCandidate(path));
		return [...new Set([...quotedReferences, ...this.extractCommandFileReferences(content, extensions)])];
	}

	private isFileReferenceCandidate(value: string): boolean {
		return !/(?:\s+-[A-Za-z]|&&|\|\||>&|\$[A-Za-z_][A-Za-z0-9_]*)/.test(value);
	}

	private extractCommandFileReferences(content: string, extensions: string): string[] {
		const inputOptions = new Set(['-f', '-s', '-n', '-p', '-c', '-r', '-e', '-q']);
		const references: string[] = [];
		for (const line of content.split('\n')) {
			if (!/\b(?:make_ndx|trjconv|grompp|editconf|genion|genconf|genrestr)\b/i.test(line)) continue;
			const tokens = line.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
			for (let index = 0; index < tokens.length - 1; index += 1) {
				const option = tokens[index]?.toLocaleLowerCase() ?? '';
				if (!inputOptions.has(option)) continue;
				const value = tokens[index + 1]?.replace(/^['"]|['"]$/g, '').trim();
				if (!value || value.startsWith('$') || value.startsWith('-') || !new RegExp(`\\.(?:${extensions})$`, 'i').test(value)) continue;
				references.push(value);
			}
		}
		return references;
	}

	private resolveFileReference(reference: string, sourcePath: string): string | null {
		if (reference.toLocaleLowerCase().startsWith('file://')) {
			try {
				return fileURLToPath(reference);
			} catch {
				return null;
			}
		}
		return isAbsolute(reference) ? resolve(reference) : resolve(dirname(sourcePath), reference);
	}

	private markSkippedFile(filesByPath: Map<string, ParsedRunFile>, skippedFiles: Array<{ path: string; reason: string }>, path: string, reason: string): void {
		const file = filesByPath.get(path);
		if (file) file.skippedReason = reason;
		skippedFiles.push({ path, reason });
	}
}

function isSensitiveSourcePath(path: string): boolean {
	const fileName = path.split('/').pop()?.toLocaleLowerCase() ?? '';
	return /(?:^|[._-])(?:env|secret|secrets|credential|credentials|password|token|private|id_rsa)(?:[._-]|$)/i.test(fileName)
		|| /\.(?:pem|key|p12|pfx|crt|cer)$/i.test(fileName);
}

function redactCredentialAssignments(content: string): string {
	return content.replace(
		/\b[A-Za-z_][A-Za-z0-9_-]*(?:api[_-]?(?:key|token)|access[_-]?token|secret|password|passwd|authorization|token|private[_-]?key)[A-Za-z0-9_-]*\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
		(_match, name: string) => `${name}=[REDACTED]`,
	);
}