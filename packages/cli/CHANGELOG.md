# /cli

## [Unreleased]

### Added

- Added the `openrouter:` seat provider: `openrouter:vendor/model` routes through the OpenAI-compatible Responses surface at openrouter.ai with `OPENROUTER_API_KEY`.

- Initial release.
- Rendered `flows logs` as a turn-by-turn transcript and `flows status <run-id>` as a diagnosis card (verdict, gating cause, refusal histogram, edit and token accounting) in human output; `--json` output is unchanged.
