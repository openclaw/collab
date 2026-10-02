# Publishing Collab to ClawHub

Collab is a **code plugin**, not a skill. Its package name is `@openclaw/collab`; its runtime plugin ID is `collab`. Publishing on npm is not required for ClawHub distribution.

## Before the first release

The source is public, but there is no ClawHub release yet. The current plugin uses development-only host APIs, including the panel-opening APIs in [openclaw/openclaw#163428](https://github.com/openclaw/openclaw/pull/163428).

Before a general release:

1. Verify a released OpenClaw build includes every required SDK and Control UI API.
2. Set `peerDependencies.openclaw` and `openclaw.compat.pluginApi` to the real supported range. Set `openclaw.build.openclawVersion` to the version used to build the archive. The existing `2026.9.7` metadata describes the development baseline, not proof of compatibility with that public release.
3. Test the packed plugin on that host, including file open, inline feedback, proposal acceptance, and panel opening.
4. Sign in to ClawHub with an account allowed to publish for the **openclaw** publisher. GitHub organization access and ClawHub publisher access are separate checks.

For an earlier development preview, explicitly document and test the required host build. Do not claim a compatible stable release just to satisfy metadata validation.

### Checks completed on October 2, 2026

- A clean dependency install, linked development host, typecheck, 18 tests, browser verification, build, and OpenClaw plugin validation passed.
- ClawHub `0.23.3` accepted the package publish **dry run** for `@openclaw/collab@0.2.0`. The npm archive included the README, license, and three screenshots. Nothing was uploaded.
- The Plugin Inspector reported overall `PASS` but also one open **P1** finding: `manifest-unknown-contracts` for generated `contracts.tools` and `contracts.hooks`. The checked host's contract-key list includes `tools`, but not `hooks`. Resolve the builder/manifest/inspector disagreement before release; the exit code alone is not a clean inspection result.
- The local ClawHub CLI was not signed in. Permission to publish for the `openclaw` publisher remains unverified.

## Build an archive

Follow the source setup in the [README](../README.md), then:

```sh
npm run check
npm test
npm run test:ui
npm run build
npm run validate
npm pack --ignore-scripts
```

Use the `.tgz` path printed by `npm pack` below. Publish a built archive so the backend, manifest, and hashed browser assets travel together. This also includes the README, license, and documentation from the package's file allowlist. `dist/` is not committed to Git.

`npm run pack` is also available for OpenClaw's compact activation archive, but that archive omits the README and documentation. Prefer the npm archive for the ClawHub listing.

## Preview and publish

The commands below use ClawHub CLI `0.23.3`, the version checked during repository setup. Install it with `npm install -g clawhub@0.23.3`, or invoke it with `npm exec --yes --package=clawhub@0.23.3 -- clawhub`.

```sh
clawhub login
clawhub whoami

clawhub package validate . --openclaw /absolute/path/to/openclaw
clawhub package publish ./openclaw-collab-0.2.0.tgz \
  --family code-plugin \
  --owner openclaw \
  --source-repo openclaw/collab \
  --source-commit "$(git rev-parse HEAD)" \
  --dry-run --json
```

Check the owner, version, source commit, compatibility fields, and packaged files. Build from the clean commit named in `--source-commit`; do not attribute uncommitted code to a published commit.

In CLI `0.23.3`, `package validate` takes a **folder**, not a tarball. To check exactly what ships, extract the npm archive into a temporary directory and validate its `package/` folder. `package publish` accepts the tarball directly.

When the release is ready, run the same publish command without `--dry-run`, adding `--wait` to wait for the registry's security checks and final publication. A successful local preview is not a published release and does not prove publisher access.

After publication, verify the registry result:

```sh
clawhub package inspect @openclaw/collab
```

The user install command will then be:

```sh
openclaw plugins install clawhub:@openclaw/collab
```

## Later releases

After the first authenticated publication creates the package, a package manager can configure GitHub Actions trusted publishing for `openclaw/collab`. Use ClawHub's maintained [package publishing workflow](https://github.com/openclaw/clawhub/blob/main/.github/workflows/package-publish.yml), with a build job that provides the archive.

The current workflow supports secretless OIDC for manual `workflow_dispatch` publishes after trusted-publisher setup. Tag-push releases still require a ClawHub token. No publishing workflow or repository secret is configured by this source release.

See the official [publishing guide](https://github.com/openclaw/clawhub/blob/main/docs/publishing.md) and [CLI reference](https://github.com/openclaw/clawhub/blob/main/docs/cli.md) for current owner, artifact, and review requirements.
