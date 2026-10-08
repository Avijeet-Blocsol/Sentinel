import { Agent } from '@strands-agents/sdk';
import { getAgentDefaultModel } from '../../agent/sentinel_agent.js';

/**
 * Resolves complex, indirect conversational entity descriptions to standard tickers
 * (e.g. "the company behind the iPhone" -> "AAPL", "the largest decentralized oracle" -> "LINK").
 *
 * Employs graceful degradation: If LLM credentials are absent or the model cannot
 * identify a high-confidence match, returns null rather than throwing.
 */
export async function resolveSemanticEntity(
  query: string,
  domain: 'STOCK' | 'CRYPTO',
  options?: number | { timeoutMs?: number; signal?: AbortSignal }
): Promise<string | null> {
  // If query is trivial or empty, skip
  if (!query || query.trim().length < 5) return null;

  const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 4000);
  const parentSignal = typeof options === 'object' ? options?.signal : undefined;
  if (parentSignal?.aborted) return null;

  // Check if LLM environment is available
  const hasMantle = !!process.env.AWS_BEDROCK_MANTLE_KEY;
  const hasBedrock = !!(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_REGION
  );
  if (!hasMantle && !hasBedrock) {
    return null;
  }

  try {
    const model = getAgentDefaultModel();
    const systemPrompt =
      domain === 'STOCK'
        ? 'You are a financial entity resolver for equity markets. Given a user query with indirect or descriptive phrasing (e.g. "the maker of iPhone", "Google parent company"), reply with ONLY the uppercase ticker symbol (e.g. "AAPL", "GOOGL"). If no specific publicly traded company can be identified with high confidence, reply with "NONE". Do not include explanations, punctuation, or formatting.'
        : 'You are a cryptocurrency entity resolver. Given a user query with indirect or descriptive phrasing (e.g. "the largest oracle token", "Ethereum layer 2 token by Arbitrum"), reply with ONLY the uppercase asset symbol (e.g. "LINK", "ARB"). If no specific crypto asset can be identified with high confidence, reply with "NONE". Do not include explanations, punctuation, or formatting.';

    const resolver = new Agent({
      model,
      systemPrompt,
    });

    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(new Error('Semantic resolution timeout')), timeoutMs);
    const combinedSignal = parentSignal
      ? AbortSignal.any([parentSignal, abortCtrl.signal])
      : abortCtrl.signal;

    let result: unknown = null;
    try {
      result = await Promise.race([
        resolver.invoke(`Identify entity for: "${query}"`, { cancelSignal: combinedSignal }),
        new Promise<null>((_, reject) => {
          if (combinedSignal.aborted) {
            reject(combinedSignal.reason || new Error('Semantic resolution aborted'));
            return;
          }
          combinedSignal.addEventListener(
            'abort',
            () => reject(combinedSignal.reason || new Error('Semantic resolution aborted')),
            { once: true }
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (!result || typeof result !== 'object') return null;

    // Extract text from AgentResult message
    const message = (result as any).message;
    const text: string =
      typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
        ? message.content.map((b: any) => b.text || '').join('')
        : '';

    const cleaned = Array.from(text.trim().toUpperCase())
      .filter((character) =>
        (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9')
      )
      .join('');
    if (cleaned === 'NONE' || cleaned.length < 1 || cleaned.length > 8) {
      return null;
    }

    return cleaned;
  } catch {
    // Semantic resolution failure is intentionally fail-closed.
    return null;
  }
}
