import {
  AudioData,
  Bag,
  GeneratorList,
  Instrument,
  ModulatorList,
  parse,
  PresetHeader,
  RangeValue,
  SampleHeader,
  type SF3Decoder,
  type SF3Encoder,
  SoundFont,
  write,
} from "@marmooo/soundfont";
import { createDefaultEncoder } from "@marmooo/sf3-codec/encoder";
import { createDefaultDecoder } from "@marmooo/sf3-codec/decoder";

export interface SplitOptions {
  // Vorbis VBR quality [-1, 10]. Default 4.
  quality?: number;
  // Max concurrent sample encodes across the whole run (default:
  // navigator.hardwareConcurrency or 4). Also sizes the encoder worker pool.
  concurrency?: number;
  // If true (default), compress each preset to SF3 (Vorbis via
  // @marmooo/sf3-codec). If false, write SF2 (PCM) without encoding.
  toSf3?: boolean;
  // If true, samples that are already compressed (SF3 input) are decoded
  // and re-encoded at `quality` too, instead of being copied through as-is.
  // Costs extra time; off by default. Ignored when `toSf3` is false.
  recompress?: boolean;
}

export interface SplitResult {
  bank: number;
  preset: number;
  presetName: string;
  path: string;
  byteLength: number;
}

type DisposableEncoder = SF3Encoder & { dispose?: () => void };
type DisposableDecoder = SF3Decoder & { dispose?: () => void };

function cloneGenerator(g: GeneratorList): GeneratorList {
  if (g.value instanceof RangeValue) {
    return new GeneratorList(g.code, new RangeValue(g.value.lo, g.value.hi));
  }
  return new GeneratorList(g.code, g.value);
}

function cloneModulator(m: ModulatorList): ModulatorList {
  return new ModulatorList(
    m.sourceOper,
    m.destinationOper,
    m.amount,
    m.amountSourceOper,
    m.transOper,
  );
}

function isTerminalMod(m: ModulatorList): boolean {
  return (
    m.destinationOper === 0 &&
    m.amount === 0 &&
    m.transOper === 0 &&
    m.sourceOper.toValue() === 0 &&
    m.amountSourceOper.toValue() === 0
  );
}

function defaultConcurrency(): number {
  const nav = (globalThis as {
    navigator?: { hardwareConcurrency?: number };
  }).navigator;
  return nav?.hardwareConcurrency ?? 4;
}

// Collect sample IDs referenced by a preset (including stereo-linked
// partners). Uses only headers / zones / generators — does NOT touch the
// lazy `samples` array, so it never materializes AudioData.
function collectSampleIds(
  soundFont: SoundFont,
  presetHeaderIndex: number,
): number[] {
  const headers = soundFont.presetHeaders;
  if (
    presetHeaderIndex < 0 ||
    presetHeaderIndex >= headers.length ||
    headers[presetHeaderIndex].isEnd
  ) {
    throw new Error(`invalid presetHeaderIndex: ${presetHeaderIndex}`);
  }

  const ph = headers[presetHeaderIndex];
  const nextPh = headers[presetHeaderIndex + 1];
  const bagFrom = ph.presetBagIndex;
  const bagTo = nextPh
    ? nextPh.presetBagIndex
    : soundFont.presetZone.length - 1;

  const instrumentIdSet = new Set<number>();
  for (let zi = bagFrom; zi < bagTo; zi++) {
    const bag = soundFont.presetZone[zi];
    const nextBag = soundFont.presetZone[zi + 1];
    if (!nextBag) break;
    const gens = soundFont.presetGenerators.slice(
      bag.generatorIndex,
      nextBag.generatorIndex,
    );
    for (const g of gens) {
      if (g.type === "instrument" && typeof g.value === "number") {
        instrumentIdSet.add(g.value);
      }
    }
  }

  const sampleIdSet = new Set<number>();
  for (const oldInstId of instrumentIdSet) {
    const inst = soundFont.instruments[oldInstId];
    const nextInst = soundFont.instruments[oldInstId + 1];
    const iBagFrom = inst.instrumentBagIndex;
    const iBagTo = nextInst
      ? nextInst.instrumentBagIndex
      : soundFont.instrumentZone.length - 1;

    for (let zi = iBagFrom; zi < iBagTo; zi++) {
      const bag = soundFont.instrumentZone[zi];
      const nextBag = soundFont.instrumentZone[zi + 1];
      if (!nextBag) break;
      const gens = soundFont.instrumentGenerators.slice(
        bag.generatorIndex,
        nextBag.generatorIndex,
      );
      for (const g of gens) {
        if (g.type === "sampleID" && typeof g.value === "number") {
          const sh = soundFont.sampleHeaders[g.value];
          if (!sh || sh.isEnd) continue;
          sampleIdSet.add(g.value);
          const linked = soundFont.sampleHeaders[sh.sampleLink];
          if (sh.sampleLink !== 0 && linked && !linked.isEnd) {
            sampleIdSet.add(sh.sampleLink);
          }
        }
      }
    }
  }

  return [...sampleIdSet].filter((id) => {
    const sh = soundFont.sampleHeaders[id];
    return sh !== undefined && !sh.isEnd;
  });
}

