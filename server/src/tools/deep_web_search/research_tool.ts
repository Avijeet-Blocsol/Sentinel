import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { SentinelOperatorEnum } from '@sentinel/shared';
import { DeepResearchHarness } from '../../harness/deep_web_search/harness.js';
import {
  TargetDataKindEnum,
  PreferredDomainsPolicyEnum,
  type DeepResearchTask,
  type DeepResearchOutcome,
  type ResearchTelemetryEvent,
  type DeepResearchConfig,
} from '../../harness/deep_web_search/types.js';

/**
 * Creates a native Strands SDK tool wrapping the Deep Web Research Harness.
 */
export function createDeepResearchTool(config?: DeepResearchConfig) {
  const harness = new DeepResearchHarness(config);

  return tool({
    name: 'deep_web_research',
    description:
      'Autonomously discovers, inspects, and qualifies live web sources for Sentinel observation rules, synthesizing resilient CSS selectors.',
    inputSchema: z.object({
      query: z.string().describe('The monitoring target query'),
      targetDataKind: TargetDataKindEnum.describe('Classification of target metric'),
      expectedOperator: SentinelOperatorEnum.describe('Condition operator to monitor'),
      targetValue: z.union([z.string(), z.number()]).optional().describe('Threshold value if specified'),
      preferredDomains: z.array(z.string()).optional().describe('Optional list of preferred domains'),
      preferredDomainsPolicy: PreferredDomainsPolicyEnum.optional().describe('Policy: SOFT_PREFERENCE or STRICT_REQUIREMENT'),
      userConstraints: z.array(z.string()).optional().describe('Optional user exclusions and constraints (e.g. ["exclude ebay"])'),
    }),
    callback: async function* (
      input: {
        query: string;
        targetDataKind: DeepResearchTask['targetDataKind'];
        expectedOperator: DeepResearchTask['expectedOperator'];
        targetValue?: string | number;
        preferredDomains?: string[];
        preferredDomainsPolicy?: DeepResearchTask['preferredDomainsPolicy'];
        userConstraints?: string[];
      },
      context?: ToolContext
    ): AsyncGenerator<ResearchTelemetryEvent, DeepResearchOutcome, unknown> {
      const taskId = (context?.invocationState?.taskId as string) || `task-${Date.now()}`;
      const task: DeepResearchTask = {
        id: taskId,
        query: input.query,
        targetDataKind: input.targetDataKind,
        expectedOperator: input.expectedOperator,
        targetValue: input.targetValue,
        preferredDomains: input.preferredDomains,
        preferredDomainsPolicy: input.preferredDomainsPolicy,
        userConstraints: input.userConstraints,
      };

      const stream = harness.stream(task, { signal: context?.cancelSignal });
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }

      return next.value;
    },
  });
}
