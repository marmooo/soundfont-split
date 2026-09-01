# @marmooo/soundfont-split

Split a SoundFont (SF2 / SF3) into per-preset SF3 files.

```
out_dir/
  000/000.sf3   # bank 0, program 0
  000/001.sf3
  ...
  128/000.sf3   # percussion (bank 128)
  ...
```

Each file contains only the instruments and samples required by that preset
(including stereo-linked samples). Indices are remapped so the result is a valid
standalone SF3.

## CLI

```bash
deno run -A cli.ts input.sf2 out_dir [bitsPerHz] [concurrency]
```

| Arg           | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| `input`       | Path to `.sf2` or `.sf3`                                                   |
| `out_dir`     | Output directory                                                           |
| `bitsPerHz`   | Vorbis quality: bitrate ≈ `sampleRate * bitsPerHz` (default `4`)           |
| `concurrency` | How many samples to encode in parallel (default: hardware concurrency / 4) |

## Installation

### Deno

```
deno install -fr -RW -g npm:@marmooo/soundfont-split --name soundfont-split
```

### Node

```
npm install @marmooo/soundfont-split -g
```

## As a function

```ts
import { parse } from "@marmooo/soundfont";
import { extractPreset, splitSoundFont } from "@marmooo/soundfont-split";

await splitSoundFont("input.sf2", "out_dir", { bitsPerHz: 4, concurrency: 4 });

const sf = parse(Deno.readFileSync("input.sf2"));
const one = extractPreset(sf, 0);
```

## License

MIT
