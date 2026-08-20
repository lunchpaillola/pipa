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
