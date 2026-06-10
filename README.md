# audio-splicer

Windows tool for merging audio files into one, two ways:

1. **`splice concat`** — joins files end-to-end in order (optionally with a fixed gap).
2. **`splice random`** — splices files in random order to an exact target length, with
   randomized gaps and a per-file repeat cap.

ffmpeg/ffprobe ship inside `node_modules` (`ffmpeg-static`), so there is nothing to
install system-wide. Input can be any mix of `.ogg .oga .oog .mp3 .wav .flac .m4a .aac
.opus .wma .aiff .webm .mka`; the **output extension picks the output format**
(`.ogg .mp3 .wav .flac .m4a .aac .opus`), independent of the inputs.

## The app (no terminal needed)

Double-click **Audio Splicer** on the Desktop (or `Audio Splicer.vbs` in this folder).
A small app window opens: pick the folder with your audio files, pick where to save,
choose mode and options, hit **MAKE THE MIX**. The window shows the file pool with
durations, streams progress, then shows the timeline, the seed, a built-in player,
and a "show in folder" button.

App conveniences on top of the CLI behavior:

- Output defaults to a **`mixes` subfolder** next to your audio files, and outputs
  saved into the input folder are never re-ingested as source material on later runs.
- Existing mixes are never overwritten — reruns get `-2`, `-3`, … suffixes, so you can
  hit the button five times and get five disparate mixes side by side.
- Settings persist between sessions; the server exits itself after the window closes.

Internals: `app/server.mjs` (local-only HTTP on 127.0.0.1:8741, reuses the engine,
native folder dialogs via PowerShell) + `app/ui.html`, opened as an Edge app window.

## CLI setup

```
npm install
npm link        # makes `splice` available in any terminal
npm test        # generates tone fixtures and verifies all the rules below
```

## Sequential merge

```
splice concat C:\sounds -o merged.ogg
splice concat intro.wav middle.mp3 outro.ogg -o show.mp3 --gap 2
splice concat C:\sounds -o album.mp3 --crossfade 3 --normalize
```

A folder expands to its audio files sorted by name (numeric-aware, so `track2` sorts
before `track10`); explicitly listed files keep the order you typed. `--gap` and
`--crossfade` are mutually exclusive in this mode.

## Random fixed-length mix

```
splice random C:\sounds -o mix.ogg -l 9:00
splice random C:\sounds -o mix.mp3 -l 9m --max-gap 5
splice random C:\sounds -o mix.ogg -l 9:00 --seed 414226378   # reproduce a mix you liked
splice random C:\sounds -o mix.ogg -l 9:00 --dry-run          # plan only, no render
```

Rules implemented:

- **Repeat cap** — each file may appear at most `floor(targetLength / totalSourceLength) + 1`
  times (3 min of source mixed into 9 min → each file usable 4×).
- **Gaps** — silence between files is random, 0 to `--max-gap` (default 5 s). Whatever
  time can't be filled becomes silence at the **start and end** of the mix, which is
  where gaps longer than 5 s are allowed to live. Output length is sample-exact.

## Optional polish flags (both modes)

- **`--crossfade <sec>`** — equal-power fades instead of hard cuts. In concat mode,
  adjacent files overlap-blend by exactly that long (total shortens accordingly). In
  random mode every clip edge gets the fade and the joint between consecutive clips is
  drawn from `[-crossfade, max-gap]` — negative means the two clips overlap-blend,
  positive is silence as usual. Requires every file to be at least 2× the fade long.
- **`--normalize`** — two-pass loudness normalization: every unique file is measured
  with ffmpeg's `loudnorm`, then a static gain brings it to **−16 LUFS** (capped so
  true peak never exceeds −1.5 dB; effectively-silent files are left alone). Static
  gain means quiet recordings come up cleanly with no pumping. Per-file gains are
  printed before rendering.

### Novelty across runs

A mathematically "best" packing exists, but the tool deliberately never optimizes
toward it. Three mechanisms keep repeated runs disparate:

1. **Constructive randomness** — mixes are built by random draws (file choice, gap
   sizes, head/tail split), not by solving for best fit.
2. **Fresh seed per run** — printed every time; `--seed` replays an exact mix.
3. **History repulsion** — every render appends its sequence to `.splice-history.json`
   in the output folder. The next run generates `--candidates` (default 64) plans and
   keeps the one with the greatest edit distance from every previous mix, so runs
   actively avoid resembling their own past. `--no-history` or an explicit `--seed`
   bypasses this.

The chosen plan, per-file use counts, and novelty score print before rendering.

## Layout

- `app/server.mjs` + `app/ui.html` — the windowed app (`Audio Splicer.vbs` launches it)
- `bin/splice.mjs` — CLI (arg parsing, folder expansion, history, plan printout)
- `lib/engine.mjs` — pure plan math (cap, gaps, novelty distance) + ffmpeg render
- `tools/run-tests.mjs` — engine/CLI self-test: builds tone fixtures in three formats,
  renders both modes, checks cap/gap/length/novelty/reproducibility/pollution rules
- `tools/test-app.mjs` — app self-test: boots the server headless and drives the API
