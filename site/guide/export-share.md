---
title: Export and share
description: Export cc-analyzer reports safely as Markdown, HTML, JSON, CSV, or a ZIP archive.
---

# Export and share

cc-analyzer can export one session or a portfolio. Treat the default output as
private: it may include prompts, file paths, and transcript content when you
opt into transcripts.

## One session

```sh
cc-analyzer analyze <session-id> --md --out ./session.md
cc-analyzer analyze <session-id> --html --redact --out ./share.html
cc-analyzer analyze <session-id> --json --redact --out ./session.json
```

Use `--include-transcript` only when the transcript is needed. Redacted output
removes prompts and sensitive paths and caps the included transcript.

## Portfolio or project export

```sh
cc-analyzer export --format all --out ./export
cc-analyzer export --project <project-id> --format json,csv --out ./project
cc-analyzer export --session <session-id> --format md --redact --out ./share
cc-analyzer export --format all --split --out ./export
```

`--split` creates private and shareable trees. Add `--zip` when you need an
archive; ZIP export requires the system `zip` command.

The local web dashboard exposes the same export builders. Its bulk endpoint is
`GET /api/export`; a session report is
`GET /api/sessions/:id/report?format=md|html|json`.

## Before sharing

- Prefer `--redact` or the shareable tree.
- Inspect the generated files before uploading them.
- Do not include a transcript unless the recipient needs it.
- Remember that optional Analyze-with-Claude processing is different from
  local parsing; see [Privacy and security](/guide/privacy).

More examples are in [Recipes & Use Cases](/docs/10-recipes).
