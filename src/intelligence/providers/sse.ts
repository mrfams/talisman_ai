/** Incremental Server-Sent Events parser that works with fetch ReadableStreams. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseChunk(chunk);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const tail = parseChunk(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseChunk(chunk: string): { event: string | null; data: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export async function* jsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer.trim());
}
