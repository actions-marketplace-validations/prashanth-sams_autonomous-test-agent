# Autonomous Test Agent

One shared exploratory-testing core with platform-specific executors. **The web
agent (Playwright) is implemented**; mobile and desktop executors plug into the
same core by implementing one interface.

The agent opens the real application, navigates workflows, changes state,
explores unexpected paths, and records defects that it has replayed from a clean
start before reporting them.

## Architecture

```
apps/web-agent            CLI product: explore a site, or test a pull request
packages/shared-contracts Types every layer agrees on (no platform code)
packages/agent-core       The shared intelligence — see below
executors/web-playwright  Web executor: DOM/a11y, network, console, traces
examples/demo-app         A deliberately buggy shop used to evaluate the agent
```

`agent-core` never imports platform code. It talks to the application through
one seam:

```ts
interface PlatformExecutor {
  start(): Promise<void>;
  observe(): Promise<ApplicationState>;
  availableActions(state: ApplicationState): Promise<Action[]>;
  execute(action: Action): Promise<ActionResult>;
  runScriptedStep(step: ScriptedStep): Promise<ActionResult>;
  captureEvidence(label: string): Promise<EvidenceRef[]>;
  drainObservations(): Observation[];
  reset(): Promise<void>;
  stop(): Promise<void>;
}
```

A mobile (Appium) or desktop (UI Automation / macOS Accessibility) executor
implements the same interface — planning, memory, oracles, defect handling and
reporting are reused unchanged.

### What the core does

| Component | Responsibility |
| --- | --- |
| `StateMemory` | State graph, visit counts, what has been tried, the journey walked |
| `CoverageTracker` | Routes, states, elements and actions actually exercised |
| `RiskEngine` | Scores each candidate action, and records *why* — every choice is explainable |
| `Planner` | Picks the next action (deterministic heuristic planner; the interface allows an AI planner) |
| Oracles | Decide what counts as wrong (see below) |
| `DefectRepository` | Fingerprints, deduplicates, scores confidence, suppresses known false positives |
| `DefectVerifier` | Replays each candidate from a clean state before it is reported |
| `SafetyPolicy` | Blocks destructive and prohibited actions, confines navigation, redacts secrets |
| `analyzeImpact` | Turns a PR diff into targeted missions with a confidence score |
| Reporting | `run.json`, a PR-ready `report.md` and a self-contained `report.html` |

### Test oracles

Navigation is not the hard part; knowing what is wrong is. The agent detects
automatically:

- page crashes and unhandled JavaScript exceptions
- failed HTTP requests (5xx always; 4xx unless configured as expected)
- broken links
- controls that accept a click and do nothing
- submits that produce no visible outcome
- empty screens, permanent spinners and error screens
- accessibility violations (axe-core, serious/critical only — opt in)

It cannot know whether a discount should be 10% or 20%, so business invariants
are configured:

```yaml
rules:
  - id: single-order-per-checkout
    description: An order must never be created twice for one checkout
    maxRequests: { method: POST, urlPattern: '/api/orders$', max: 1 }
    severity: critical

  - id: no-delete-for-viewers
    description: A viewer must not see the delete button
    route: /profile
    forbidElement: { role: button, name: delete }
```

### Trust rules built into the flow

- Every candidate defect is **replayed from a clean state**; only reproduced,
  high-severity findings can recommend blocking a merge. A broken critical
  journey is replayed by **re-running its script**, so it is checked again
  exactly as it was configured.
- Verification replays use a **fresh request log**, so cumulative rules cannot
  "reproduce" themselves trivially.
- Every action is recorded, and every defect ships with steps, screenshots, DOM,
  console log, a Playwright trace and a **runnable `.spec.ts` reproduction**.
- The report states which journeys were selected **and why**, lists every flow
  it **tested** with the routes that flow reached, and names the ones that were
  **not tested**.
- A pull request tests **only what its diff touches**: the journeys it maps to,
  critical journeys included. Running every critical journey
  (`alwaysRunCriticalJourneys`) and exploring the rest of the app
  (`freeExploration`) are both opt-in. Low impact confidence broadens the scope
  only with free exploration on; otherwise the report says the scope stayed
  narrow and names the critical journeys it did not run.
