import { Command } from "commander";
import {
  listDevices,
  getDeviceStatus,
  sendCommand,
  getDevicePositions,
  transferDevicePosition,
  seekDevicePosition,
} from "../commands/devices.ts";

export function registerDeviceCommands(program: Command): void {
  const device = program
    .command("device")
    .description("Manage Yoto devices");

  device
    .command("list")
    .description("List your Yoto devices")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ yoto device list
  $ yoto device list --json
`
    )
    .action((options) => listDevices({ json: options.json }));

  device
    .command("show <deviceId>")
    .description("Get device status (playback state, volume, battery)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  deviceId    The device ID (from 'yoto device list')

Examples:
  $ yoto device show Y12345678
  $ yoto device show Y12345678 --json
`
    )
    .action((deviceId, options) =>
      getDeviceStatus(deviceId, { json: options.json })
    );

  device
    .command("play <deviceId>")
    .description("Start/resume playback")
    .addHelpText(
      "after",
      `
Examples:
  $ yoto device play Y12345678
`
    )
    .action((deviceId) => sendCommand(deviceId, "play"));

  device
    .command("pause <deviceId>")
    .description("Pause playback")
    .addHelpText(
      "after",
      `
Examples:
  $ yoto device pause Y12345678
`
    )
    .action((deviceId) => sendCommand(deviceId, "pause"));

  device
    .command("stop <deviceId>")
    .description("Stop playback")
    .addHelpText(
      "after",
      `
Examples:
  $ yoto device stop Y12345678
`
    )
    .action((deviceId) => sendCommand(deviceId, "stop"));

  device
    .command("next <deviceId>")
    .description("Skip to next track")
    .addHelpText(
      "after",
      `
Examples:
  $ yoto device next Y12345678
`
    )
    .action((deviceId) => sendCommand(deviceId, "next"));

  device
    .command("previous <deviceId>")
    .description("Go to previous track")
    .addHelpText(
      "after",
      `
Examples:
  $ yoto device previous Y12345678
`
    )
    .action((deviceId) => sendCommand(deviceId, "previous"));

  device
    .command("volume <deviceId> <level>")
    .description("Set volume level (0-100)")
    .addHelpText(
      "after",
      `
Arguments:
  deviceId    The device ID
  level       Volume level (0-100)

Examples:
  $ yoto device volume Y12345678 50
  $ yoto device volume Y12345678 0
`
    )
    .action((deviceId, level) => sendCommand(deviceId, "volume", level));

  device
    .command("positions [cardId]")
    .description("Show where each device is (card, chapter, track, exact position)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  cardId    Optional playlist card ID; if given, only devices currently on
            that card are shown (others are omitted)

Requires the 'family:devices:control' scope — if this errors with an auth
or scope problem, run 'yoto login' again to pick it up.

Examples:
  $ yoto device positions
  $ yoto device positions 5ukMR
  $ yoto device positions --json
`
    )
    .action((cardId, options) => getDevicePositions(cardId, { json: options.json }));

  device
    .command("transfer <sourceDeviceId>")
    .description("Watch for another device to pick up the card a device is on, and jump it to the same position")
    .option("--to <deviceIds>", "Comma-separated candidate device IDs (default: all other devices)")
    .option("--timeout <seconds>", "How long to watch before giving up (default: 300)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  sourceDeviceId    The device currently playing the card to transfer

Yoto players are a single physical card moved between devices — only one
device is ever "on" a card at a time, so there's no moment where you could
just copy a position across. This instead captures the source device's
live position, then watches your other devices for that same card to
start (you physically move it there) and immediately jumps the receiving
device to the same chapter/track/second, instead of restarting from the
top.

Requires the 'family:devices:control' scope — if this errors with an auth
or scope problem, run 'yoto login' again to pick it up.

Examples:
  $ yoto device transfer Y1234
  $ yoto device transfer Y1234 --to Y5678
  $ yoto device transfer Y1234 --timeout 120
`
    )
    .action((sourceDeviceId, options) =>
      transferDevicePosition(sourceDeviceId, {
        to: options.to,
        timeout: options.timeout,
        json: options.json,
      })
    );

  device
    .command("seek <deviceId>")
    .description("Jump a device straight to a chapter/track and position")
    .option("--chapter <n>", "Chapter number (1-based); track numbers within it if given")
    .option(
      "--track <n>",
      "Track number (1-based). With no --chapter, counts across all chapters in order " +
        "(the common case: one track per chapter). With --chapter, counts within that chapter (default 1)"
    )
    .option("--seconds <n>", "Position in seconds from the start of the track (default 0)")
    .option("--from-end <n>", "Position in seconds before the end of the track")
    .option("--card <cardId>", "Card to seek on (default: whatever card the device is currently on)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  deviceId    The device ID (from 'yoto device list')

Exactly one of --seconds or --from-end sets the position; omit both to jump
to the start of the track (0s in).

The device confirms the command quickly, but takes longer to actually get
there — several seconds, more the deeper the target is into the track — so
'yoto device positions' may show the old position for a bit after this
returns.

Requires the 'family:devices:control' scope — if this errors with an auth
or scope problem, run 'yoto login' again to pick it up.

Examples:
  $ yoto device seek Y12345678 --track 7 --from-end 180
  $ yoto device seek Y12345678 --track 7 --seconds 30
  $ yoto device seek Y12345678 --chapter 2 --track 3 --seconds 0
  $ yoto device seek Y12345678 --track 1 --card 5ukMR
`
    )
    .action((deviceId, options) =>
      seekDevicePosition(deviceId, {
        chapter: options.chapter,
        track: options.track,
        seconds: options.seconds,
        fromEnd: options.fromEnd,
        card: options.card,
        json: options.json,
      })
    );
}
