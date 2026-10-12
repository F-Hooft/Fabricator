import { MetadataSchema } from '../metadata-schemas';

/** Builds a grammar for an optional subset of metadata fields, with an optional leading reasoning summary. */
export function buildMetadataGrammar(schema: MetadataSchema, includeReasoning = false): string {
	if (includeReasoning && schema.fields.some((field) => field.key === 'reasoning')) {
		throw new Error('Metadata schema field "reasoning" is reserved for the LLM evidence summary when grammar is enabled.');
	}
	const backslash = String.fromCharCode(92);
	const outputFields = includeReasoning
		? [{ key: 'reasoning', type: 'string' as const }, ...schema.fields]
		: schema.fields;
	const fieldRules = outputFields.map((field, index) => {
		const valueRule = field.type === 'boolean' ? 'boolean' : field.type === 'integer' ? 'integer' : 'string';
		return `field${index} ::= ${JSON.stringify(JSON.stringify(field.key))} ws ":" ws ${valueRule}`;
	});
	const stateRules = [`fieldsSuffix${outputFields.length} ::= ""`];
	for (let index = outputFields.length - 1; index >= 1; index -= 1) {
		stateRules.push(
			`fieldsSuffix${index} ::= "" | "," ws field${index} fieldsSuffix${index + 1} | fieldsSuffix${index + 1}`,
		);
	}
	if (!includeReasoning) {
		stateRules.push(outputFields.length > 0 ? 'fieldsStart ::= "" | field0 fieldsSuffix1' : 'fieldsStart ::= ""');
	}
	return [
		includeReasoning
			? 'root ::= "{" ws field0 fieldsSuffix1 ws "}"'
			: 'root ::= "{" ws fieldsStart ws "}"',
		'ws ::= [ \\t\\n\\r]*',
		`string ::= "${backslash}"" ( [^"${backslash}${backslash}] | "${backslash}${backslash}" ( ["${backslash}${backslash}/bfnrt] | "u" [0-9a-fA-F]{4} ) )* "${backslash}""`,
		'integer ::= "-"? ("0" | [1-9] [0-9]*)',
		'boolean ::= "true" | "false"',
		...fieldRules,
		...stateRules,
	].join('\n');
}
