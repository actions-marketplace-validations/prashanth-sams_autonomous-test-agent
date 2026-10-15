# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
this repository's release tags.

## [1.0.4] - 2026-10-14

### Added

- `freeExploration` config option, default `true`. Set it to `false` to test
  only the selected journeys:
  - The selected missions share the whole step budget, split evenly with any
    remainder going to the highest priority, instead of leaving what is left
    over to a free-exploration mission. Scripted steps count against the
    budget.
  - Low impact confidence no longer broadens the scope, and the impact notes
    in the report say so.
  - When no journey is selected, the run tests nothing.

### Changed

- A run that selects no mission no longer starts the app or logs in. Its
  report reads **Nothing to test** instead of **Passed** and "Safe to merge".
  It still exits `0`, and `recommendation` is still `pass`.
- When no journey is selected, `report.md` explains why under "Why no journey
  was selected", including the changed files the impact map does not cover.

### Fixed

- Reproduction steps in `report.md` show as 1, 2, 3 on GitHub, not i, ii, iii.
- In `.github/workflows/qa-agent.yml`, a review verdict no longer marks the
  agent step failed with a "Process completed with exit code 1" error. The job
  result is unchanged.

## [1.0.3] - 2026-10-14

### Added

- A **Scope tested** section in `report.md` and `report.html`: one row per
  flow that ran, with its type, result, steps taken and the routes it reached.
  `report.md` shows the first five routes; `report.html` and `run.json` list
  them all.
- `report.html` lists the flows that were **not tested**, as `report.md` does.
  Together with Scope tested, this replaces its Missions table.
- An `errored` mission status, for a mission the agent itself broke on.
  `failed` now means only that the mission ran and its journey broke, which is
  a test result.
- `run.json` fields: `coverage.missions[].routes`, the routes each mission
  reached in the order first reached, and `missions[].error`, why an errored
  mission stopped.

### Changed

- **Not tested** gives each mission its own reason: skipped, with why the run
  stopped, or errored, with the error.
- The Missions line in `report.md` counts errored missions.
- Critical-journey defects start at 0.9 confidence instead of 0.5, the same as
  business rules.

### Fixed

- A broken critical journey is verified by re-running its script from a clean
  state. The generic replay could never reproduce one, so it was reported as
  not reproduced and left out of the verdict.
- A run whose missions all ended in broken critical journeys was reported as
  `error` (exit code `3`, "Could not test"). Only missions the agent itself
  broke on count toward `error` now; a broken journey's defect decides the
  verdict.

## [1.0.2] - 2026-10-13

### Added

- A `run-id` action output. The evidence artifact is named after it:
  `autonomous-test-agent-<attempt>-<run-id>`.
- The action writes the report to the job summary, and rejects invalid inputs
  with a clear error before starting the agent.
- `--json` output includes `runDir` and the path to each report.

### Changed

- `report.md` separates defects with a horizontal rule.

### Fixed

- The action could not run: `action.yml` calls `scripts/action-runner.mjs`,
  which 1.0.1 does not include.
- A run in which every mission failed to execute passed, because it found no
  defects. It now reports `error` (**Could not test**, exit code `3`), a new
  `recommendation` value in `run.json`.
- A failed login or app start ends the run with an `error` report that gives
  the reason, with evidence of the page the login stopped on. Before, the run
  stopped without writing any report.
- A start that fails after the browser launches, such as an unreachable URL,
  no longer leaves the process running.
- `.github/workflows/qa-agent.yml` fails the check when the agent errors (exit
  code `3`), not only when it blocks. It finds its earlier comment on a pull
  request with more than 30 comments instead of posting another, and never
  edits a comment it did not write.

## [1.0.1] - 2026-09-17

First tagged release.

### Added

- The web exploratory testing agent: a shared core for planning, state memory,
  oracles, defect handling and reporting, driving a Playwright executor
  through the `PlatformExecutor` interface.
- `qa-web-agent explore` for a free exploratory run, and `qa-web-agent pr` to
  test a pull request: `impactMap` maps the diff to journeys, critical
  journeys always run, and low confidence broadens the scope.
- Oracles for page crashes, unhandled exceptions, failed requests, broken
  links, controls that do nothing, submits with no outcome, empty or stuck
  screens, accessibility (axe-core, opt in) and configurable business rules.
- Defect verification: each candidate is replayed from a clean state,
  deduplicated by fingerprint and scored for confidence. Known false positives
  are suppressed.
- A safety policy that blocks destructive and prohibited actions, confines
  navigation to allowed hosts and redacts secrets.
- `run.json`, `report.md` and a self-contained `report.html`. Each defect
  ships with screenshots, DOM, console log, a Playwright trace and a runnable
  `.spec.ts` reproduction.
- Exit codes `0` pass, `1` review, `2` block, `3` agent error. `advisory` mode,
  the default, never blocks a merge.
- A composite GitHub Action (`action.yml`), and a workflow that tests this
  repository's pull requests and keeps one updated PR comment.
- A deliberately buggy demo shop with six seeded defects.

### Known issues

- The action cannot run, because `scripts/action-runner.mjs` is missing. Use
  1.0.2 or later.

[Unreleased]: https://github.com/prashanth-sams/autonomous-test-agent/compare/v1.0.3...1.0.4
[1.0.3]: https://github.com/prashanth-sams/autonomous-test-agent/compare/1.0.2...v1.0.3
[1.0.2]: https://github.com/prashanth-sams/autonomous-test-agent/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/prashanth-sams/autonomous-test-agent/releases/tag/1.0.1
