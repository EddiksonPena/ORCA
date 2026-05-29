# Distribution Guide

This guide defines how ORCA should be distributed to end users and agent
harnesses. The goal is a simple install path for individuals, while still
supporting versioned containers, npm packages, and controlled production
rollouts.

## Recommended Channels

| Channel | Audience | Purpose |
|---------|----------|---------|
| GitHub releases | All users | Versioned source archives, release notes, checksums, and upgrade notes |
| `install.sh` | Local users and coding agents | One-command clone, environment setup, key generation, and Compose startup |
| GHCR images | Operators | Pullable `memory-api`, `worker`, and `proxy` images for Compose, Kubernetes, and managed schedulers |
| npm packages | Integrators | TypeScript contracts and harness middleware for custom agents |
| Activation bundles | Agent harnesses | Rules, hooks, MCP config, skills, and CLI snippets generated per destination |

## End-User Install Flow

For local evaluation, users should run:

```bash
curl -fsSL https://raw.githubusercontent.com/EddiksonPena/ORCA/main/install.sh | sh
```

The installer:

1. Clones the ORCA repository.
2. Creates `.env` from `.env.production.example` when missing.
3. Generates `ORCA_API_KEY` when the placeholder value is still present.
4. Starts the full Compose app profile.
5. Prints health, UI, proxy, and harness activation commands.

Supported installer overrides:

```bash
ORCA_INSTALL_DIR=~/orca \
ORCA_BRANCH=main \
ORCA_START_STACK=false \
sh install.sh
```

## Agent-Installed Flow

When a coding agent is asked to install ORCA into a harness, it should use the
repo-local CLI after the service is available:

```bash
node scripts/orca-cli.mjs install universal --enforce --destination ./orca-agent-install
```

The generated bundle includes:

- a harness rule file that makes ORCA the primary memory module
- pre-prompt/session-start recall instructions
- post-response/session-end ingest and compaction instructions
- MCP configuration for explicit memory tools
- CLI snippets for harnesses without native hook support

Harness-specific adapters can then copy the relevant bundle files into Codex,
Claude Code, Cursor, Gemini CLI, OpenCode, Aider, Goose, Cline, Roo Code,
Continue, Windsurf, Antigravity, Pi, Factory Droid, or a custom runtime.

## npm Packages

Only integration-facing packages should be published to npm:

| Package | Purpose |
|---------|---------|
| `@orca/schemas` | Shared TypeScript contracts and request validation |
| `@orca/harness` | Client, before-prompt recall, after-response ingest, and memory block rendering |

Before publishing:

```bash
npm login
pnpm build
pnpm --filter @orca/schemas publish --access public
pnpm --filter @orca/harness publish --access public
```

Keep runtime packages such as `@orca/core`, `@orca/config`, `@orca/auth`,
`@orca/memory-api`, `@orca/worker`, and `@orca/proxy` private unless they are
intentionally promoted as public SDK surfaces.

## Container Images

Publish versioned images for each runtime service:

```bash
export VERSION=0.1.0
export OWNER=eddiksonpena

docker buildx build --platform linux/amd64,linux/arm64 \
  -f apps/memory-api/Dockerfile \
  -t ghcr.io/$OWNER/orca-memory-api:$VERSION \
  -t ghcr.io/$OWNER/orca-memory-api:latest \
  --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -f apps/worker/Dockerfile \
  -t ghcr.io/$OWNER/orca-worker:$VERSION \
  -t ghcr.io/$OWNER/orca-worker:latest \
  --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -f apps/proxy/Dockerfile \
  -t ghcr.io/$OWNER/orca-proxy:$VERSION \
  -t ghcr.io/$OWNER/orca-proxy:latest \
  --push .
```

GitHub authentication for image publishing requires package write access:

```bash
gh auth refresh -h github.com -s write:packages
```

## Release Checklist

1. Confirm `main` is green and contains the intended release commit.
2. Run `pnpm typecheck`, `pnpm build`, and `pnpm test`.
3. Run `pnpm orca:preflight` against the release environment.
4. Publish npm packages when their public API changed.
5. Publish GHCR images for `memory-api`, `worker`, and `proxy`.
6. Create and push an annotated tag:

```bash
git tag -a v0.1.0 -m "ORCA v0.1.0"
git push origin v0.1.0
```

7. Create a GitHub release with install instructions, image tags, npm package
   versions, migration notes, and known limitations.
8. Verify a fresh install with:

```bash
ORCA_INSTALL_DIR="$(mktemp -d)/orca" sh install.sh
```

## GitHub Actions

Automated CI and publishing workflows should be added after the GitHub token
used to push this repository has the `workflow` scope:

```bash
gh auth refresh -h github.com -s workflow -s write:packages
```

Recommended workflows:

- `ci.yml`: install, typecheck, build, test
- `release-images.yml`: publish GHCR images on version tags
- `release-npm.yml`: publish npm packages on version tags

Keep release publishing tag-driven so `dev` can move quickly without
accidentally publishing unstable artifacts.
