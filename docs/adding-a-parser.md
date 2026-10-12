# Adding a heuristic parser

WP3 parsers share the filesystem and provenance work in `src/parser/base.ts`. A parser should usually only decide how already-loaded text maps to metadata fields.

## Parser contract

A parser extends `BaseHeuristicParser` and implements two things:

```ts
import { BaseHeuristicParser, HeuristicMetadataValue } from './base';
import { MetadataFieldDefinition } from '../metadata-schemas';

export class ExampleParser extends BaseHeuristicParser {
	readonly name = 'Example';

	protected extractMetadata(
		content: string,
		folderName: string,
		fields: readonly MetadataFieldDefinition[],
	): Partial<Record<string, HeuristicMetadataValue>> {
		return extractExampleMetadata(content, folderName, fields);
	}
}
```

The public `parse()` method is inherited. It:

1. Resolves and validates the experiment directory.
2. Recursively discovers physical files.
3. Records file size, modification time, and a SHA-256 hash for files up to the configured hash limit.
4. Skips files that are too large, known binary formats, or contain binary content when building source text.
5. Extracts code cells from Jupyter notebooks.
6. Finds quoted file references and records them as `referenced` files when they are not physically present.
7. Calls the subclass's `extractMetadata()` with the combined readable text.
8. Returns `ParsedRunResult`, including source path, metadata, file provenance, and skipped-file diagnostics.

A parser does not need to walk directories, read files, calculate hashes, or write to SQLite. The import flow passes its result to `RunDatabase.importParsedRun()`.

## Follow the OpenMM example

`src/parser/openmm.ts` is the reference implementation. It has three small layers:

- `OpenMmParser` supplies the parser name and delegates to an extraction function.
- The extraction function iterates over the fields from the selected schema.
- Field-specific extraction uses schema patterns first, then parser-aware fallbacks for names and methods.

The GROMACS implementation in `src/parser/gromacs.ts` follows the same shape. It reads `.mdp` key/value lines and GROMACS log output from the combined text, then provides fallbacks for workflow, method, pressure coupling, and topology includes.

Prefer schema patterns for straightforward values:

```ts
function extractPatternValue(
	field: MetadataFieldDefinition,
	content: string,
): string | undefined {
	const match = new RegExp(field.heuristicPatterns?.[0] ?? '', 'im').exec(content);
	return match?.[1]?.trim();
}
```

Use parser code for semantics that require more than a regular expression, such as mapping GROMACS `steep` to `minimization` or distinguishing NVT and NPT workflows.

## Add a schema

Schemas are JSON files with a unique human-readable name and a `fields` array. Every field must define:

- `key`
- `label`
- `type`: `string`, `number_with_unit`, `integer`, or `boolean`
- `description`
- `required`
- `includeInFrontmatter`

Optional `heuristicPatterns` and `heuristicMatchMode` describe simple extraction rules. The loader validates regular expressions before synchronizing the schema into SQLite.

The bundled GROMACS schema is [schemas/gromacs.json](../schemas/gromacs.json). To use it in a vault, place or copy it into the vault's `.metadata_schemas` folder used by the plugin. The runtime loader treats the vault schema as editable user input; bundled schemas are not silently injected into the vault.

Choose keys that describe stable scientific concepts rather than parser implementation details. GROMACS fields in the bundled schema include:

- run and workflow names
- engine version
- method
- force field includes
- temperature and pressure
- timestep and total steps
- pressure coupling
- Coulomb and Van der Waals methods
- bond constraints

## Register the parser

Add the parser to the `parsers` list in `src/import/import-runs-modal.ts`:

```ts
private readonly parsers: BaseHeuristicParser[] = [
	new OpenMmParser(),
	new GromacsParser(),
];
```

The parser name appears in the import dropdown and is retained as the last-used parser setting. The user must select a schema whose fields match the parser's extraction logic.