// Extract a single preset (by index into soundFont.presetHeaders) into a
// minimal SoundFont that contains only the instruments and samples that
// preset depends on. Indices are remapped so the result is a valid
// standalone SF2/SF3.
export function extractPreset(
  soundFont: SoundFont,
  presetHeaderIndex: number,
): SoundFont {
  const headers = soundFont.presetHeaders;
  if (
    presetHeaderIndex < 0 ||
    presetHeaderIndex >= headers.length ||
    headers[presetHeaderIndex].isEnd
  ) {
    throw new Error(`invalid presetHeaderIndex: ${presetHeaderIndex}`);
  }

  const ph = headers[presetHeaderIndex];
  const nextPh = headers[presetHeaderIndex + 1];
  // Zones for this preset: bags [ph.presetBagIndex, nextBagIndex)
  // The terminal bag that bounds the last zone is not a zone itself.
  const bagFrom = ph.presetBagIndex;
  const bagTo = nextPh
    ? nextPh.presetBagIndex
    : soundFont.presetZone.length - 1;

  const instrumentIdSet = new Set<number>();
  const presetZoneSlice: Bag[] = [];
  const presetGenSlice: GeneratorList[] = [];
  const presetModSlice: ModulatorList[] = [];

  let genCursor = 0;
  let modCursor = 0;

  for (let zi = bagFrom; zi < bagTo; zi++) {
    const bag = soundFont.presetZone[zi];
    const nextBag = soundFont.presetZone[zi + 1];
    if (!nextBag) break;

    const gens = soundFont.presetGenerators
      .slice(bag.generatorIndex, nextBag.generatorIndex)
      .map(cloneGenerator);
    const mods = soundFont.presetModulators
      .slice(bag.modulatorIndex, nextBag.modulatorIndex)
      .map(cloneModulator);

    for (const g of gens) {
      if (g.type === "instrument" && typeof g.value === "number") {
        instrumentIdSet.add(g.value);
      }
    }

    presetZoneSlice.push(new Bag(genCursor, modCursor));
    presetGenSlice.push(...gens);
    presetModSlice.push(...mods);
    genCursor += gens.length;
    modCursor += mods.length;
  }

  // Terminal bag for preset zones
  presetZoneSlice.push(new Bag(genCursor, modCursor));
  if (
    presetModSlice.length === 0 ||
    !isTerminalMod(presetModSlice[presetModSlice.length - 1])
  ) {
    presetModSlice.push(ModulatorList.end());
  }
  if (
    presetGenSlice.length === 0 ||
    !presetGenSlice[presetGenSlice.length - 1].isEnd
  ) {
    presetGenSlice.push(GeneratorList.end());
  }

  const instrumentIds = [...instrumentIdSet].sort((a, b) => a - b);
  const instMap = new Map<number, number>();
  instrumentIds.forEach((id, i) => instMap.set(id, i));

  for (const g of presetGenSlice) {
    if (g.type === "instrument" && typeof g.value === "number") {
      const mapped = instMap.get(g.value);
      if (mapped === undefined) {
        throw new Error(`instrument ${g.value} not collected`);
      }
      g.value = mapped;
    }
  }

  const sampleIdSet = new Set<number>();
  const instruments: Instrument[] = [];
  const instrumentZone: Bag[] = [];
  const instrumentGenerators: GeneratorList[] = [];
  const instrumentModulators: ModulatorList[] = [];

  let iGenCursor = 0;
  let iModCursor = 0;

  for (const oldInstId of instrumentIds) {
    const inst = soundFont.instruments[oldInstId];
    const nextInst = soundFont.instruments[oldInstId + 1];
    const iBagFrom = inst.instrumentBagIndex;
    const iBagTo = nextInst
      ? nextInst.instrumentBagIndex
      : soundFont.instrumentZone.length - 1;

    const newInst = new Instrument();
    newInst.instrumentName = inst.instrumentName;
    newInst.instrumentBagIndex = instrumentZone.length;
    instruments.push(newInst);

    for (let zi = iBagFrom; zi < iBagTo; zi++) {
      const bag = soundFont.instrumentZone[zi];
      const nextBag = soundFont.instrumentZone[zi + 1];
      if (!nextBag) break;

      const gens = soundFont.instrumentGenerators
        .slice(bag.generatorIndex, nextBag.generatorIndex)
        .map(cloneGenerator);
      const mods = soundFont.instrumentModulators
        .slice(bag.modulatorIndex, nextBag.modulatorIndex)
        .map(cloneModulator);

      for (const g of gens) {
        if (g.type === "sampleID" && typeof g.value === "number") {
          const sh = soundFont.sampleHeaders[g.value];
          // Skip terminal / out-of-range sample IDs (can appear after
          // empty-name terminal records are stripped by the parser).
          if (!sh || sh.isEnd) continue;
          sampleIdSet.add(g.value);
          const linked = soundFont.sampleHeaders[sh.sampleLink];
          if (
            sh.sampleLink !== 0 &&
            linked &&
            !linked.isEnd
          ) {
            sampleIdSet.add(sh.sampleLink);
          }
        }
      }

      instrumentZone.push(new Bag(iGenCursor, iModCursor));
      instrumentGenerators.push(...gens);
      instrumentModulators.push(...mods);
      iGenCursor += gens.length;
      iModCursor += mods.length;
    }
  }

  instrumentZone.push(new Bag(iGenCursor, iModCursor));
  if (
    instrumentModulators.length === 0 ||
    !isTerminalMod(instrumentModulators[instrumentModulators.length - 1])
  ) {
    instrumentModulators.push(ModulatorList.end());
  }
  if (
    instrumentGenerators.length === 0 ||
    !instrumentGenerators[instrumentGenerators.length - 1].isEnd
  ) {
    instrumentGenerators.push(GeneratorList.end());
  }

  const sampleIds = [...sampleIdSet]
    .filter((id) => {
      const sh = soundFont.sampleHeaders[id];
      return sh !== undefined && !sh.isEnd;
    })
    .sort((a, b) => a - b);
  const sampleMap = new Map<number, number>();
  sampleIds.forEach((id, i) => sampleMap.set(id, i));

  for (const g of instrumentGenerators) {
    if (g.type === "sampleID" && typeof g.value === "number") {
      const mapped = sampleMap.get(g.value);
      if (mapped === undefined) {
        throw new Error(
          `sample ${g.value} not collected (missing or terminal header)`,
        );
      }
      g.value = mapped;
    }
  }

  const sampleHeaders: SampleHeader[] = [];
  const samples: AudioData[] = [];
  for (const oldId of sampleIds) {
    const sh = soundFont.sampleHeaders[oldId];
    const sample = soundFont.samples[oldId];
    if (!sh || !sample || sh.isEnd) continue;
    const newLink = sh.sampleLink !== 0 && sampleMap.has(sh.sampleLink)
      ? sampleMap.get(sh.sampleLink)!
      : 0;
    const newHeader = new SampleHeader(
      sh.sampleName,
      sh.start,
      sh.end,
      sh.loopStart,
      sh.loopEnd,
      sh.sampleRate,
      sh.originalPitch,
      sh.pitchCorrection,
      newLink,
      sh.sampleType,
    );
    sampleHeaders.push(newHeader);
    // Copy sample bytes into a standalone buffer so the extracted SoundFont
    // does not keep a view into the source file. After write() we can drop
    // these copies without waiting for the source soundFont to release.
    samples.push(
      new AudioData(sample.type, newHeader, sample.data.slice()),
    );
  }

  const newPh = new PresetHeader(
    ph.presetName,
    ph.preset,
    ph.bank,
    0,
    ph.library,
    ph.genre,
    ph.morphology,
  );

  return new SoundFont({
    presetHeaders: [newPh],
    presetZone: presetZoneSlice,
    presetModulators: presetModSlice,
    presetGenerators: presetGenSlice,
    instruments,
    instrumentZone,
    instrumentModulators,
    instrumentGenerators,
    sampleHeaders,
    samples,
    samplingData: soundFont.samplingData,
    info: soundFont.info,
  });
}

