import type { SummaryPrompt } from './provider.js';

/**
 * A version string next to each prompt, not buried in a commit hash. Changing the wording of a
 * prompt changes the app's behaviour just as much as changing code does, so a reviewer should be
 * able to see it happen in a diff, and the audit log below can say which wording produced a given
 * answer instead of just "the AI said so".
 */
export const PREVISIT_PROMPT_VERSION = 'previsit-v1';

export function buildPrevisitPrompt(symptoms: string): SummaryPrompt {
  return {
    system:
      'You are a clinical triage assistant helping a doctor get ready for a visit. You never ' +
      'diagnose anything - you only summarise what the patient wrote and flag how urgent it looks. ' +
      'Reply with nothing but JSON, in exactly this shape: {"urgency": "low" | "medium" | "high", ' +
      '"chiefComplaint": string, "suggestedQuestions": array of short strings}. No text before or ' +
      'after the JSON, and no markdown code fences around it.',
    user:
      'Read these symptoms, written by the patient in their own words, and return the urgency, a ' +
      'one-line chief complaint, and a few questions the doctor might want to ask at the start of ' +
      `the visit.\n\nSymptoms: ${symptoms}`,
  };
}

export const POSTVISIT_PROMPT_VERSION = 'postvisit-v1';

export function buildPostvisitPrompt(doctorNotes: string): SummaryPrompt {
  return {
    system:
      "You turn a doctor's clinical notes into something a worried patient can actually read. Use " +
      'plain, calm, eighth-grade-level language, and never invent a medicine, dose, or instruction ' +
      "that is not already written in the notes - if the notes don't mention medication, just leave " +
      'it out rather than guessing. Reply with nothing but JSON, in exactly this shape: ' +
      '{"summary": string, "followUpSteps": array of short strings}. No text before or after the ' +
      'JSON, and no markdown code fences around it.',
    user:
      'Turn these clinical notes into a short, friendly summary and a list of follow-up steps for ' +
      `the patient.\n\nNotes: ${doctorNotes}`,
  };
}
