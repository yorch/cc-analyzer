---
"cc-analyzer": patch
---

Fix the landing page's `SoftwareApplication` JSON-LD: replace the unrecognized `codeRepository` property with `sameAs` so the schema validator reports no warnings.
