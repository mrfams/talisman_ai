import {
  collectSources,
  extractUrls,
  searchQuery,
  searchWeb,
  type ResearchSource,
} from "../browser/research.js";
import { buildResearchReport, renderReportMarkdown, type Report } from "../documents/report.js";
import { renderReportPdf, verifyPdf } from "../documents/pdf.js";
import { slugify } from "../core/ids.js";
import type { StepContext, StepHandler } from "./engine.js";
import type { ChatMessage } from "../intelligence/types.js";

function findByShape(
  results: Record<number, unknown>,
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (const value of Object.values(results)) {
    if (value && typeof value === "object" && predicate(value as Record<string, unknown>)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function collectedSources(context: StepContext): ResearchSource[] {
  const found = findByShape(context.results, (value) => Array.isArray(value.sources));
  return (found?.sources as ResearchSource[] | undefined) ?? [];
}

function reportFrom(context: StepContext): Report | null {
  const found = findByShape(context.results, (value) => Array.isArray(value.sections));
  return (found as Report | null) ?? null;
}

function subjectOf(goal: string): string {
  const cleaned = goal
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Research report").slice(0, 160);
}

export const researchCollect: StepHandler = async (context) => {
  const inputUrls = Array.isArray(context.step.input?.urls)
    ? (context.step.input!.urls as string[])
    : [];
  let urls = [...new Set([...inputUrls, ...extractUrls(context.task.goal)])];
  const failures: Array<{ url: string; error: string }> = [];

  if (urls.length === 0) {
    if (!context.searchUrl) {
      throw new Error(
        "The request contains no URLs and no search provider is configured (TALISMAN_SEARCH_URL).",
      );
    }
    await context.report("log", "Searching the web", "Using the configured search provider");
    const results = await searchWeb(searchQuery(context.task.goal), context.searchUrl, {
      provider: context.searchProvider,
      apiKey: context.searchApiKey,
      signal: context.signal,
      limit: 5,
    });
    urls = results.map((result) => result.url);
    if (urls.length === 0) throw new Error("The search provider returned no results");
  }

  if (!context.browser) throw new Error("No browser is available to this worker");
  await context.report(
    "log",
    `Opening ${urls.length} source(s) with the ${context.browser.mode ?? "chromium"} reader`,
    urls.join(", "),
  );

  const collected = await collectSources(urls, context.browser, {
    signal: context.signal,
    maxSources: 4,
  });
  failures.push(...collected.failures);
  for (const source of collected.sources) {
    await context.report("step", `Read ${source.title}`, source.url, {
      characters: source.text.length,
    });
  }
  for (const failure of failures) {
    await context.report("log", "A source could not be read", `${failure.url}: ${failure.error}`);
  }
  if (collected.sources.length === 0) {
    throw new Error(
      `Could not read any source. ${failures.map((failure) => `${failure.url}: ${failure.error}`).join("; ")}`,
    );
  }
  return { sources: collected.sources, failures };
};

export const researchSynthesize: StepHandler = async (context) => {
  const sources = collectedSources(context);
  if (sources.length === 0) throw new Error("No evidence to synthesize");
  const collected = findByShape(context.results, (value) => Array.isArray(value.failures));
  const failures = (collected?.failures as Array<{ url: string; error: string }> | undefined) ?? [];
  const report = buildResearchReport({
    subject: subjectOf(context.task.goal),
    sources,
    failures,
  });
  if (context.workspace.writable) {
    await context.workspace.write("report.md", renderReportMarkdown(report));
  } else {
    await context.report(
      "log",
      "Workspace files are not persisted on this host",
      "The report is stored as a downloadable artifact instead.",
    );
  }
  await context.remember(
    "research",
    `${report.title}: compiled from ${report.sources.length} source(s) on ${report.generatedAt}.`,
  );
  await context.report("log", "Evidence synthesized", `${report.sections.length} sections`);
  return report;
};

export const documentRender: StepHandler = async (context) => {
  const report =
    reportFrom(context) ??
    buildResearchReport({
      subject: subjectOf(context.task.goal),
      sources: collectedSources(context),
    });
  const { bytes, pageCount } = await renderReportPdf(report);
  const name = `${slugify(report.title)}.pdf`;
  const artifact = await context.saveArtifact({
    name,
    mime: "application/pdf",
    bytes,
    metadata: { pageCount, sections: report.sections.length, sources: report.sources.length },
  });
  if (context.workspace.writable) await context.workspace.write(name, bytes);
  await context.report("artifact", "Document ready", name, {
    artifactId: artifact.id,
    pageCount,
  });
  return {
    artifactId: artifact.id,
    name,
    pageCount,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    title: report.title,
  };
};

export const verifyOutput: StepHandler = async (context) => {
  const rendered = findByShape(context.results, (value) => typeof value.artifactId === "string");
  if (!rendered?.artifactId) throw new Error("No document artifact was produced");
  const artifactId = String(rendered.artifactId);
  const artifact = await context.getArtifact(artifactId);
  const bytes = await context.readArtifact(artifactId);
  const verification = await verifyPdf(bytes);
  const report = reportFrom(context);

  const checks = [
    { name: "pdf-structure", ok: verification.ok, detail: verification.problems.join("; ") },
    { name: "page-count", ok: verification.pageCount >= 1, detail: String(verification.pageCount) },
    { name: "stored-hash-matches", ok: artifact.sha256 === verification.sha256, detail: artifact.sha256 },
    { name: "has-evidence", ok: (report?.sources.length ?? 0) > 0, detail: `${report?.sources.length ?? 0} sources` },
  ];
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(`Document verification failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  await context.report("log", "Document verified", `${verification.pageCount} pages, hash matches`);
  return {
    ok: true,
    artifactId,
    pageCount: verification.pageCount,
    sha256: verification.sha256,
    checks,
  };
};

export const llmAnswer: StepHandler = async (context) => {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are Talisman, a general-purpose personal assistant. Answer directly and cite nothing you did not verify.",
    },
    { role: "user", content: context.task.goal },
  ];
  const parts: string[] = [];
  try {
    for await (const event of context.models.stream({
      model: "",
      messages,
      signal: context.signal,
      maxTokens: 2000,
    })) {
      if (event.type === "text_delta") parts.push(event.text);
    }
  } catch (error) {
    throw new Error(
      `No model provider answered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = parts.join("").trim();
  if (!text) throw new Error("The model returned an empty answer");
  return { text };
};

export const defaultHandlers: Record<string, StepHandler> = {
  "research.collect": researchCollect,
  "research.synthesize": researchSynthesize,
  "document.render": documentRender,
  verify: verifyOutput,
  "llm.answer": llmAnswer,
};
