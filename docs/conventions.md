# Conventions

Beyond what eslint enforces (`strictTypeChecked` + `stylisticTypeChecked`, plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`):

- **Comments explain why, never what.** The codebase is dense with reasoning comments and has
  almost no narration. Match that: if a line only restates the code, delete it.
- **Fail closed and raise.** Do not swallow exceptions or auto-recover with a default. User-facing
  error messages carry no technical detail.
- **Do not make a parameter optional if every caller passes it.** `enabledTools` is required in
  `UserToolVisibility` specifically so a new caller has to decide.
- **The UI must not claim anything the server does not do.** Several rounds of work here were
  spent removing screens that promised capabilities that did not exist. If you cannot wire it,
  do not draw it.
- **Prettier owns formatting.** Run `npm run format` before committing; `verify` fails on
  unformatted files. `git config blame.ignoreRevsFile .git-blame-ignore-revs` hides the one-time
  repository-wide formatting commit from `git blame`.
- American spelling in user-facing text.
- Brand logos come from svgl through the shadcn CLI, never hand-converted:
  `npx shadcn@latest add @svgl/<slug> --path src/app/components/ui/svgs --yes`.
  The `@svgl` registry is already in `components.json` and the root TypeScript alias exists so
  shadcn can resolve its configured output paths.

## Verification

```bash
npm run verify
```

Unit tests are database-free and cover the parts where being wrong is expensive: the prefix invariant,
the visibility filter, tool fingerprints and policy defaults, PKCE, redirect-URI matching, SSRF ranges,
metadata documents, encryption, sign-in/admin access rules. `test/integration` runs the real MCP,
OAuth-grant, refresh and key-rotation paths against Postgres, Redis and a fake upstream MCP server;
keep anything needing infrastructure there, out of `npm test`. There is no browser tier yet.
See [verification.md](verification.md) for isolated worktree setup and runtime probes.
