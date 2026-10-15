import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  Action,
  AgentConfig,
  ApplicationState,
  Finding,
  JourneyStep,
  Mission,
  PlatformExecutor,
} from '@qa-agent/shared-contracts';
import { ExplorationAgent, recommend } from './agent';
import { DefectRepository } from './defects/repository';
import { analyzeImpact, missionsFromImpact } from './impact/analyzer';
import { StateMemory } from './memory/stateMemory';
import { InvariantOracle } from './oracles/invariants';
import { ConsoleErrorOracle } from './oracles/runtime';
import type { OracleContext } from './oracles/types';
import { RiskEngine } from './planning/risk';
import { toHtml, toMarkdown } from './reporting/writer';
import { SafetyPolicy } from './safety/policy';
import { maskRoute } from './util/route';

function config(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    target: { baseUrl: 'https://shop.example.com' },
    criticalJourneys: [],
    alwaysRunCriticalJourneys: false,
    rules: [],
    limits: {
      maxSteps: 40,
      maxDurationMs: 60_000,
      maxDefects: 20,
      verificationAttempts: 1,
      actionTimeoutMs: 5000,
    },
    safety: {
      allowedHosts: ['shop.example.com'],
      prohibitedActions: ['complete real payment'],
      destructiveKeywords: ['delete'],
      allowDestructive: false,
      redactKeys: ['password'],
    },
    impactMap: [],
    freeExploration: true,
    oracles: {
      consoleErrors: true,
      networkFailures: true,
      pageCrash: true,
      unresponsiveElements: true,
      brokenLinks: true,
      missingContent: true,
      accessibility: false,
      invariants: true,
      ignorePatterns: [],
      ignoreStatusFor: [],
    },
    planner: { kind: 'heuristic' },
    browser: { name: 'chromium', headless: true },
    knownFalsePositives: [],
    reporting: { outputDir: 'runs', video: false, trace: false, har: false },
    mode: 'advisory',
    ...patch,
  };
}

function state(patch: Partial<ApplicationState> = {}): ApplicationState {
  return {
    id: 'state-1',
    platform: 'web',
    signature: 'sig',
    location: 'https://shop.example.com/checkout',
    route: '/checkout',
    title: 'Checkout',
    elements: [],
    text: 'Checkout page',
    modalOpen: false,
    capturedAt: new Date().toISOString(),
    meta: {},
    ...patch,
  };
}

function context(patch: Partial<OracleContext> = {}): OracleContext {
  return {
    state: state(),
    observations: [],
    requestLog: [],
    config: config(),
    ...patch,
  };
}

function finding(patch: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    oracle: 'network-failures',
    title: 'HTTP 500 on POST /api/orders',
    detail: 'boom',
    severity: 'high',
    fingerprint: 'fp-1',
    stateId: 'state-1',
    route: '/checkout',
    url: 'https://shop.example.com/checkout',
    observations: [],
    at: new Date().toISOString(),
    ...patch,
  };
}

const steps: JourneyStep[] = [
  {
    index: 0,
    action: { id: 'a1', kind: 'click', description: 'Click button "Place order"' },
    stateBefore: 'state-0',
    stateAfter: 'state-1',
    ok: true,
    at: new Date().toISOString(),
  },
];

/**
 * An executor over a fake app whose screens are just routes, driven only by
 * scripted steps. The first `expectFailures` expectText steps fail, and opening
 * `crashOn` throws the way a closed page or a navigation timeout does.
 */