- Destructive actions are blocked by default; `advisory` mode is the default and
  cannot block a merge.

## Quick start

```bash
npm install
npm run build
npx playwright install chromium

# Terminal 1 — the deliberately buggy demo shop
node examples/demo-app/dist/server.js

# Terminal 2 — explore it
node apps/web-agent/dist/cli.js explore --config agent.example.yaml --max-steps 60
```

Against the demo app the agent finds all six seeded defects and reproduces each
one: duplicate order creation, an order booked on a declined card, an HTTP 500,
an unhandled exception, a dead "Apply coupon" button, and a broken Help link.

Reports land in `runs/<run-id>/`:

```
runs/run-.../report.md      PR comment / check summary
runs/run-.../report.html    self-contained run report
runs/run-.../run.json       machine-readable result
runs/run-.../artifacts/     screenshots, DOM, console log, trace.zip, DEF-*.spec.ts
```

## Testing a pull request

```bash
node apps/web-agent/dist/cli.js pr \
  --config agent.example.yaml \
  --base origin/main --head HEAD \
  --url https://preview-123.example.com
```

The diff is mapped to areas and journeys through `impactMap` in the config.
Only the journeys the diff maps to run, each within its own budget, so areas the
change did not touch are not tested. A critical journey is selected the same
way: an impacted area lists its `id` or `name` under `journeys`, and the
journey then runs once, with its script. Two wider scopes are off by default;
turn either on in the config, or with a flag for a single run, when you need
it:

- `alwaysRunCriticalJourneys: true` (`--always-run-critical-journeys`) runs
  every critical journey on every PR, whatever the diff touches.
- `freeExploration: true` (`--free-exploration`) spends the budget the selected
  journeys leave over exploring the rest of the app, and lets low impact
  confidence broaden the scope.

`explore` runs always run every critical journey and explore. The PR comment
explains the selection:

```
| Area                | Confidence | Journeys                              |
| Checkout / Payments | 90%        | checkout, payment retry, declined card |
| Authentication      | 85%        | login, session expiry, logout          |
```

It then lists the scope it actually tested. Flows the budget did not reach
appear under **Not tested**:

```
| Flow                          | Type             | Result    | Steps | Routes                     |
| Checkout                      | critical journey | completed | 21    | /checkout                  |
| Browse products               | critical journey | completed | 15    | /products, /cart, /        |
| Checkout / Payments: payment retry | impact analysis | completed | 14 | /, /checkout, /cart, … |
```

Exit codes: `0` pass, `1` review, `2` block, `3` agent error.

`3` also covers a run where every mission failed to execute. "The agent could
not test this" is never reported as a pass — an empty defect list only means
something when at least one mission actually ran. A mission is **errored** when
the agent itself broke while running it, and **failed** when it ran and its
journey broke. A failed journey is a test result: its defect decides the
verdict, never exit code `3`. A run that selects nothing, such as a diff that
maps to no journey, exits `0` but is reported as **Nothing to test**, never as
passed.
`.github/workflows/qa-agent.yml` runs this repository's own Action
(`uses: ./`) on every pull request against the demo app, so each PR also tests
the Action the way other repositories use it.

## Use it as a GitHub Action

This repository is also a composite action, so another repository can run the
agent without vendoring any of it:

```yaml
name: QA Agent
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  explore:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # impact analysis needs both sides of the diff

      - uses: prashanth-sams/autonomous-test-agent@v1
        with:
          url: ${{ vars.PREVIEW_URL }}
          config: qa/agent.yaml
          comment: 'true'
```

