/**
 * SF3 encoder that shells out to @marmooo/sf2-to-sf3's Vorbis worker.
 *
 * Mirrors upstream resolveWorkerPath: pick .ts or .js to match the resolved
 * module extension (source tree vs dnt/npm). Until upstream ships that fix
 * on npm, we keep this local copy so Deno + npm works.
 */
import type { SF3Encoder } from "@marmooo/soundfont";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface EncoderOptions {
  /** bitrate ≈ sampleRate * bitsPerHz. Default 4. */
  bitsPerHz?: number;
}

function isDenoRuntime(): boolean {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return typeof d !== "undefined" && typeof d.execPath === "function";
}

function resolveWorkerPath(): string {
  // Resolve relative to @marmooo/sf2-to-sf3's entry (mod.ts or mod.js).
  // Match that module's extension: source tree is .ts, dnt/npm output is .js.
  // Do not key off isDenoRuntime() alone — Deno loading the npm package
  // still needs .js.
  const modUrl = import.meta.resolve("@marmooo/sf2-to-sf3");
  const workerRel = modUrl.endsWith(".ts")
    ? "./_vorbis-worker.ts"
    : "./_vorbis-worker.js";
  const workerUrl = new URL(workerRel, modUrl);

  if (isDenoRuntime()) {
    // deno run accepts a file URL
    return workerUrl.href;
  }
  return fileURLToPath(workerUrl);
}

export function createSf3Encoder(
  options: EncoderOptions = {},
): SF3Encoder {
  const bitsPerHz = options.bitsPerHz ?? 4;
  const workerPath = resolveWorkerPath();
  // deno-lint-ignore no-explicit-any
  const cmd = isDenoRuntime()
    ? (globalThis as any).Deno.execPath()
    : process.execPath;

  return async function encode(pcm, sampleRate) {
    const args = isDenoRuntime()
      ? [
        "run",
        "--node-modules-dir=auto",
        "-A",
        workerPath,
        String(sampleRate),
        String(bitsPerHz),
      ]
      : [workerPath, String(sampleRate), String(bitsPerHz)];

    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    child.stdout!.on("data", (chunk: Uint8Array) => stdoutChunks.push(chunk));
    child.stderr!.on("data", (chunk: Uint8Array) => stderrChunks.push(chunk));

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    const pcmBytes = new Uint8Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength,
    );
    child.stdin!.write(pcmBytes);
    child.stdin!.end();

    const code = await exitPromise;

    if (stderrChunks.length > 0) {
      const err = concat(stderrChunks);
      if (isDenoRuntime()) {
        // deno-lint-ignore no-explicit-any
        (globalThis as any).Deno.stderr.writeSync(err);
      } else {
        process.stderr.write(err);
      }
    }
    if (code !== 0) {
      throw new Error(
        `vorbis encode subprocess failed (exit ${code}, worker=${workerPath})`,
      );
    }

    const stdout = concat(stdoutChunks);
    // first 4 bytes LE: actual sample rate (worker may resample)
    const actualSampleRate = new DataView(
      stdout.buffer,
      stdout.byteOffset,
      4,
    ).getUint32(0, true);
    return {
      data: stdout.subarray(4),
      sampleRate: actualSampleRate,
    };
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
