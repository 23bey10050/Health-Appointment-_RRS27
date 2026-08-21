import type { AppConfig } from '../../config/env.js';
import { GeminiSummaryProvider } from '../../providers/gemini.js';
import { GroqSummaryProvider } from '../../providers/groq.js';

import type { SummaryProvider } from './provider.js';

/**
 * Builds the ordered provider chain from whichever AI accounts are actually configured.
 *
 * Groq goes first when present, since it is the one this project picked as primary. Either key,
 * both, or neither may be set - an empty list is a normal outcome and simply means the chain in
 * `chain.ts` skips straight to the deterministic template, the same as it does when both real
 * providers happen to fail.
 */
export function buildSummaryProviders(config: AppConfig): SummaryProvider[] {
  const providers: SummaryProvider[] = [];
  if (config.ai.groqApiKey) {
    providers.push(new GroqSummaryProvider(config.ai.groqApiKey));
  }
  if (config.ai.geminiApiKey) {
    providers.push(new GeminiSummaryProvider(config.ai.geminiApiKey));
  }
  return providers;
}
