# Fabricator (demonstrator)

Fabricator is an [Obsidian](https://obsidian.md) plugin for importing and organizing computational experiment runs (e.g. molecular dynamics simulations). It:

- parses run folders (currently **GROMACS** and **OpenMM**) and extracts metadata according to configurable metadata schemas;
- stores the runs in a local SQLite database and generates/syncs run notes (with frontmatter) and a runs base inside your vault;
- can optionally use a local OpenAI-compatible LLM server (e.g. `llama.cpp`) to augment the extracted metadata. LLM use is opt-in per import and defaults to a loopback-only URL (`http://127.0.0.1:8080`).

> **Status:** demonstrator release of the current version, provided as-is. Expect rough edges.

## Requirements

- Obsidian **1.11.4 or later**, desktop only.
- Optional: a running `llama.cpp` (or other OpenAI-compatible) server for LLM-assisted import.

## Installation (prebuilt)

1. Create the folder `<YourVault>/.obsidian/plugins/fabricator/`.
2. Copy `dist/main.js`, `dist/manifest.json` and `dist/styles.css` into it.
3. Create the folder `<YourVault>/.metadata_schemas/` and copy `schemas/gromacs.json` into it (a default schema is created automatically if none exists; run the command **Refresh metadata schemas** after adding files or reopen obsidian).
4. In Obsidian: *Settings → Community plugins →* turn off Restricted mode, then enable **Fabricator**.

## Installation (from source)

Requires Node.js 18+.

```bash
npm install
npm run build
```

Then copy the generated `dist/main.js`, `dist/styles.css` and `dist/manifest.json` to `<YourVault>/.obsidian/plugins/fabricator/` as above. `npm run dev` rebuilds `dist/main.js` on change; `npm run lint` runs ESLint.

## Trying it out

The `examples/` folder holds a few small run folders:

- `examples/openmm/` – two OpenMM example runs

Copy one of them somewhere accessible, click the **Import experiment runs** ribbon icon (folder-plus) in Obsidian, select the run folder and the matching schema (e.g. *OpenMM molecular dynamics*), review the preview, and import.

## Repository layout

| Path | Content |
| --- | --- |
| `dist/` | Prebuilt plugin files to install |
| `src/` | TypeScript source |
| `schemas/` | Metadata schema definitions (`gromacs.json`) |
| `docs/` | Design notes |
| `examples/` | Sample run folders |

See `docs/adding-a-parser.md` for how to support another simulation engine.
