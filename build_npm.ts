import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: [
    "./src/mod.ts",
    {
      kind: "bin",
      name: "soundfont-split",
      path: "./cli.ts",
    },
  ],
  outDir: "./npm",
  shims: {
    deno: true,
  },
  package: {
    name: "@marmooo/soundfont-split",
    version: "0.0.1",
    description: "Split a SoundFont (SF2 / SF3) into per-preset SF3 files.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/marmooo/soundfont-split.git",
    },
    bugs: {
      url: "https://github.com/marmooo/soundfont-split/issues",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
