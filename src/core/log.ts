type Level = "debug" | "info" | "warn" | "error";

const levels: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (levels[level] < threshold) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
