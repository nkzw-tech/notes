# Working with this Notes workspace

Markdown files are the source of truth. Preserve the user's writing and existing document structure unless they ask for a change.

## Workspace structure

- `docs/` contains regular documents.
- `interviews/` contains numbered interview documents.
- `meetings/` contains meeting overviews named `YYYY-MM-DD.md`.
- `people/` contains numbered person documents.
- `reports/` contains report documents.
- Files beginning with `_` are reusable templates and do not appear in the sidebar. Do not edit them unless the user asks to change a template.

## Formatting

- Keep each prose paragraph and ordinary list item on one source line. Let the editor handle visual wrapping.
- Preserve structural newlines for headings, lists, tables, code blocks, and separate metadata fields.
- Use relative Markdown links between workspace documents. Links to another workspace document open inside Notes.
- Preserve recognized metadata labels such as `**Cue:**`, `**Retrieval cue:**`, `**Title:**`, `**Level:**`, `**Person number:**`, and `**Archived:**`.

## Creating documents

- Use the matching `_template.md` when creating a person, report, or interview.
- Person and interview filenames begin with a zero-padded permanent number, while their H1 uses the same number without padding.
- Report filenames are unnumbered; their permanent person number lives in the `**Person number:**` field.
- `config/workspace.json` contains the next person and interview numbers. Increment the appropriate counter when creating a numbered document and never reuse an earlier number.
- `config/people.json` contains the visible `people/*.md` paths shown under People. A person not listed there appears under Upcoming Meetings.
- Adding an `**Archived:** YYYY-MM-DD` field to a person document moves it to Archive.

## Editing safely

- Do not overwrite unrelated user changes.
- Do not delete or rename documents unless the user explicitly asks.
- Keep populated notes, follow-ups, and relationship context when reorganizing a document.
- Verify that internal Markdown links still point to existing files after moving or deleting anything.
