import type { Mission, RunSummary } from '@qa-agent/shared-contracts';

export const SOURCE_LABEL: Record<Mission['source'], string> = {
  'critical-journey': 'critical journey',
  'impact-analysis': 'impact analysis',
  'ai-suggestion': 'AI suggestion',
  exploration: 'exploration',
};

export interface TestedFlow {
  mission: Mission;
  /** Actions the agent took inside this flow. */
  steps: number;
  /** Routes the flow reached, in the order first reached. */
  routes: string[];
}

/**
 * The flows the agent actually ran, with what each one covered. A skipped
 * mission is not scope: the reports list it under "Not tested" instead.
 */
export function testedFlows(summary: RunSummary): TestedFlow[] {
  const covered = new Map(summary.coverage.missions.map((entry) => [entry.id, entry]));
  return summary.missions
    .filter((mission) => mission.status === 'completed' || mission.status === 'failed')
    .map((mission) => ({
      mission,
      steps: covered.get(mission.id)?.steps ?? 0,
      routes: covered.get(mission.id)?.routes ?? [],
    }));
}
