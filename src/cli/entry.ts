import { Command } from "commander";
import {
  addEntry,
  updateEntry,
  deleteEntry,
} from "../commands/entry.ts";
import { error } from "../utils/output.ts";

export function registerEntryCommands(program: Command): void {
  const entry = program
    .command("entry")
    .description("Manage playlist entries (chapter + track as one unit)");

  entry
    .command("add <cardId> <title>")
    .description("Add a new entry (chapter with audio track) to a playlist")
    .option("--file <path>", "Audio file to upload (required)")
    .option("--icon <icon>", "Set icon (file path, mediaId, or yoto:#mediaId)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  cardId    The playlist card ID
  title     The entry title (used for both chapter and track)

The --icon option accepts file paths (auto-uploads) or existing IDs.

Examples:
  $ yoto entry add 5ukMR "Morning Song" --file ./song.mp3
  $ yoto entry add 5ukMR "Bedtime Story" --file ./story.mp3 --icon ./cover.png
`
    )
    .action((cardId, title, options) =>
      addEntry(cardId, title, { icon: options.icon, file: options.file, json: options.json })
    );

  entry
    .command("update <cardId> [entryIdx]")
    .description("Update an entry's title or icon (updates both chapter and track)")
    .option("--title <title>", "Update title")
    .option("--icon <icon>", "Update icon (file path, mediaId, displayIconId, or yoto:#mediaId)")
    .option("--all", "Apply to every entry in the playlist (omit entryIdx)")
    .addHelpText(
      "after",
      `
Arguments:
  cardId     The playlist card ID
  entryIdx   Entry index (0-based); omit when using --all

The --icon option accepts a file path (auto-uploads), a 43-character mediaId,
or a 24-character displayIconId. Find IDs with 'yoto icon list --search <term>'.

With --all, every entry is updated in a single write.

Examples:
  $ yoto entry update 5ukMR 0 --title "New Title"
  $ yoto entry update 5ukMR 1 --icon ./cover.png
  $ yoto entry update 5ukMR 2 --title "Updated" --icon ./new-icon.jpg
  $ yoto entry update 5ukMR --all --icon 652d155ced43a4d84797822e
`
    )
    .action((cardId, entryIdx, options) => {
      if (options.all) {
        if (entryIdx !== undefined) {
          error("Pass either an entryIdx or --all, not both.");
          process.exit(1);
        }
        return updateEntry(cardId, "all", {
          title: options.title,
          icon: options.icon,
        });
      }

      if (entryIdx === undefined) {
        error("Missing entryIdx. Pass an index, or --all for every entry.");
        process.exit(1);
      }

      const idx = parseInt(entryIdx, 10);
      if (Number.isNaN(idx)) {
        error(`Invalid entryIdx "${entryIdx}". Expected a 0-based number.`);
        process.exit(1);
      }

      return updateEntry(cardId, idx, {
        title: options.title,
        icon: options.icon,
      });
    });

  entry
    .command("delete <cardId> <entryIdx>")
    .description("Delete an entry from a playlist")
    .addHelpText(
      "after",
      `
Arguments:
  cardId     The playlist card ID
  entryIdx   Entry index (0-based)

Examples:
  $ yoto entry delete 5ukMR 2
`
    )
    .action((cardId, entryIdx) =>
      deleteEntry(cardId, parseInt(entryIdx, 10))
    );
}
