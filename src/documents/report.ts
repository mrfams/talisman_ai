export interface SourceDocument {
  url: string;
  title: string;
  text: string;
  description: string;
  fetchedAt: string;
}

export interface ReportSection {
  heading: string;
  paragraphs: string[];
  bullets: string[];
}

export interface Report {
  title: string;
  subtitle: string;
  generatedAt: string;
  sections: ReportSection[];
  sources: Array<{ title: string; url: string; accessedAt: string }>;
  limitations: string[];
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summarizeSource(source: SourceDocument): string[] {
  const paragraphs = source.text
    .split(/\n{2,}/)
    .map(clean)
    .filter((paragraph) => paragraph.length >= 80)
    .slice(0, 3);
  if (paragraphs.length > 0) return paragraphs.map((paragraph) => paragraph.slice(0, 900));
  const sentences = clean(source.text).split(SENTENCE_SPLIT).filter((s) => s.length > 40);
  if (sentences.length === 0) return [];
  return [sentences.slice(0, 4).join(" ").slice(0, 900)];
}

/**
 * Builds a document from evidence actually collected. Every section is traceable
 * to a fetched source; nothing is invented. An optional model-written summary can
 * be added by the caller, but the evidence sections stand on their own.
 */
export function buildResearchReport(input: {
  subject: string;
  sources: readonly SourceDocument[];
  generatedAt?: string;
  summary?: string;
  failures?: readonly { url: string; error: string }[];
}): Report {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sections: ReportSection[] = [];

  if (input.summary) {
    sections.push({
      heading: "Summary",
      paragraphs: [input.summary],
      bullets: [],
    });
  }

  for (const source of input.sources) {
    const paragraphs = summarizeSource(source);
    if (paragraphs.length === 0) continue;
    sections.push({
      heading: source.title || new URL(source.url).hostname,
      paragraphs,
      bullets: source.description ? [source.description.slice(0, 400)] : [],
    });
  }

  if (sections.length === 0) {
    sections.push({
      heading: "No readable evidence",
      paragraphs: [
        "No source produced readable text, so this document deliberately contains no findings.",
      ],
      bullets: [],
    });
  }

  const limitations = [
    ...(input.failures ?? []).map(
      (failure) => `Could not read ${failure.url}: ${failure.error}`,
    ),
  ];
  if (input.sources.length < 2) {
    limitations.push("Fewer than two sources were available; corroboration is limited.");
  }

  return {
    title: input.subject.slice(0, 160) || "Research report",
    subtitle: `A research brief compiled from ${input.sources.length} source${
      input.sources.length === 1 ? "" : "s"
    }`,
    generatedAt,
    sections,
    sources: input.sources.map((source) => ({
      title: source.title,
      url: source.url,
      accessedAt: source.fetchedAt,
    })),
    limitations,
  };
}

export function renderReportMarkdown(report: Report): string {
  const lines: string[] = [`# ${report.title}`, "", report.subtitle, ""];
  lines.push(`_Generated ${report.generatedAt} by Talisman_`, "");
  for (const section of report.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
    if (section.bullets.length) lines.push("");
    for (const paragraph of section.paragraphs) lines.push(paragraph, "");
  }
  if (report.limitations.length > 0) {
    lines.push("## Limitations", "");
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
    lines.push("");
  }
  lines.push("## Sources", "");
  report.sources.forEach((source, index) => {
    lines.push(`${index + 1}. [${source.title}](${source.url}) — accessed ${source.accessedAt}`);
  });
  return `${lines.join("\n")}\n`;
}
