# Contributing

Thanks for helping. A few rules keep the project small and easy to review.

- **Talk first about big changes.** For a new feature, a new dependency or a change to how the bot behaves, open an issue before writing code. Small fixes can go straight to a pull request.
- **`npm run check` must pass**: typecheck, lint (Biome) and tests. `npm run format` fixes formatting. You need Node.js 24.15 or newer; run `npm ci` once (install scripts are off).
- **Tests come with the change.** Use the fakes in `test/` instead of the network, and cover the edge cases and failure paths, not only the happy path.
- **Keep commits small and focused**, with [Conventional Commits](https://www.conventionalcommits.org/) messages such as `fix: keep the reply ping off on edits` or `feat: add a per-channel cap`.
- **Code style**: strict TypeScript, no `any` except at a clearly commented library boundary, small functions, short plain comments. Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- **No secrets or personal data in tests or fixtures.** Use obvious fakes such as `sk-ant-test` and made-up IDs.
- **Dependencies**: as few as possible, pinned to exact versions, with AGPL-compatible licences (MIT, Apache-2.0, BSD, ISC) and no install scripts.
- **Licence**: by contributing, you agree that your work is licensed under the AGPL-3.0-or-later, like the rest of the project.

Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

Releases: a maintainer sets the version with `npm version X.Y.Z --no-git-tag-version` (it updates package.json and package-lock.json), merges that to `main`, and tags the merged commit, once its CI passes, with `vX.Y.Z`. The release workflow refuses a tag that doesn't match package.json, then builds, signs and publishes the image and creates the GitHub release.
