import { splitSoundFont } from "./src/mod.ts";

const [inputPath, outDir, qualityArg, concurrencyArg] = Deno.args;

if (!inputPath || !outDir) {
  console.error(
    "usage: soundfont-split <input.sf2|sf3> <out_dir> [quality] [concurrency]",
  );
  console.error("");
  console.error(
    "Splits each preset into out_dir/{bank:03d}/{preset:03d}.sf3",
  );
  console.error(
    "  quality      — Vorbis VBR quality (−1..10), default 4",
  );
  console.error(
    "  concurrency  — max parallel sample encodes (global across presets).",
    "                 default: hardwareConcurrency or 4",
  );
  Deno.exit(1);
}

const results = await splitSoundFont(inputPath, outDir, {
  quality: qualityArg ? Number(qualityArg) : undefined,
  concurrency: concurrencyArg ? Number(concurrencyArg) : undefined,
});

console.log(`\ndone: ${results.length} preset(s) written under ${outDir}`);