function routeExecutor(options: { expectFailures?: number; crashOn?: string } = {}): PlatformExecutor {
  let route = '/';
  let expectFailures = options.expectFailures ?? 0;
  const here = () =>
    state({
      id: `state${route}`,
      route,
      location: `https://shop.example.com${route}`,
      text: `Demo shop content for ${route}`,
    });
  return {
    platform: 'web',
    name: 'stub',
    start: async () => undefined,
    observe: async () => here(),
    availableActions: async () => [],
    // Like the web executor, a replayed expectation is only a wait, and it succeeds.
    execute: async (action) => ({
      action,
      ok: true,
      durationMs: 0,
      stateBefore: here().id,
      stateAfter: here().id,
      noOp: false,
      observations: [],
    }),
    runScriptedStep: async (step) => {
      if (step.kind === 'goto' && step.value === options.crashOn) {
        throw new Error('Target page closed\nCall log:\n  - navigating');
      }
      const stateBefore = here().id;
      if (step.kind === 'goto') route = step.value ?? '/';
      const broken = step.kind === 'expectText' && expectFailures > 0;
      if (broken) expectFailures -= 1;
      return {
        action: {
          id: `${step.kind}${route}`,
          kind: step.kind === 'goto' ? 'navigate' : 'wait',
          value: step.value,
          description: step.kind === 'goto' ? `Open ${step.value}` : `Expect to see "${step.value}"`,
        },
        ok: !broken,
        error: broken ? `expected to see "${step.value}" but it was not on the page` : undefined,
        durationMs: 0,
        stateBefore,
        stateAfter: here().id,
        noOp: false,
        observations: [],
      };
    },
    captureEvidence: async () => [],
    drainObservations: () => [],
    reset: async () => {
      route = '/';
    },
    stop: async () => undefined,
  };
}

test('impact analysis maps changed files to areas and journeys', () => {
  const analysis = analyzeImpact(
    { base: 'main', head: 'pr', changedFiles: ['web/components/PaymentForm.tsx'] },
    config({
      impactMap: [
        {
          paths: ['web/components/Payment*'],
          area: 'Payments',
          journeys: ['checkout', 'refund'],
          confidence: 0.9,
        },
      ],
    }),
  );

  assert.equal(analysis.areas.length, 1);
  assert.equal(analysis.areas[0]?.area, 'Payments');
  assert.equal(analysis.broadened, false);
  assert.equal(missionsFromImpact(analysis, config()).length, 2);
});

test('unmapped changes lower confidence and broaden the scope', () => {
  const analysis = analyzeImpact(
    { base: 'main', head: 'pr', changedFiles: ['services/unknown/thing.ts'] },
    config(),
  );

  assert.equal(analysis.areas.length, 0);
  assert.equal(analysis.broadened, true);
  assert.ok(analysis.notes.some((note) => note.includes('not in the impact map')));
});

test('an empty diff never narrows testing to nothing', () => {
  const analysis = analyzeImpact({ base: 'main', head: 'pr', changedFiles: [] }, config());
  assert.equal(analysis.confidence, 0);
  assert.equal(analysis.broadened, true);
});

test('with free exploration off, low confidence says testing stays on the mapped journeys', () => {
  const unmapped = analyzeImpact(
    { base: 'main', head: 'pr', changedFiles: ['services/unknown/thing.ts'] },
    config({ freeExploration: false }),
  );
  // Broadening is free exploration, so there is nothing to broaden into.
  assert.equal(unmapped.broadened, false);
  assert.ok(unmapped.notes.some((note) => note.includes('free exploration is off, so nothing beyond')));

  const empty = analyzeImpact(
    { base: 'main', head: 'pr', changedFiles: [] },
    config({ freeExploration: false }),
  );
  assert.equal(empty.broadened, false);
  assert.ok(empty.notes.some((note) => note.includes('free exploration is off, so no journey is selected')));
});

test('identical findings merge into one defect instead of spamming the PR', () => {
  const repository = new DefectRepository();
  repository.add(finding(), steps, []);
  repository.add(finding({ id: 'f2' }), steps, []);

  assert.equal(repository.count, 1);
  assert.equal(repository.list()[0]?.occurrences, 2);
});

test('known false positives are suppressed', () => {
  const repository = new DefectRepository(['fp-1']);
  assert.equal(repository.add(finding(), steps, []), null);
  assert.equal(repository.count, 0);
  assert.equal(repository.suppressedCount, 1);
});

