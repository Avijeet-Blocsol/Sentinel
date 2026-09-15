/**
 * Strands Sentinel - Master Sentinel Agent
 * Autonomous conversational orchestrator built on AWS Strands Agents SDK.
 * Discovers monitoring targets via 7 reconnaissance tools and synthesizes structured Sentinel rules.
 */

import {
  Agent,
  BedrockModel,
  ConcurrentToolExecutor,
  SessionManager,
  type Model,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { usesAwsInfrastructure } from '../config/infrastructure_mode.js';
import {
  createStockResearchTool,
  createCryptoResearchTool,
  createPredictionMarketTool,
  createRssResearchTool,
  createIndicatorTool,
  createMarketQuoteTool,
  webSearchTool,
  createDeepResearchTool,
  createPreFlightProbeTool,
} from '../tools/index.js';

export const SENTINEL_AGENT_SYSTEM_PROMPT = `
You are Strands Sentinel, an intelligent autonomous surveillance and background decision assistant.
Your mission is to understand user monitoring intent, verify data sources live, and synthesize bulletproof Sentinel Rules.

===================================================================================
                       THE 9-STEP GOLDEN ONBOARDING LOOP
===================================================================================
1. User Input: Listen to user intent or questions.
2. Intent Steering & Confirmation Gate:
   - If the user asks off-topic BS (e.g. jokes, unrelated trivia), respond politely in one sentence and steer back to surveillance: "I specialize exclusively in autonomous monitoring and real-time intelligence. What asset or event would you like me to watch for you?"
   - Before launching scout tools, ALWAYS confirm the proposed query with the user:
     "Here is the surveillance monitor I will prepare:
      - Target: [Asset / URL / Market]
      - Condition: [Threshold / Criteria]
      - Audio Ringtone: [siren / chime / cash_register]
      Would you like to modify anything before I launch the scouts to verify live data?"
   - If the user wants modifications, adapt immediately.
   - Only when the user confirms (e.g. "looks good", "proceed", "yes", "go ahead") do you launch the scouts.
3. Scout Reconnaissance: Once confirmed, the intent is LOCKED. Dispatch specialized tools to locate canonical tickers, URLs, contracts, or feeds.
4. Pre-Flight Dry Run: ALWAYS invoke 'pre_flight_dry_run' to test the live source (HTTP 200, price quote, or DOM extract) and capture the initial baseline reading.
5. Schema Synthesis: Compile the unified Rule + Sub-Sentinel JSON block.
6. Visual Card: Present the verified configuration card with Baseline, Cadence, and Audio Tone.
7. Baseline Seeding & Scheduler: Once deployed by the user, the interactive setup turn ends and the scheduled evaluator pipeline monitors in the background. Evaluators may use an agentic LLM when semantic judgment is required.

When synthesizing the configuration, explicitly represent each independent watcher as a Sub-Sentinel. The resulting Sub-Sentinels must preserve the exact verified target, operator, threshold, cadence, and baseline. For multi-watcher logic, give every sub_sentinel a unique condition_key (for example A, B, C) and emit condition_tree with LEAF.subSentinelId set to that key; every watcher must appear in that tree. Example: {"type":"AND","children":[{"type":"OR","children":[{"type":"LEAF","subSentinelId":"A"},{"type":"LEAF","subSentinelId":"B"}]},{"type":"LEAF","subSentinelId":"C"}]}. The server replaces these local keys with durable IDs and rejects unknown, duplicate, or omitted keys. If no tree is needed, a multi-watcher rule must explicitly set combinator to AND or OR. Available reconnaissance tools include stock_research, crypto_research, prediction_market_research, rss_research, calculate_technical_indicator, get_market_quote, web_search, deep_web_research, and pre_flight_dry_run.

===================================================================================
                       POST-SCOUT STRICT INTERACTION RULES
===================================================================================
Once the scout phase begins, you only entertain 3 types of user messages:
1. Questions regarding the task: Analyze the current execution stack/progress and summarize clearly.
2. Interrupt handling: Process only confirmation or dismissal. The approved
   configuration is immutable; parameter changes require a new task after the
   current interrupt is resolved.
3. BS / Scope creep: If the user asks off-topic questions or attempts to alter the locked scope, immediately respond with a polite steering message:
   "This Sentinel Task is locked and currently in progress. To monitor a different asset or set up new conditions, please deploy or complete this task first."
`.trim();

/**
 * Instantiates the default model for Strands Sentinel.
 * Employs graceful fallback:
 * 1. Bedrock Mantle (if AWS_BEDROCK_MANTLE_KEY is set)
 * 2. OpenAI API (if OPENAI_API_KEY is set)
 * 3. AWS Bedrock Converse API (Claude 3.5 Haiku)
 */
export function getAgentDefaultModel(): Model {
  const provider = (process.env.SENTINEL_MODEL_PROVIDER || '').toLowerCase();
  if (usesAwsInfrastructure() && process.env.NODE_ENV === 'production' && provider !== 'bedrock') {
    throw new Error('Production requires SENTINEL_MODEL_PROVIDER=bedrock');
  }

  // Production configuration is authoritative: do not silently select an
  // OpenAI-compatible fallback just because another API key is present.
  if (provider === 'bedrock') {
    return new BedrockModel({
      modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-haiku-20241022-v1:0',
      clientConfig: {
        region: process.env.AWS_REGION || 'us-east-1',
      },
    });
  }

  const mantleKey = process.env.AWS_BEDROCK_MANTLE_KEY;
  if (mantleKey) {
    return new OpenAIModel({
      api: 'chat',
      modelId: process.env.BEDROCK_MANTLE_MODEL_ID || 'mistral.mistral-large-3-675b-instruct',
      apiKey: mantleKey,
      clientConfig: {
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
      },
    });
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIModel({
      api: 'chat',
      modelId: process.env.OPENAI_MODEL_ID || 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return new BedrockModel({
    modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-haiku-20241022-v1:0',
    clientConfig: {
      region: process.env.AWS_REGION || 'us-east-1',
    },
  });
}

export interface SentinelAgentOptions {
  model?: Model;
  sessionManager?: SessionManager;
  /**
   * Intent-drafting turns must not have access to reconnaissance tools.  The
   * conversation router is the authority for when tools become available.
   */
  enableTools?: boolean;
}

export class SentinelAgent {
  public readonly agent: Agent;

  constructor(options?: SentinelAgentOptions) {
    const model = options?.model || getAgentDefaultModel();

    const tools = [
      createStockResearchTool(),
      createCryptoResearchTool(),
      createPredictionMarketTool(),
      createRssResearchTool(),
      createIndicatorTool(),
      createMarketQuoteTool(),
      webSearchTool,
      createDeepResearchTool(),
      createPreFlightProbeTool(),
    ];

    const enabledTools = options?.enableTools === false ? [] : tools;

    this.agent = new Agent({
      model,
      systemPrompt: SENTINEL_AGENT_SYSTEM_PROMPT,
      tools: enabledTools,
      toolExecutor: enabledTools.length > 0 ? new ConcurrentToolExecutor() : undefined,
      plugins: options?.sessionManager ? [options.sessionManager] : [],
    });
  }
}
