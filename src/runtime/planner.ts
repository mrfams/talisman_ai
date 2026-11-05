import type { TaskPlan } from "../core/types.js";
import { extractUrls } from "../browser/research.js";

const DOCUMENT_INTENT = /document|report|pdf|brief|write[- ]?up|memo|summary/i;
const RESEARCH_INTENT = /research|look up|lookup|find out|browse|investigate|compare|source|web/i;

/**
 * Deterministic planner. It maps the request to the specialist steps Talisman
 * can actually execute. An LLM planner can sit in front later; this stays as the
 * fallback so a task never depends on a model to be understood.
 */
export function planGoal(goal: string, options: { seedUrls?: string[] } = {}): TaskPlan {
  const urls = [...new Set([...(options.seedUrls ?? []), ...extractUrls(goal)])];
  const wantsDocument = DOCUMENT_INTENT.test(goal);
  const wantsResearch = urls.length > 0 || RESEARCH_INTENT.test(goal);
  const steps: TaskPlan["steps"] = [];

  if (wantsResearch) {
    steps.push({
      title: "Collect evidence in a real browser",
      kind: "research.collect",
      input: urls.length > 0 ? { urls } : {},
    });
    steps.push({ title: "Synthesize findings from the evidence", kind: "research.synthesize" });
    steps.push({ title: "Render the document", kind: "document.render" });
    steps.push({ title: "Verify the produced document", kind: "verify" });
  } else if (wantsDocument) {
    steps.push({ title: "Draft the document", kind: "llm.answer" });
    steps.push({ title: "Render the document", kind: "document.render" });
    steps.push({ title: "Verify the produced document", kind: "verify" });
  } else {
    steps.push({ title: "Answer the request", kind: "llm.answer" });
  }

  return { steps };
}
