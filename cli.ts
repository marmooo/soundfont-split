#!/usr/bin/env -S deno run -A

import { splitSoundFont } from "./src/mod.ts";

const [inputPath, outDir, bitsPerHzArg, concurrencyArg] = Deno.args;

if (!inputPath || !outDir) {
  console.error(
    "usage: soundfont-split <input.sf2|sf3> <out_dir> [bitsPerHz] [concurrency]",
  );
  console.error("");
  console.error(
    "Splits each preset into out_dir/{bank:03d}/{preset:03d}.sf3",
  );
  console.error(
    "  bitsPerHz    — Vorbis quality (bitrate ≈ sampleRate * bitsPerHz), default 4",
  );
  console.error(
    "  concurrency  — max parallel sample encodes (global across presets).",
    "                 default: hardwareConcurrency or 4",
  );
  Deno.exit(1);
}

const results = await splitSoundFont(inputPath, outDir, {
  bitsPerHz: bitsPerHzArg ? Number(bitsPerHzArg) : undefined,
  concurrency: concurrencyArg ? Number(concurrencyArg) : undefined,
});

console.log(`\ndone: ${results.length} preset(s) written under ${outDir}`);
