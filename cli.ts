import { parseArgs } from "@std/cli";
import { splitSoundFont } from "./src/mod.ts";

const VERSION = "0.0.0";

const args = parseArgs(Deno.args, {
  string: ["quality", "concurrency"],
  boolean: ["version", "help"],
  alias: {
    q: "quality",
    c: "concurrency",
    V: "version",
    h: "help",
  },
});

const usage = `Usage: soundfont-split <input.sf2|sf3> <out_dir> [options]

Split a SoundFont (SF2 / SF3) into per-preset SF3 files.

out_dir/
  000/000.sf3  # bank 0, program 0
  000/001.sf3
  ...
  128/000.sf3  # percussion (bank 128)
  ...

Options:
  -V, --version      output the version number
  -q, --quality      Vorbis VBR quality ([-1, 10], default 4)
  -c, --concurrency  max parallel sample encodes (global across presets)
                       default: hardwareConcurrency or 4
  -h, --help         display help for command`;

if (args.version) {
  console.log(VERSION);
  Deno.exit(0);
}

if (args.help) {
  console.log(usage);
  Deno.exit(0);
}

const inputPath = args._[0] as string;
const outDir = args._[1] as string;

if (!inputPath || !outDir) {
  console.error(usage);
  Deno.exit(1);
}

const qualityArg = args.quality;
const concurrencyArg = args.concurrency;

const results = await splitSoundFont(inputPath, outDir, {
  quality: qualityArg ? Number(qualityArg) : undefined,
  concurrency: concurrencyArg ? Number(concurrencyArg) : undefined,
});

console.log(`\ndone: ${results.length} preset(s) written under ${outDir}`);