// Split every preset in the soundfont into its own file under outDir:
//   outDir/{bank:03d}/{preset:03d}.sf3
//
// Presets are processed in parallel. Sample encodes share a single encoder
// pool sized by `options.concurrency` (so the budget is global, not
// per-preset).
export async function splitSoundFont(
  input: Uint8Array | string,
  outDir: string,
  options: SplitOptions = {},
): Promise<SplitResult[]> {
  // Keep a mutable reference so we can drop the original file buffer after
  // all presets have been extracted (samples are lazy views into this buffer).
  let bytes: Uint8Array | null = typeof input === "string"
    ? Deno.readFileSync(input)
    : input;
  const soundFont = parse(bytes!);
  const toSf3 = options.toSf3 !== false;
  const concurrency = Math.max(
    1,
    options.concurrency ?? defaultConcurrency(),
  );

  await Deno.mkdir(outDir, { recursive: true });

  // Encoder/decoder pools. WASM heaps inside workers tend to grow and not
  // return memory to the OS, so we periodically dispose + recreate them
  // (see recycleCodecs below).
  let encode: DisposableEncoder | undefined;
  let decode: DisposableDecoder | undefined;
  const makeCodecs = () => {
    if (!toSf3) return;
    encode = createDefaultEncoder({
      quality: options.quality,
      poolSize: concurrency,
    });
    if (options.recompress) {
      decode = createDefaultDecoder({ poolSize: concurrency });
    }
  };
  const disposeCodecs = () => {
    encode?.dispose?.();
    decode?.dispose?.();
    encode = undefined;
    decode = undefined;
  };
  makeCodecs();

  // Recycle WASM worker pools every N finished presets to bound native/WASM
  // heap growth. 16 is a balance between recycle cost and memory creep.
  const RECYCLE_EVERY = 16;
  let finishedSinceRecycle = 0;

  try {
    const headers = soundFont.presetHeaders;
    const jobs: Array<{
      index: number;
      ph: PresetHeader;
      sampleIds: number[];
    }> = [];
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i].isEnd) {
        jobs.push({
          index: i,
          ph: headers[i],
          // Structure-only scan: does not materialize AudioData.
          sampleIds: collectSampleIds(soundFont, i),
        });
      }
    }

    // How many remaining presets still need each sample. When the count
    // hits 0 after a preset is written, we drop that slot from the source
    // soundFont so the lazy AudioData (and its view into the file buffer)
    // can be collected.
    const sampleRefCount = new Map<number, number>();
    for (const job of jobs) {
      for (const id of job.sampleIds) {
        sampleRefCount.set(id, (sampleRefCount.get(id) ?? 0) + 1);
      }
    }

    // Only one preset is assembled/written at a time. Sample encodes inside
    // write() still run up to `concurrency` in parallel. Parallel presets
    // multiplied peak memory (several full encoded SF3 buffers in flight)
    // and made WASM heap growth much worse; sequential presets keep the
    // high-water mark close to "source file + one preset's temps".
    const results: SplitResult[] = new Array(jobs.length);

    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
      const { index, ph, sampleIds } = jobs[jobIndex];

      const extracted = extractPreset(soundFont, index);
      const bankDir = `${outDir}/${String(ph.bank).padStart(3, "0")}`;
      await Deno.mkdir(bankDir, { recursive: true });
      const ext = toSf3 ? "sf3" : "sf2";
      const fileName = `${String(ph.preset).padStart(3, "0")}.${ext}`;
      const path = `${bankDir}/${fileName}`;

      const outBytes = toSf3
        ? await write(extracted, {
          encode: encode!,
          decode,
          concurrency,
        })
        : await write(extracted);

      Deno.writeFileSync(path, outBytes);
      const presetName = ph.presetName.replace(/\0+$/, "").trim();
      results[jobIndex] = {
        bank: ph.bank,
        preset: ph.preset,
        presetName,
        path,
        byteLength: outBytes.byteLength,
      };
      console.log(
        `wrote ${path} (${outBytes.byteLength} bytes) - ${presetName}`,
      );

      // Drop extracted copies (independent ArrayBuffers from extractPreset).
      for (const s of extracted.samples) {
        // Break any remaining internal refs early.
        (s as { data: Uint8Array }).data = new Uint8Array(0);
      }
      extracted.samples.length = 0;
      extracted.sampleHeaders.length = 0;

      // Release source samples that no remaining preset needs.
      for (const id of sampleIds) {
        const left = (sampleRefCount.get(id) ?? 1) - 1;
        if (left <= 0) {
          sampleRefCount.delete(id);
          const slot = soundFont.samples[id];
          if (slot) {
            // Detach the view into the source file buffer before dropping
            // the AudioData object.
            (slot as { data: Uint8Array }).data = new Uint8Array(0);
          }
          delete (soundFont.samples as unknown as Record<number, unknown>)[id];
        } else {
          sampleRefCount.set(id, left);
        }
      }

      finishedSinceRecycle++;
      if (toSf3 && finishedSinceRecycle >= RECYCLE_EVERY) {
        disposeCodecs();
        makeCodecs();
        finishedSinceRecycle = 0;
      }
    }

    // Safety net: clear anything left and drop the original file buffer.
    for (let i = 0; i < soundFont.samples.length; i++) {
      const s = soundFont.samples[i];
      if (s) (s as { data: Uint8Array }).data = new Uint8Array(0);
    }
    soundFont.samples.length = 0;
    soundFont.sampleHeaders.length = 0;
    bytes = null;

    return results;
  } finally {
    disposeCodecs();
  }
}
