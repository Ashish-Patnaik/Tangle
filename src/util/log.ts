const RESET = process.env.NO_COLOR === "1" || process.env.TERMINAL === "dumb";
const c = (code: string, s: string) => (RESET ? s : `\u001b[${code}m${s}\u001b[0m`);

export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);
export const red = (s: string) => c("31", s);
export const green = (s: string) => c("32", s);
export const yellow = (s: string) => c("33", s);
export const blue = (s: string) => c("34", s);
export const magenta = (s: string) => c("35", s);
export const cyan = (s: string) => c("36", s);

export const log = {
  info: (...a: unknown[]) => console.log(...a),
  step: (...a: unknown[]) => console.log(cyan("→"), ...a),
  ok: (...a: unknown[]) => console.log(green("✓"), ...a),
  warn: (...a: unknown[]) => console.log(yellow("!"), ...a),
  err: (...a: unknown[]) => console.error(red("✗"), ...a),
  plain: (...a: unknown[]) => console.log(...a),
  dim: (...a: unknown[]) => console.log(dim(String(a[0])), ...a.slice(1)),
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; raw: T; error: string | null }> {
  const started = process.hrtime.bigint();
  try {
    const raw = await fn();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms, raw, error: null };
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms, raw: undefined as T, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatMs(ms: number): string {
  return ms < 1 ? `${ms.toFixed(2)} ms` : ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;
}