test('confidence rises when a defect reproduces and collapses when it does not', () => {
  const reproduced = new DefectRepository();
  reproduced.add(finding(), steps, []);
  reproduced.recordVerification('fp-1', true);

  const flaky = new DefectRepository();
  flaky.add(finding(), steps, []);
  flaky.recordVerification('fp-1', false);

  assert.equal(reproduced.list()[0]?.status, 'reproduced');
  assert.equal(flaky.list()[0]?.status, 'not-reproduced');
  assert.ok((reproduced.list()[0]?.confidence ?? 0) > (flaky.list()[0]?.confidence ?? 1));
});

test('only reproduced high-severity defects can block a merge', () => {
  const repository = new DefectRepository();
  repository.add(finding({ severity: 'critical' }), steps, []);
  const unverified = repository.list();
  assert.equal(recommend(unverified, config({ mode: 'blocking' })), 'review');

  repository.recordVerification('fp-1', true);
  assert.equal(recommend(repository.list(), config({ mode: 'blocking' })), 'block');
  // Advisory mode never blocks, whatever the agent found.
  assert.equal(recommend(repository.list(), config({ mode: 'advisory' })), 'review');
});

test('a clean run passes', () => {
  assert.equal(recommend([], config({ mode: 'blocking' })), 'pass');
});

test('a run whose every mission errored reports an error, not a pass', () => {
  const mission = (status: Mission['status']): Mission => ({
    id: `m-${status}`,
    name: `mission ${status}`,
    goal: 'exercise the fixture',
    rationale: 'test fixture',
    source: 'critical-journey',
    priority: 1,
    hints: [],
    maxSteps: 5,
    status,
  });

  // Nothing was tested, so an empty defect list proves nothing.
  assert.equal(
    recommend([], config({ mode: 'advisory' }), [mission('errored'), mission('errored')]),
    'error',
  );
  // One mission that got through is enough for the defects to mean something.
  assert.equal(
    recommend([], config({ mode: 'advisory' }), [mission('errored'), mission('completed')]),
    'pass',
  );
  // A run stopped by its budget has not errored.
  assert.equal(recommend([], config({ mode: 'advisory' }), [mission('skipped')]), 'pass');
  // A journey that broke did run: its reproduced defect decides, not an agent error.
  const broken = new DefectRepository();
  broken.add(finding({ oracle: 'critical-journey', severity: 'critical' }), steps, []);
  broken.recordVerification('fp-1', true);
  assert.equal(recommend(broken.list(), config({ mode: 'blocking' }), [mission('failed')]), 'block');
});

