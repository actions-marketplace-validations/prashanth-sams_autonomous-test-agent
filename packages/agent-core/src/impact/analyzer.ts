import type { AgentConfig, ImpactAnalysis, ImpactedArea, Mission } from '@qa-agent/shared-contracts';
import { impactingArea, missionFromImpact, namesJourney } from '../missions';

export interface ImpactInput {
  base: string;
  head: string;
  changedFiles: string[];
}

/**
 * Turns a diff into testing missions, in the three layers the design calls for:
 *
 *  1. deterministic rules  — critical journeys the diff maps to, or all of them
 *                            with alwaysRunCriticalJourneys (handled by the agent)
 *  2. impact mapping       — configured path -> area -> journeys
 *  3. broadening           — low confidence widens scope instead of guessing,
 *                            only when freeExploration is on (it is opt-in)
 *
 * No AI is required for this step, which is what keeps scope selection auditable.
 */
export function analyzeImpact(input: ImpactInput, config: AgentConfig): ImpactAnalysis {
  const notes: string[] = [];
  const areas = new Map<string, ImpactedArea>();
  const unmapped: string[] = [];

  for (const file of input.changedFiles) {
    const entries = config.impactMap.filter((entry) =>
      entry.paths.some((pattern) => pathMatches(file, pattern)),
    );
    if (entries.length === 0) {
      unmapped.push(file);
      continue;
    }
    for (const entry of entries) {
      const existing = areas.get(entry.area);
      if (existing) {
        existing.changedPaths.push(file);
        existing.journeys = [...new Set([...existing.journeys, ...entry.journeys])];
        existing.confidence = Math.max(existing.confidence, entry.confidence);
      } else {
        areas.set(entry.area, {
          area: entry.area,
          confidence: entry.confidence,
          changedPaths: [file],
          journeys: [...entry.journeys],
          reason: `${file} maps to ${entry.area} via the configured impact map`,
        });
      }
    }
  }

  const mappedCount = input.changedFiles.length - unmapped.length;
  const coverageRatio = input.changedFiles.length === 0 ? 0 : mappedCount / input.changedFiles.length;
  const mappedConfidence = [...areas.values()].reduce((best, area) => Math.max(best, area.confidence), 0);
  let confidence = round(coverageRatio * 0.5 + mappedConfidence * 0.5);

  if (unmapped.length > 0) {
    notes.push(
      `${unmapped.length} changed file(s) are not in the impact map: ${unmapped.slice(0, 8).join(', ')}` +
        (unmapped.length > 8 ? ', …' : ''),
    );
  }
  if (!config.alwaysRunCriticalJourneys) {
    // A critical journey left out is scope the reader would otherwise assume ran.
    const notRun = config.criticalJourneys.filter((journey) => !impactingArea(journey, [...areas.values()]));
    if (notRun.length > 0) {
      notes.push(
        `Critical journeys run only when the diff maps to them; not run: ` +
          `${notRun.map((journey) => journey.name).join(', ')}.`,
      );
    }
  }
  if (input.changedFiles.length === 0) {
    notes.push(
      config.freeExploration
        ? 'No changed files were supplied; falling back to broad exploration.'
        : 'No changed files were supplied, and free exploration is off, so no journey is selected.',
    );
    confidence = 0;
  }

  // Low or unknown confidence widens the scope only when the config opted into
  // the free exploration that widening relies on; the notes say so either way.
  const lowConfidence = confidence < 0.6;
  const broadened = lowConfidence && config.freeExploration;
  if (lowConfidence) {
    notes.push(
      `Impact confidence ${Math.round(confidence * 100)}% is below the 60% threshold, ` +
        (broadened
          ? 'so exploration is broadened beyond the mapped areas.'
          : 'but free exploration is off, so nothing beyond the mapped journeys is tested.'),
    );
  }

  return {
    base: input.base,
    head: input.head,
    changedFiles: input.changedFiles,
    areas: [...areas.values()].sort((a, b) => b.confidence - a.confidence),
    confidence,
    broadened,
    notes,
  };
}

/** Missions implied by the analysis, budgeted against the run's step limit. */
export function missionsFromImpact(analysis: ImpactAnalysis, config: AgentConfig): Mission[] {
  // A journey that names a critical journey runs as that scripted mission; a
  // second, hint-only mission for it would only split the budget.
  const journeysOf = (area: ImpactedArea) =>
    area.journeys.filter((name) => !config.criticalJourneys.some((journey) => namesJourney(name, journey)));
  const journeyCount = analysis.areas.reduce((total, area) => total + journeysOf(area).length, 0);
  if (journeyCount === 0) return [];
  const perMission = Math.max(
    6,
    Math.floor((config.limits.maxSteps * (analysis.broadened ? 0.4 : 0.7)) / journeyCount),
  );

  return analysis.areas.flatMap((area) =>
    journeysOf(area).map((journey) =>
      missionFromImpact({
        area: area.area,
        journey,
        reason: `${area.changedPaths.length} changed file(s) in ${area.area}: ${area.changedPaths
          .slice(0, 3)
          .join(', ')}`,
        confidence: area.confidence,
        maxSteps: perMission,
      }),
    ),
  );
}

const GLOBSTAR = '__GLOBSTAR__';

function pathMatches(file: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(GLOBSTAR, 'g'), '.*');
  return new RegExp(`^${source}$`).test(file);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
