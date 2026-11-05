import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Report } from "./report.js";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

/** pdf-lib's standard fonts are WinAnsi; keep text inside that repertoire. */
function pdfSafe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(text).split(/\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        // Break a very long token rather than letting it run off the page.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
          let cut = Math.floor((rest.length * maxWidth) / font.widthOfTextAtSize(rest, size));
          cut = Math.max(1, Math.min(rest.length - 1, cut));
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      } else {
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function renderReportPdf(
  report: Report,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const document = await PDFDocument.create();
  document.setTitle(pdfSafe(report.title));
  document.setAuthor("Talisman");
  document.setProducer("Talisman");
  document.setCreator("Talisman");
  document.setCreationDate(new Date(report.generatedAt));

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pages: PDFPage[] = [];
  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN;

  const ensure = (needed: number): void => {
    if (y - needed >= MARGIN + 20) return;
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN;
  };

  const draw = (
    text: string,
    options: { font: PDFFont; size: number; color?: ReturnType<typeof rgb>; gap?: number },
  ): void => {
    const lines = wrap(text, options.font, options.size, PAGE_WIDTH - MARGIN * 2);
    const lineHeight = options.size * 1.45;
    for (const line of lines) {
      ensure(lineHeight);
      if (line) {
        page.drawText(line, {
          x: MARGIN,
          y,
          size: options.size,
          font: options.font,
          color: options.color ?? rgb(0.12, 0.12, 0.14),
        });
      }
      y -= lineHeight;
    }
    y -= options.gap ?? 0;
  };

  draw(report.title, { font: bold, size: 24, gap: 6 });
  draw(report.subtitle, { font: regular, size: 11, color: rgb(0.35, 0.35, 0.4), gap: 4 });
  draw(`Generated ${report.generatedAt} by Talisman`, {
    font: regular,
    size: 9,
    color: rgb(0.45, 0.45, 0.5),
    gap: 18,
  });

  for (const section of report.sections) {
    draw(section.heading, { font: bold, size: 15, gap: 6 });
    for (const bullet of section.bullets) {
      draw(`- ${bullet}`, { font: regular, size: 9.5, color: rgb(0.35, 0.35, 0.4), gap: 2 });
    }
    for (const paragraph of section.paragraphs) {
      draw(paragraph, { font: regular, size: 10.5, gap: 8 });
    }
    y -= 6;
  }

  if (report.limitations.length > 0) {
    draw("Limitations", { font: bold, size: 13, gap: 6 });
    for (const limitation of report.limitations) {
      draw(`- ${limitation}`, { font: regular, size: 9.5, color: rgb(0.4, 0.3, 0.3), gap: 2 });
    }
    y -= 6;
  }

  draw("Sources", { font: bold, size: 13, gap: 6 });
  report.sources.forEach((source, index) => {
    draw(`${index + 1}. ${source.title}`, { font: bold, size: 9.5, gap: 1 });
    draw(`${source.url} (accessed ${source.accessedAt})`, {
      font: regular,
      size: 8.5,
      color: rgb(0.35, 0.35, 0.45),
      gap: 5,
    });
  });

  const total = pages.length;
  pages.forEach((entry, index) => {
    entry.drawText(`Talisman - page ${index + 1} of ${total}`, {
      x: MARGIN,
      y: 28,
      size: 8,
      font: regular,
      color: rgb(0.55, 0.55, 0.6),
    });
  });

  const bytes = await document.save();
  return { bytes, pageCount: total };
}

export interface PdfVerification {
  ok: boolean;
  pageCount: number;
  sizeBytes: number;
  sha256: string;
  problems: string[];
}

export async function verifyPdf(bytes: Uint8Array): Promise<PdfVerification> {
  const problems: string[] = [];
  const sizeBytes = bytes.byteLength;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let pageCount = 0;

  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (!head.startsWith("%PDF-")) problems.push("Missing PDF header");
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, sizeBytes - 1024)));
  if (!tail.includes("%%EOF")) problems.push("Missing PDF end marker");
  if (sizeBytes < 1000) problems.push("PDF is implausibly small");

  try {
    const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
    pageCount = parsed.getPageCount();
    if (pageCount < 1) problems.push("PDF has no pages");
    if (parsed.getTitle() === undefined) problems.push("PDF has no title metadata");
  } catch (error) {
    problems.push(`PDF failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ok: problems.length === 0, pageCount, sizeBytes, sha256, problems };
}