test('a failed login still produces an error summary instead of throwing', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const calls: string[] = [];
  const executor: PlatformExecutor = {
    platform: 'web',
    name: 'stub',
    start: async () => void calls.push('start'),
    observe: async () => state(),
    availableActions: async () => [],
    execute: async () => {
      throw new Error('no mission should run');
    },
    runScriptedStep: async () => ({
      action: { id: 'login', kind: 'click', description: 'Log in' },
      ok: false,
      error: 'selector not found',
      durationMs: 0,
      stateBefore: 'state-0',
      stateAfter: 'state-0',
      noOp: true,
      observations: [],
    }),
    captureEvidence: async (label) => {
      calls.push(`evidence:${label}`);
      return [];
    },
    drainObservations: () => [],
    reset: async () => undefined,
    stop: async () => void calls.push('stop'),
  };

  try {
    const agent = new ExplorationAgent({
      executor,
      config: config({
        auth: { steps: [{ kind: 'click', selector: '#login' }] },
        reporting: { outputDir, video: false, trace: false, har: false },
      }),
    });
    const summary = await agent.run();

    assert.equal(summary.recommendation, 'error');
    assert.match(summary.stoppedBecause, /^authentication failed: .*selector not found/);
    assert.ok(summary.missions.every((mission) => mission.status === 'skipped'));
    assert.deepEqual(calls, ['start', 'evidence:setup-failure', 'stop']);
    assert.match(toMarkdown(summary), /### Scope tested\n\nNo flows were tested\./);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('the report names each flow that ran and the routes it reached', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  try {
    const agent = new ExplorationAgent({
      executor: routeExecutor(),
      config: config({
        criticalJourneys: [
          {
            id: 'checkout',
            name: 'Checkout',
            script: [
              { kind: 'goto', value: '/checkout' },
              { kind: 'goto', value: '/confirmation' },
            ],
          },
          {
            id: 'browse',
            name: 'Browse products',
            script: [
              { kind: 'goto', value: '/products' },
              { kind: 'goto', value: '/cart' },
            ],
          },
        ],
        // The two scripts spend the whole budget, so the impact mission is skipped.
        limits: { ...config().limits, maxSteps: 4 },
        reporting: { outputDir, video: false, trace: false, har: false },
      }),
      missions: [
        {
          id: 'retry',
          name: 'Payments: payment retry',
          goal: '',
          rationale: '1 changed file(s) in Payments',
          source: 'impact-analysis',
          priority: 50,
          hints: [],
          maxSteps: 6,
          status: 'pending',
        },
      ],
    });
    const summary = await agent.run();

    // Checkout's leftover budget explored from the start page, so it reached "/" too.
    assert.deepEqual(
      summary.coverage.missions.map(({ id, routes }) => [id, routes]),
      [
        ['checkout', ['/checkout', '/confirmation', '/']],
        ['browse', ['/products', '/cart']],
        ['retry', []],
      ],
    );

    const markdown = toMarkdown(summary);
    const scope = markdown.slice(markdown.indexOf('### Scope tested'), markdown.indexOf('### Not tested'));
    assert.match(scope, /\| Checkout \| critical journey \| completed \| 2 \| `\/checkout`, `\/confirmation`, `\/` \|/);
    assert.match(scope, /\| Browse products \| critical journey \| completed \| 2 \| `\/products`, `\/cart` \|/);
    // A skipped mission is reported as not tested, never as scope.
    assert.doesNotMatch(scope, /payment retry/);
    assert.match(markdown, /### Not tested\n\n- Payments: payment retry — skipped \(step budget exhausted\)/);

    const html = toHtml(summary);
    assert.match(
      html,
      /<td>Browse products<\/td>\s*<td>critical journey<\/td>\s*<td>completed<\/td>\s*<td>2<\/td>\s*<td><code>\/products<\/code> <code>\/cart<\/code><\/td>/,
    );
    assert.match(html, /<h2>Not tested<\/h2>\s*<ul><li>Payments: payment retry — skipped \(step budget exhausted\)<\/li><\/ul>/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('with free exploration off, the selected missions keep their own budgets', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const impact = (id: string, priority: number): Mission => ({
    id,
    name: `Payments: ${id}`,
    goal: '',
    rationale: '1 changed file(s) in Payments',
    source: 'impact-analysis',
    priority,
    hints: [],
    maxSteps: 6,
    status: 'pending',
  });
  const run = (patch: Partial<AgentConfig>, missions: Mission[] = []) =>
    new ExplorationAgent({
      executor: routeExecutor(),
      config: config({ ...patch, reporting: { outputDir, video: false, trace: false, har: false } }),
      missions,
    }).run();
  const budgets = (summary: { missions: Mission[] }) =>
    summary.missions.map(({ id, maxSteps }) => [id, maxSteps]);

  try {
    const limits = { ...config().limits, maxSteps: 17 };
    const on = await run({ limits }, [impact('refund', 50), impact('retry', 60)]);
    assert.deepEqual(budgets(on), [['retry', 6], ['refund', 6], ['free-exploration', 5]]);

    // The 5 spare steps go unused: handed to the missions, they would wander into
    // areas the change did not touch.
    const off = await run({ limits, freeExploration: false }, [impact('refund', 50), impact('retry', 60)]);
    assert.deepEqual(budgets(off), [['retry', 6], ['refund', 6]]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('with free exploration off and nothing selected, the run tests nothing and says so', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const calls: string[] = [];
  const executor: PlatformExecutor = {
    ...routeExecutor(),
    start: async () => void calls.push('start'),
    stop: async () => void calls.push('stop'),
  };
  try {
    const noExploration = config({
      freeExploration: false,
      reporting: { outputDir, video: false, trace: false, har: false },
    });
    const summary = await new ExplorationAgent({
      executor,
      config: noExploration,
      impact: analyzeImpact({ base: 'main', head: 'pr', changedFiles: ['README.md'] }, noExploration),
    }).run();

    assert.equal(summary.recommendation, 'pass');
    assert.deepEqual(summary.missions, []);
    assert.equal(summary.stoppedBecause, 'nothing to test: no journey was selected and free exploration is off');
    // Nothing to test, so the app is never started, or logged in to.
    assert.deepEqual(calls, []);

    // A pass that tested nothing must not read like one that tested everything.
    const markdown = toMarkdown(summary);
    assert.match(markdown, /^## QA Agent Result: Nothing to test$/m);
    assert.match(markdown, /Nothing tested — no mission was selected/);
    assert.doesNotMatch(markdown, /Safe to merge/);
    // Which changed files the impact map missed is the reader's next question.
    assert.match(markdown, /### Why no journey was selected\n\n> 1 changed file\(s\) are not in the impact map: README\.md/);
    assert.match(toHtml(summary), /<span class="verdict">NOTHING TO TEST<\/span>/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('on a PR run, a critical journey runs only when the diff maps to it', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const prConfig = (patch: Partial<AgentConfig> = {}) =>
    config({
      freeExploration: false,
      criticalJourneys: [
        { id: 'checkout', name: 'Checkout', script: [{ kind: 'goto', value: '/checkout' }] },
        { id: 'browse', name: 'Browse products', script: [{ kind: 'goto', value: '/products' }] },
      ],
      // Lists the checkout journey by its id; the next test matches one by name.
      impactMap: [{ paths: ['web/checkout/**'], area: 'Checkout', journeys: ['checkout'], confidence: 0.9 }],
      reporting: { outputDir, video: false, trace: false, har: false },
      ...patch,
    });
  const run = (cfg: AgentConfig, diff?: string[]) =>
    new ExplorationAgent({
      executor: routeExecutor(),
      config: cfg,
      impact: diff ? analyzeImpact({ base: 'main', head: 'pr', changedFiles: diff }, cfg) : undefined,
    }).run();
  const ran = (summary: { missions: Mission[] }) => summary.missions.map((mission) => mission.id);

  try {
    const selective = await run(prConfig(), ['web/checkout/Form.tsx']);
    assert.deepEqual(ran(selective), ['checkout']);
    assert.equal(selective.missions[0]?.rationale, 'configured as a critical journey; the diff maps to it via Checkout');
    // The journey left out is named, so nobody assumes it ran.
    assert.ok(
      selective.impact?.notes.includes('Critical journeys run only when the diff maps to them; not run: Browse products.'),
    );

    const untouched = await run(prConfig(), ['README.md']);
    assert.deepEqual(ran(untouched), []);

    const always = await run(prConfig({ alwaysRunCriticalJourneys: true }), ['README.md']);
    assert.deepEqual(ran(always), ['checkout', 'browse']);
    assert.ok(!always.impact?.notes.some((note) => note.startsWith('Critical journeys run only')));

    // An exploratory session has no diff to select by, so every journey runs.
    const explore = await run(prConfig());
    assert.deepEqual(ran(explore), ['checkout', 'browse']);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an impacted journey that names a critical journey runs once, as the scripted journey', () => {
  const withCheckout = config({
    criticalJourneys: [{ id: 'checkout', name: 'Checkout' }],
    impactMap: [
      { paths: ['web/checkout/**'], area: 'Checkout', journeys: ['Checkout', 'payment retry'], confidence: 0.9 },
    ],
  });
  const analysis = analyzeImpact({ base: 'main', head: 'pr', changedFiles: ['web/checkout/Form.tsx'] }, withCheckout);

  assert.deepEqual(
    missionsFromImpact(analysis, withCheckout).map((mission) => mission.name),
    ['Checkout: payment retry'],
  );
});

test('a broken critical journey is verified by re-running its script', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const run = (expectFailures: number) =>
    new ExplorationAgent({
      executor: routeExecutor({ expectFailures }),
      config: config({
        criticalJourneys: [
          {
            id: 'checkout',
            name: 'Checkout',
            script: [
              { kind: 'goto', value: '/checkout' },
              { kind: 'expectText', value: 'Order confirmed' },
            ],
          },
        ],
        // No budget is left for exploration, so the broken journey is the only mission.
        limits: { ...config().limits, maxSteps: 8, verificationAttempts: 2 },
        reporting: { outputDir, video: false, trace: false, har: false },
        mode: 'blocking',
      }),
    }).run();

  try {
    // Broken every time: the replay breaks at the same step, so it may block.
    const broken = await run(Infinity);
    assert.equal(broken.missions[0]?.status, 'failed');
    assert.equal(broken.defects[0]?.status, 'reproduced');
    assert.equal(broken.recommendation, 'block');
    assert.match(toMarkdown(broken), /\| Checkout \| critical journey \| failed \| 2 \| `\/checkout` \|/);
    // Numbered 1, 2, 3 on GitHub, which would otherwise show a nested list as i, ii, iii.
    assert.match(
      toMarkdown(broken),
      /- \*\*Reproduction:\*\*\n  <ol type="1">\n  <li>Open \/checkout<\/li>\n  <li>Expect to see "Order confirmed"<\/li>\n  <\/ol>\n/,
    );

    // Broken once: the replays re-ran the script and it passed, so it is flaky.
    const flaky = await run(1);
    assert.equal(flaky.defects[0]?.status, 'not-reproduced');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a mission the agent could not run is errored and listed as not tested', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  const checkout: AgentConfig['criticalJourneys'][number] = {
    id: 'checkout',
    name: 'Checkout',
    script: [{ kind: 'goto', value: '/checkout' }],
  };
  const admin: AgentConfig['criticalJourneys'][number] = { id: 'admin', name: 'Admin', startUrl: '/admin' };
  const run = (criticalJourneys: AgentConfig['criticalJourneys']) =>
    new ExplorationAgent({
      executor: routeExecutor({ crashOn: '/admin' }),
      config: config({
        criticalJourneys,
        // No budget is left for exploration, so only the configured journeys run.
        limits: { ...config().limits, maxSteps: 8 },
        reporting: { outputDir, video: false, trace: false, har: false },
      }),
    }).run();

  try {
    const mixed = await run([checkout, admin]);
    assert.deepEqual(mixed.missions.map((mission) => mission.status), ['completed', 'errored']);
    // Only the first line of the error reaches the report.
    assert.equal(mixed.missions[1]?.error, 'Target page closed');
    assert.equal(mixed.recommendation, 'pass');
    const markdown = toMarkdown(mixed);
    assert.match(markdown, /1 completed · 0 failed · 1 errored · 0 skipped/);
    assert.doesNotMatch(
      markdown.slice(markdown.indexOf('### Scope tested'), markdown.indexOf('### Not tested')),
      /Admin/,
    );
    assert.match(markdown, /### Not tested\n\n- Admin — errored \(Target page closed\)/);

    const allErrored = await run([admin]);
    assert.equal(allErrored.recommendation, 'error');
    assert.equal(allErrored.stoppedBecause, 'every mission failed to execute (Admin: Target page closed)');
    assert.match(toMarkdown(allErrored), /### Scope tested\n\nNo flows were tested\./);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('safety policy blocks destructive and prohibited actions', () => {
  const policy = new SafetyPolicy(config());
  const click = (description: string): Action => ({ id: 'a', kind: 'click', description });

  assert.equal(policy.check(click('Click button "Delete account"')).allowed, false);
  assert.equal(policy.check(click('Click button "complete real payment"')).allowed, false);
  assert.equal(policy.check(click('Click button "Add to cart"')).allowed, true);
  assert.equal(policy.blockedActions().length, 2);
});

test('navigation outside the allowed hosts is blocked', () => {
  const policy = new SafetyPolicy(config());
  const navigate: Action = {
    id: 'a',
    kind: 'navigate',
    value: 'https://evil.example.net/',
    description: 'Open https://evil.example.net/',
  };
  assert.equal(policy.check(navigate).allowed, false);
  assert.equal(policy.hostAllowed('shop.example.com'), true);
});

test('secrets are redacted from evidence', () => {
  const policy = new SafetyPolicy(config());
  assert.equal(policy.redact('{"password": "hunter2"}'), '{"password": "***"}');
});

test('risk engine prefers mission-relevant, untried actions', () => {
  const memory = new StateMemory();
  const current = state();
  memory.observe(current);
  const risk = new RiskEngine(memory);

  const ranked = risk.rank(
    current,
    [
      { id: 'a1', kind: 'click', description: 'Click link "Privacy policy"' },
      { id: 'a2', kind: 'click', description: 'Click button "Place order"' },
    ],
    {
      id: 'checkout',
      name: 'Checkout',
      goal: '',
      rationale: '',
      source: 'critical-journey',
      priority: 1,
      hints: ['order'],
      maxSteps: 10,
      status: 'pending',
    },
  );

  assert.equal(ranked[0]?.action.id, 'a2');
  assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('mission hints')));
});

test('repeating an action is penalised so the agent does not loop', () => {
  const memory = new StateMemory();
  const current = state();
  memory.observe(current);
  const action: Action = { id: 'a1', kind: 'click', description: 'Click button "Next"' };
  const risk = new RiskEngine(memory);
  const before = risk.score(current, action).score;

  memory.record({
    action,
    ok: true,
    durationMs: 10,
    stateBefore: current.id,
    stateAfter: current.id,
    noOp: false,
    observations: [],
  });

  assert.ok(risk.score(current, action).score < before);
  assert.equal(memory.isKnownDeadEnd(current.id, action), true);
});

test('cumulative business rules fire on repeated successful requests', () => {
  const oracle = new InvariantOracle();
  const findings = oracle.evaluate(
    context({
      config: config({
        rules: [
          {
            id: 'single-order',
            description: 'An order must never be created twice',
            maxRequests: { method: 'POST', urlPattern: '/api/orders$', max: 1 },
            severity: 'critical',
          },
        ],
      }),
      requestLog: [
        { method: 'POST', url: 'https://shop.example.com/api/orders', status: 200, ok: true, at: 'now' },
        { method: 'POST', url: 'https://shop.example.com/api/orders', status: 200, ok: true, at: 'now' },
      ],
    }),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'critical');
});

test('forbidden text rules only apply on their configured route', () => {
  const oracle = new InvariantOracle();
  const rules = [
    {
      id: 'no-declined-order',
      description: 'A declined payment must not create an order',
      route: '/checkout',
      forbidText: 'Payment declined for order',
      severity: 'critical' as const,
    },
  ];
  const text = 'Payment declined for order 1001';

  assert.equal(
    oracle.evaluate(context({ config: config({ rules }), state: state({ text }) })).length,
    1,
  );
  assert.equal(
    oracle.evaluate(
      context({ config: config({ rules }), state: state({ route: '/cart', text }) }),
    ).length,
    0,
  );
});

test('console noise that only echoes a failed request is not a separate defect', () => {
  const oracle = new ConsoleErrorOracle();
  const observations = [
    {
      type: 'console' as const,
      severity: 'high' as const,
      message: 'Failed to load resource: the server responded with a status of 500',
      at: 'now',
    },
    {
      type: 'network' as const,
      severity: 'high' as const,
      message: 'GET /api/inventory -> 500',
      detail: { status: 500, url: '/api/inventory', method: 'GET' },
      at: 'now',
    },
  ];

  assert.equal(oracle.evaluate(context({ observations })).length, 0);
});

test('routes are masked so per-record pages collapse into one route', () => {
  assert.equal(maskRoute('https://shop.example.com/orders/1042'), '/orders/:id');
  assert.equal(maskRoute('https://shop.example.com/'), '/');
});
