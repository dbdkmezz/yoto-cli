---
name: transcribe-rename-audio-stories
description: Transcribe the opening of each audio file in a folder (using local whisper.cpp) to work out its story/track title, then rename the files accordingly. Use when the user has a folder of numbered/generic-named audio tracks (e.g. an audiobook or story compendium like "0001_SomeCollection.mp3") and wants them renamed to their actual story titles.
---

# Transcribe & rename audio story files

Given a folder of audio files with generic names (e.g. `0001_PuffinSleepyTales.mp3`,
`0002_PuffinSleepyTales.mp3`, ...), figure out each file's real story title by
transcribing its spoken intro locally with `whisper-cpp`, then rename the files to
those titles, keeping a numeric prefix for ordering.

## 0. Confirm the target folder

If the user didn't give an absolute path, ask for it (or confirm the one they
referenced). Always `ls` the folder first to see the actual filenames and confirm
they look like audio tracks needing this treatment.

## 1. Ensure tools are available

Check for the two dependencies and install anything missing via brew (these are
reversible, local installs — fine to do without extra confirmation):

```bash
which whisper-cli || brew install whisper-cpp
which ffmpeg || brew install ffmpeg
```

`whisper-cpp` ships without a model. Check for a cached model and download one if
missing (base.en is sufficient for clear narration/audiobook speech and is fast):

```bash
mkdir -p ~/.cache/whisper-models
MODEL="$HOME/.cache/whisper-models/ggml-base.en.bin"
[ -f "$MODEL" ] || curl -L -o "$MODEL" \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## 2. Extract short clips and transcribe

Whisper needs 16kHz mono WAV. Don't transcribe the whole file — just the opening,
where the title is normally spoken. Work in the session scratchpad, not the
source folder.

For each source file, extract the first 30 seconds:

```bash
ffmpeg -y -i "<source file>" -t 30 -ar 16000 -ac 1 -c:a pcm_s16le "<scratch>/<name>.wav" -loglevel error
```

Then transcribe:

```bash
whisper-cli -m "$MODEL" -f "<scratch>/<name>.wav" -nt --no-prints
```

Run this across all files (a simple shell loop is fine and fast enough not to need
parallelization for typical compendium sizes of 5-15 tracks).

## 3. Extract the title from each transcript

The story title is almost always the first thing spoken, often followed by
"read by ...". Watch for two situations:

- **A collection/brand intro precedes the title** (e.g. "Brought to you by
  Ladybird." with no story name yet at 30s). If the 30s clip only yields
  boilerplate/branding and no distinct title, re-extract a longer clip (e.g. 90s)
  for just that file and re-transcribe to find the actual title.
- **Author/reader credit is mixed in** (e.g. "Read by Ellie Hayden. The Winter
  Stones."). Pull out just the story title, not the collection name or narrator.

Use judgement to isolate the clean title text — strip narrator credits, "Puffin/
Ladybird Sleepy Tales" type series branding, and trailing partial sentences that
are the start of the story itself rather than the title.

## 4. Rename the files

Preserve the original numeric ordering (derive a two-digit index either from an
existing numeric prefix in the filename, or from natural file order if there
isn't one). Use the pattern:

```
NN - Story Title.mp3
```

Title-case the story title as spoken. Keep apostrophes (fine on macOS/most
filesystems). Preserve the original file extension. Use `mv -v` so the renames
are visible, and do this directly without asking for extra per-file confirmation
— renaming files in the user's own folder for exactly this stated purpose is the
expected, low-risk outcome of the task.

## 5. Report results

List old → new filenames briefly. Flag any file where the transcript was
ambiguous or the title extraction was a guess, so the user can spot-check it.

## Notes

- This is read-only on the audio content (clips are copies in scratch) and only
  renames — it never deletes or overwrites file content, so it's safe to redo if
  a title comes out wrong.
- If a folder has many more files than a typical 5-15 track compendium, still
  process them one by one — whisper-cli on a 30s base.en clip is fast (a few
  seconds), so this scales fine without needing a Workflow/subagent fan-out.
