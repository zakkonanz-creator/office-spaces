# Contributing

Thanks for helping out.

## Setup

Follow [section 1 of the README](README.md#1-try-it-on-your-computer-10-minutes) to run it locally. You need Node 22+ and LiveKit.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Both must pass (CI runs them, plus `npm run build`). If you changed anything on the floor, in the browser or in the media code, also run `npm run e2e` with `npm run dev` running (see "Tests" in the README).

## Keep pull requests small

One change per pull request, with a short description of what it does and why. Small PRs get reviewed and merged faster. For a bigger change, open an issue first so we can agree on the approach.

## Security

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
