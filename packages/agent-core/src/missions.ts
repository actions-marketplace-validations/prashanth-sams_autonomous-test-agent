import type { AgentConfig, ImpactAnalysis, ImpactedArea, Mission } from '@qa-agent/shared-contracts';
import { shortHash } from './util/hash';

type CriticalJourney = AgentConfig['criticalJourneys'][number];

/**
 * Layer 1 of the scope decision: the deterministic critical journeys. On a PR
 * run one runs only when the diff maps to it, unless the config opts into
 * running them all. Without an impact analysis, as in an exploratory session,
 * there is no diff to select by, so they all run.
 */
export function criticalJourneyMissions(config: AgentConfig, impact?: ImpactAnalysis): Mission[] {
  const selective = impact !== undefined && !config.alwaysRunCriticalJourneys;
  return config.criticalJourneys.flatMap((journey, index): Mission[] => {
    const area = selective ? impactingArea(journey, impact.areas) : undefined;
    if (selective && !area) return [];
    return [
      {
        id: journey.id,
        name: journey.name,
        goal: journey.goal ?? `Exercise the ${journey.name} journey end to end`,
        rationale: area
          ? `configured as a critical journey; the diff maps to it via ${area.area}`
          : 'configured as a critical journey; always runs',
        source: 'critical-journey',
        priority: 100 - index,
        startUrl: journey.startUrl,
        hints: journey.hints ?? deriveHints(journey.name),
        script: journey.script,
        maxSteps: Math.max(8, Math.floor(config.limits.maxSteps / 4)),
        status: 'pending',
      },
    ];
  });
}

/** The impacted area that lists this critical journey, by id or name. */
export function impactingArea(journey: CriticalJourney, areas: ImpactedArea[]): ImpactedArea | undefined {
  return areas.find((area) => area.journeys.some((name) => namesJourney(name, journey)));
}

/** Whether an impact-map journey name refers to this critical journey. */
export function namesJourney(name: string, journey: CriticalJourney): boolean {
  return [journey.id, journey.name].some((key) => normalize(key) === normalize(name));
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** The fallback mission: explore whatever budget is left, unguided. */
export function explorationMission(maxSteps: number): Mission {
  return {
    id: 'free-exploration',
    name: 'Free exploration',
    goal: 'Explore reachable application states and look for anomalies',
    rationale: 'remaining budget after targeted missions',
    source: 'exploration',
    priority: 1,
    hints: [],
    maxSteps,
    status: 'pending',
  };
}

export function missionFromImpact(params: {
  area: string;
  journey: string;
  reason: string;
  confidence: number;
  maxSteps: number;
}): Mission {
  return {
    id: `impact-${shortHash(`${params.area}:${params.journey}`, 6)}`,
    name: `${params.area}: ${params.journey}`,
    goal: `Verify the ${params.journey} journey still works after changes to ${params.area}`,
    rationale: params.reason,
    source: 'impact-analysis',
    priority: Math.round(50 + params.confidence * 40),
    hints: deriveHints(params.journey),
    maxSteps: params.maxSteps,
    status: 'pending',
  };
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'to', 'of', 'journey', 'flow', 'page']);

function deriveHints(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}
