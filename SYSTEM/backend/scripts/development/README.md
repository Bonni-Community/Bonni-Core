# Bonni development release assembly

`release-assembly.mjs` materializes one reviewed release tree from the clean
official base and an ordered, MAC-verified `APPROVED-CHAIN.json`. It does not
sign or publish a GitHub release.

## Partial package envelope

Every developer ZIP has exactly one `DEVELOPMENT-MANIFEST.json` and only
content-addressed payload objects:

```text
DEVELOPMENT-MANIFEST.json
payload/sha256/ab/ab…64-hex-characters
```

The manifest schema is `bonni.development-package/v1`. Each operation is one
of `add`, `replace`, or `delete` and binds the exact previous file hash.
`resultingTreeSha256` binds the complete product tree after that package.

## Assembly guarantees

- The official base must match `baseTreeSha256`.
- Confirmed packages are applied in the exact chain order.
- A rejected or failed package is ignored unless an approved package names its
  exact ID and package SHA-256 as a dependency.
- Every intermediate complete tree must match the package and chain receipts.
- The final staging tree must byte-for-byte match the separately reviewed
  `DEVELOPMENT/CURRENT` product tree.
- Staging is published by a final directory rename. A failed build leaves no
  partially published release tree.

The caller must use the verified readers from
`scripts/setup/development-package-store.mjs` before invoking the assembler.
The assembler deliberately does not trust an unverified chain or status value.

## Executable entry point

```text
node scripts/development/assemble-approved-release.mjs --request <request.json>
```

The request contains no password or master key:

```json
{
  "schema": "bonni.development-release-assembly-request/v1",
  "component": "SYSTEM",
  "productRoot": "C:\\Bonni Core",
  "stagingRoot": "C:\\Bonni Core\\GITHUB\\STAGING\\SYSTEM"
}
```

When `baseRoot` is omitted, it is derived exclusively from the MAC-verified
chain as `DEVELOPMENT/BASES/<baseVersion>/SYSTEM`. An explicitly supplied
`baseRoot` must resolve to that exact directory. Its sibling `BASE.json`, its
complete file inventory, and `chain.baseTreeSha256` must agree. Missing or
unknown bases fail closed; the active `SYSTEM` directory is never a release
base. `expectedFinalRoot` defaults to `DEVELOPMENT/CURRENT`. The local
review-key path may optionally be selected with `keyFile`. Release signing is
a separate step and is the only process that may request the master key through
redirected standard input.
