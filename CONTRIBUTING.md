# Contributing

Orca welcomes contributions across runtime code, infrastructure, evaluation, and documentation.

## Development Flow

1. Install dependencies with `pnpm install`.
2. Start local infrastructure with `docker compose up -d`.
3. Run the services with:
   - `pnpm --filter @orca/memory-api dev`
   - `pnpm --filter @orca/worker dev`
4. Before opening a PR, run:
   - `pnpm typecheck`
   - `pnpm build`
   - `pnpm test`

## Pull Request Expectations

- Keep changes scoped to one main concern when possible.
- Add or update tests when behavior changes.
- Update docs when API shape, config, or deployment behavior changes.
- Prefer small, reviewable patches over broad refactors without migration notes.

## Architecture Expectations

- Preserve the control-plane vs data-plane separation.
- Keep memory modules pluggable and substrate-agnostic at the contract layer.
- Avoid hard-coding one backend where an adapter boundary already exists.

## Commit and PR Notes

- Use descriptive commit messages.
- Include a short validation note in the PR description.
- Call out breaking config or deployment changes explicitly.
