export interface SummaryPrompt {
  system: string;
  user: string;
}

/**
 * The one shape both AI vendors have to fit through.
 *
 * An adapter's only job is turning a system/user prompt into raw text back from the model - it
 * does not parse that text as JSON or check its shape. That part happens once, in the chain that
 * calls these, so Groq and Gemini can never quietly disagree about what counts as a valid answer.
 */
export interface SummaryProvider {
  readonly name: string;
  complete(prompt: SummaryPrompt): Promise<string>;
}