The action builds the agent and installs Chromium itself; the caller supplies a
running preview environment. Without `fetch-depth: 0` the agent cannot map the
diff to journeys, so nothing runs unless `alwaysRunCriticalJourneys` or
`freeExploration` is on.

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `url` | *required* | Base URL of a test or preview environment — never production |
| `mode` | `pr` | `pr` for impact-driven testing, `explore` for a free exploratory run |
| `config` | — | Agent config path, relative to the caller's repository root |
| `base` / `head` | `origin/<base_ref>` / `github.sha` | Refs compared in `pr` mode |
| `changed-files` | — | Comma-separated paths, instead of running `git diff` |
| `always-run-critical-journeys` | `false` | `pr` mode: run every critical journey, not only the ones the diff maps to. `false` leaves it to the config, which defaults to off |
| `free-exploration` | `false` | `pr` mode: also explore the whole app with the leftover budget. `false` leaves it to the config, which defaults to off |
| `max-steps` | — | Override the step budget from the config |
| `output-dir` | `qa-agent-runs` | Where reports and evidence are written |
| `blocking` | `false` | Allow a reproduced blocking defect to fail the job |
| `comment` | `false` | Post the report as a PR comment, replacing the previous one (needs `pull-requests: write`) |
| `upload-artifact` | `true` | Upload the run directory as a workflow artifact |

### Outputs

| Output | Description |
| --- | --- |
| `result` | `pass`, `review`, `block` or `error` |
| `exit-code` | `0` pass, `1` review, `2` block, `3` agent error |
| `run-id` | Identifier of the completed run |
| `run-dir` | Absolute path to the run directory |
| `report-markdown` / `report-html` / `run-json` | Absolute path to each report |

The job fails only when the agent could not execute, or when `blocking: 'true'`
and a reproduced defect recommends blocking; a `review` result stays advisory.
The report is written to the job summary either way. With `comment: 'true'`,
each run posts its report at the bottom of the PR, stamped with the commit and
a link to the run, and deletes the previous report, so the PR keeps one, always
the latest. Commenting is skipped for pull requests from forks, whose tokens
cannot write to the PR.

## Configuration

See [agent.example.yaml](agent.example.yaml). Key sections:

| Section | Purpose |
| --- | --- |
| `target` | Base URL and build identifier |
| `auth` | Deterministic login steps or a saved `storageState` |
| `criticalJourneys` | High-value journeys, optionally fully scripted. A PR runs one when an impacted area lists its `id` or `name`; `explore` runs them all |
| `alwaysRunCriticalJourneys` | Opt-in (default `false`): run every critical journey on every `pr` run, whatever the diff touches |
| `rules` | Business invariants the agent cannot infer |
| `limits` | Step, time and defect budgets; verification attempts |
| `safety` | Allowed hosts, prohibited/destructive actions, redaction keys |
| `impactMap` | Changed paths → area → journeys, with confidence |
| `freeExploration` | Opt-in (default `false`): whether leftover budget explores the whole app in `pr` runs. Off, a PR tests only the journeys its diff maps to. `explore` runs always explore |
| `oracles` | Which oracles run, and what noise to ignore |
| `knownFalsePositives` | Fingerprints humans dismissed in earlier runs |
| `mode` | `advisory` (default) or `blocking` |

## CLI

```
qa-web-agent explore [--url <baseUrl>] [--config agent.yaml] [options]
qa-web-agent pr      --base <ref> --head <ref> [--config agent.yaml] [options]

--max-steps <n>        Override the step budget
--headed               Run the browser headed
--browser <name>       chromium | firefox | webkit
--out <dir>            Output directory (default: runs)
--blocking             Allow the agent to recommend blocking a merge
--changed-files <a,b>  Explicit file list instead of running git diff
--free-exploration     pr: explore the whole app with the leftover budget
--always-run-critical-journeys
                       pr: run every critical journey, impacted or not
--json                 Print the run summary as JSON
```

## Tests

```bash
npm test
```

22 unit tests cover impact analysis, defect deduplication and confidence, the
merge recommendation, safety policy, risk scoring, the oracles, verification of
broken critical journeys, and the tested-scope report.

## Not built yet

Deliberately deferred, in the order the design calls for: mobile and desktop
executors, a GitHub App (the workflow uses the Actions token), an AI planner
behind the existing `Planner` interface, run history across executions, and
visual regression.
