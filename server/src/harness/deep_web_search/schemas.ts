import { z } from 'zod';
import { SourceCategoryEnum } from './types.js';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH — MODEL OUTPUT ZOD SCHEMAS
 * ==========================================================
 * Enforces strict runtime schema validation on all LLM responses:
 * - ResearchPlan
 * - CandidateSite[]
 * - Inspector Decision & Selectors
 * Rejects missing fields, invalid enums, out-of-bounds scores,
 * and malformed URLs.
 */

// ==========================================================
// 1. Planner Output Schema
// ==========================================================

export const SearchAngleSchema = z.object({
  query: z.string().min(2, 'Search angle query must be at least 2 characters'),
  rationale: z.string().min(3, 'Rationale must be at least 3 characters'),
  sourceCategory: SourceCategoryEnum,
});

export const ResearchPlanSchema = z.object({
  taskId: z.string().min(1, 'taskId must be non-empty'),
  searchAngles: z
    .array(SearchAngleSchema)
    .min(1, 'Research plan must contain at least one search angle')
    .max(6, 'Research plan cannot exceed 6 search angles'),
  qualificationCriteria: z
    .array(z.string().min(2))
    .min(1, 'Research plan must have at least one qualification criterion'),
});

// ==========================================================
// 2. Scout Output Schema
// ==========================================================

export const CandidateSiteSchema = z
  .object({
    url: z
      .string()
      .url('Candidate site URL must be a valid URL')
      .refine(
        (u) => u.startsWith('http://') || u.startsWith('https://'),
        'Candidate site URL must use HTTP or HTTPS protocol'
      ),
    domain: z.string().min(1, 'domain must be non-empty'),
    siteName: z.string().min(1, 'siteName must be non-empty'),
    title: z.string().default(''),
    snippet: z.string().default(''),
    sourceCategory: SourceCategoryEnum,
    snippetRelevanceScore: z
      .number()
      .min(0.0, 'Relevance score must be >= 0.0')
      .max(1.0, 'Relevance score must be <= 1.0'),
  })
  .refine(
    (item) => {
      try {
        const hostname = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
        const domain = item.domain.toLowerCase().replace(/^www\./, '');
        return hostname.includes(domain) || domain.includes(hostname);
      } catch {
        return false;
      }
    },
    {
      message: 'Candidate site URL hostname does not match domain property',
      path: ['domain'],
    }
  );

export const CandidateSitesArraySchema = z
  .array(CandidateSiteSchema)
  .min(1, 'Scout must return at least one candidate site');

// ==========================================================
// 3. Inspector Decision Schema
// ==========================================================

export const InspectorDecisionSchema = z.object({
  selector: z
    .string()
    .min(1, 'Proposed selector must be non-empty')
    .refine(
      (s) => !/^[0-9]/.test(s) && !s.includes('<') && !s.includes('>'),
      'Proposed selector contains invalid characters'
    ),
  fallbackSelectors: z.array(z.string().min(1)).optional().default([]),
  confidence: z
    .number()
    .min(0.0, 'Confidence score must be >= 0.0')
    .max(1.0, 'Confidence score must be <= 1.0'),
});

// ==========================================================
// 4. Scout Revectoring Schema
// ==========================================================

export const ScoutRevectorSchema = z.object({
  textualGradient: z.string().min(3, 'Gradient correction must be non-empty'),
  revectoredQuery: z.string().min(2, 'Revectored query must be at least 2 characters'),
  rationale: z.string().optional(),
});

// ==========================================================
// Helper: Validate and format model JSON
// ==========================================================

export function validateModelOutput<T>(
  schema: z.ZodType<T>,
  parsedJson: unknown,
  contextDescription: string
): { success: true; data: T } | { success: false; error: string; issues: z.ZodIssue[] } {
  const result = schema.safeParse(parsedJson);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const issueSummaries = result.error.issues
    .map((iss) => `[${iss.path.join('.') || 'root'}]: ${iss.message}`)
    .join('; ');

  return {
    success: false,
    error: `Model output schema validation failed for ${contextDescription}: ${issueSummaries}`,
    issues: result.error.issues,
  };
}
