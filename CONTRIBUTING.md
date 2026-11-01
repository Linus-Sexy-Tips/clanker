# Contributing

- Open an issue before starting a new feature, adding a dependency, or changing how the bot behaves. Small fixes can go straight to a pull request.
- Use Node.js 24.15 or newer. Run `npm ci` once; install scripts are off.
- `npm run check` (typecheck, Biome lint, and tests) must pass. `npm run format` fixes formatting.
- Add tests with every change. Use the fakes in `test/` instead of the network, and cover failure paths.
- Keep commits small, with [Conventional Commits](https://www.conventionalcommits.org/) messages such as `fix: keep the reply ping off on edits`.
- Strict TypeScript. No `any` except at a commented library boundary. Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- No secrets or personal data in tests or fixtures. Use placeholders such as `sk-ant-test` and made-up IDs.
- Few dependencies, pinned to exact versions, with AGPL-compatible licences and no install scripts.
- Contributions are licensed under AGPL-3.0-or-later.

Report security problems through [SECURITY.md](SECURITY.md), not the issue tracker.

## Releases

1. Run `npm version X.Y.Z --no-git-tag-version` and merge the change to `main`.
2. When CI passes on the merged commit, tag it `vX.Y.Z` and push the tag.

The release workflow rejects a tag that doesn't match `package.json`, then publishes the signed image and the GitHub release.
