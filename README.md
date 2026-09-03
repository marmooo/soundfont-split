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

## Installation

### Deno

```
deno install -fr -RW -g npm:@marmooo/soundfont-split --name soundfont-split
```

### Node

```
npm install @marmooo/soundfont-split -g
```

## Usage

```ts
import { parse } from "@marmooo/soundfont";
import { extractPreset, splitSoundFont } from "@marmooo/soundfont-split";

await splitSoundFont("input.sf2", "out_dir", { quality: 4, concurrency: 4 });

const sf = parse(Deno.readFileSync("input.sf2"));
const one = extractPreset(sf, 0);
```

## CLI

```
Usage: soundfont-split <input.sf2|sf3> <out_dir> [options]

Split a SoundFont (SF2 / SF3) into per-preset SF3 files.

out_dir/
  000/000.sf3  # bank 0, program 0
  000/001.sf3
  ...
  128/000.sf3  # percussion (bank 128)
  ...

Options:
  -V, --version      show version
  -q, --quality      Vorbis VBR quality ([-1, 10], default 4)
  -c, --concurrency  max parallel sample encodes (global across presets)
                     default: hardwareConcurrency or 4
  -h, --help         show this help
```

## License

MIT
