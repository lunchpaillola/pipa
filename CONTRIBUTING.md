# Contributing

Issues and focused pull requests are welcome. Open an issue before starting a large change so the approach can be agreed on first.

## Development

Pipa requires Node.js 22 or newer.

```sh
npm ci
npm test
npm run test:pack
```

Keep changes small, include a regression test for behavior changes, and never commit Slack tokens or files from `~/.pipa`.

## Releases

Pipa follows Semantic Versioning:

- New backward-compatible capability: minor release (`0.1.0` to `0.2.0`)
- Backward-compatible fix: patch release (`0.2.0` to `0.2.1`)
- Breaking change: discuss the version before release

To publish a release:

1. Update `package.json` and `package-lock.json` in the feature pull request.
2. Run `npm test` and `npm run test:pack`.
3. Merge after CI passes.
4. Tag the merge as `v<version>` and push the tag.
5. Run `npm publish --access public`.
6. Verify the published npm version, then create the matching GitHub release.
