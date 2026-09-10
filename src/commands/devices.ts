import { getAuthenticatedClient } from "./auth.ts";
import { info, table, json, success, error } from "../utils/output.ts";
import { getDevicePlaybackState, watchForCardTransfer, seekDevice } from "../api/mqtt.ts";
import { hasCard, type Chapter, type Device, type DeviceEvent } from "../api/schemas.ts";

function formatDuration(seconds: number): string {
  // Round the total first — rounding the remainder alone can print "0:60".
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

// eventUtc is Unix seconds (confirmed against a real device), not ms/ISO.
function ageSeconds(eventUtc: number | undefined): number | null {
  if (eventUtc === undefined) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - eventUtc));
}

function formatAge(eventUtc: number | undefined): string {
  const seconds = ageSeconds(eventUtc);
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function formatPosition(state: DeviceEvent | null): string {
  if (!state || state.position === undefined) return "-";
  if (state.trackLength !== undefined) {
    return `${formatDuration(state.position)} / ${formatDuration(state.trackLength)}`;
  }
  return formatDuration(state.position);
}

function formatStatus(device: Device, state: DeviceEvent | null): string {
  if (state?.playbackStatus) return state.playbackStatus;
  if (device.online === false) return "offline";
  return state ? "idle" : "no response";
}

export async function listDevices(options: { json?: boolean }): Promise<void> {
  const client = await getAuthenticatedClient();
  const response = await client.getDevices();

  if (options.json) {
    json(response.devices);
    return;
  }

  if (response.devices.length === 0) {
    info("No devices found.");
    return;
  }

  table(
    ["Name", "Device ID", "Type", "Online"],
    response.devices.map((device) => [
      device.name,
      device.deviceId,
      device.deviceType || "-",
      device.online ? "Yes" : "No",
    ])
  );
}

export async function getDeviceStatus(
  deviceId: string,
  options: { json?: boolean }
): Promise<void> {
  const client = await getAuthenticatedClient();
  const status = await client.getDeviceStatus(deviceId);

  if (options.json) {
    json(status);
    return;
  }

  console.log(`\nDevice Status: ${deviceId}`);
  if (status.playerStatus) console.log(`  Status: ${status.playerStatus}`);
  if (status.cardId) console.log(`  Playing Card: ${status.cardId}`);
  if (status.chapterKey) console.log(`  Chapter: ${status.chapterKey}`);
  if (status.trackKey) console.log(`  Track: ${status.trackKey}`);
  if (status.volume !== undefined) console.log(`  Volume: ${status.volume}%`);
  if (status.batteryLevel !== undefined)
    console.log(`  Battery: ${status.batteryLevel}%`);
}

export async function sendCommand(
  deviceId: string,
  command: string,
  value?: string
): Promise<void> {
  const client = await getAuthenticatedClient();

  const commandMap: Record<string, Record<string, unknown>> = {
    play: { command: "play" },
    pause: { command: "pause" },
    stop: { command: "stop" },
    next: { command: "next" },
    previous: { command: "previous" },
    volume: { command: "volume", value: parseInt(value || "50", 10) },
  };

  const cmd = commandMap[command.toLowerCase()];
  if (!cmd) {
    console.error(
      `Unknown command: ${command}. Available: play, pause, stop, next, previous, volume`
    );
    process.exit(1);
  }

  await client.sendDeviceCommand(deviceId, cmd);
  success(`Sent ${command} command to device`);
}

export async function getDevicePositions(
  cardId: string | undefined,
  options: { json?: boolean }
): Promise<void> {
  const client = await getAuthenticatedClient();
  const accessToken = client.getTokens().accessToken;
  if (!accessToken) {
    error("Not authenticated. Please login first.");
    process.exit(1);
  }

  const [{ devices }, cardTitles] = await Promise.all([
    client.getDevices(),
    client
      .listContent()
      .then((res) => new Map(res.cards.map((c) => [c.cardId, c.title])))
      .catch(() => new Map<string, string>()),
  ]);

  const results = await Promise.allSettled(
    devices.map((device) => getDevicePlaybackState(device.deviceId, accessToken))
  );

  const rows = devices.map((device, i) => {
    const result = results[i];
    const state = result !== undefined && result.status === "fulfilled" ? result.value : null;
    return { device, state };
  });

  const filtered = cardId ? rows.filter((r) => hasCard(r.state) && r.state.cardId === cardId) : rows;

  if (options.json) {
    json(
      filtered.map(({ device, state }) => ({
        deviceId: device.deviceId,
        name: device.name,
        cardId: hasCard(state) ? state.cardId : undefined,
        cardTitle: hasCard(state) ? cardTitles.get(state.cardId) : undefined,
        chapterKey: state?.chapterKey,
        trackKey: state?.trackKey,
        position: state?.position,
        trackLength: state?.trackLength,
        playbackStatus: state?.playbackStatus,
        eventUtc: state?.eventUtc,
      }))
    );
    return;
  }

  if (filtered.length === 0) {
    info(cardId ? `No devices are currently on card ${cardId}.` : "No devices found.");
    return;
  }

  if (cardId) {
    table(
      ["Device", "Chapter", "Track", "Position", "Status", "Updated"],
      filtered.map(({ device, state }) => [
        device.name,
        state?.chapterKey ?? "-",
        state?.trackKey ?? "-",
        formatPosition(state),
        formatStatus(device, state),
        formatAge(state?.eventUtc),
      ])
    );
    return;
  }

  table(
    ["Device", "Card", "Chapter", "Track", "Position", "Status", "Updated"],
    filtered.map(({ device, state }) => {
      const card = hasCard(state)
        ? `${state.cardId}${cardTitles.has(state.cardId) ? ` ${cardTitles.get(state.cardId)}` : ""}`
        : "-";
      return [
        device.name,
        card,
        state?.chapterKey ?? "-",
        state?.trackKey ?? "-",
        formatPosition(state),
        formatStatus(device, state),
        formatAge(state?.eventUtc),
      ];
    })
  );
}

const DEFAULT_TRANSFER_TIMEOUT_SECONDS = 300;

export async function transferDevicePosition(
  sourceDeviceId: string,
  options: { to?: string; timeout?: string; json?: boolean }
): Promise<void> {
  const client = await getAuthenticatedClient();
  const accessToken = client.getTokens().accessToken;
  if (!accessToken) {
    error("Not authenticated. Please login first.");
    process.exit(1);
  }

  const [{ devices }, cardTitles] = await Promise.all([
    client.getDevices(),
    client
      .listContent()
      .then((res) => new Map(res.cards.map((c) => [c.cardId, c.title])))
      .catch(() => new Map<string, string>()),
  ]);

  const source = devices.find((d) => d.deviceId === sourceDeviceId);
  if (!source) {
    error(`Device ${sourceDeviceId} not found. Run 'yoto device list'.`);
    process.exit(1);
  }

  const sourceState = await getDevicePlaybackState(sourceDeviceId, accessToken);
  if (!hasCard(sourceState)) {
    error(`${source.name} isn't currently on a card — nothing to transfer.`);
    process.exit(1);
  }

  const candidateIds = options.to
    ? options.to.split(",").map((id) => id.trim()).filter(Boolean)
    : devices.filter((d) => d.deviceId !== sourceDeviceId).map((d) => d.deviceId);

  const candidates: Device[] = [];
  for (const id of candidateIds) {
    const device = devices.find((d) => d.deviceId === id);
    if (!device) {
      error(`Device ${id} not found. Run 'yoto device list'.`);
      process.exit(1);
    }
    if (device.deviceId === sourceDeviceId) continue; // --to may list the source itself; skip watching itself
    candidates.push(device);
  }

  if (candidates.length === 0) {
    info("No candidate devices to watch.");
    return;
  }

  const timeoutSeconds =
    parsePositiveIntOption(options.timeout, "--timeout") ?? DEFAULT_TRANSFER_TIMEOUT_SECONDS;

  const cardLabel = cardTitles.get(sourceState.cardId)
    ? `"${cardTitles.get(sourceState.cardId)}"`
    : sourceState.cardId;

  info(`Watching for ${cardLabel} to start on: ${candidates.map((c) => c.name).join(", ")}.`);
  info(`Move the card now — waiting up to ${timeoutSeconds}s. Ctrl+C to cancel.`);

  const outcome = await watchForCardTransfer(
    sourceDeviceId,
    sourceState,
    candidates.map((c) => c.deviceId),
    accessToken,
    timeoutSeconds * 1000
  );

  if (!outcome) {
    if (options.json) {
      json({ ok: false, reason: "timeout" });
      return;
    }
    error(`Timed out after ${timeoutSeconds}s — no device picked up the card.`);
    process.exit(1);
  }

  const target = candidates.find((c) => c.deviceId === outcome.deviceId);
  const targetName = target?.name ?? outcome.deviceId;

  if (options.json) {
    json({
      ok: true,
      deviceId: outcome.deviceId,
      name: targetName,
      chapterKey: outcome.chapterKey,
      trackKey: outcome.trackKey,
      secondsIn: outcome.secondsIn,
    });
    return;
  }

  success(
    `${targetName} picked up the card — jumped to ` +
      `ch${outcome.chapterKey ?? "?"}/tr${outcome.trackKey ?? "?"} @${formatDuration(outcome.secondsIn)}`
  );
}

interface SeekTarget {
  chapterKey: string;
  trackKey: string;
  chapterTitle: string;
  trackTitle: string;
  duration: number | null;
}

// "Track N" for a Yoto card almost always means the Nth chapter (most cards
// are one track per chapter) — so with no --chapter given, N indexes the
// tracks of every chapter flattened in order, not just the first chapter's.
// --chapter narrows that to one chapter, and --track then indexes within it.
function resolveSeekTarget(
  chapters: Chapter[],
  options: { chapter?: number; track?: number }
): SeekTarget {
  if (chapters.length === 0) {
    throw new Error("This card has no chapters.");
  }

  if (options.chapter !== undefined) {
    const chapter = chapters[options.chapter - 1];
    if (!chapter) {
      throw new Error(
        `Chapter ${options.chapter} doesn't exist — this card has ${chapters.length} chapter(s).`
      );
    }
    const trackIndex = options.track ?? 1;
    const track = chapter.tracks[trackIndex - 1];
    if (!track) {
      throw new Error(
        `Track ${trackIndex} doesn't exist in chapter ${options.chapter} ` +
          `("${chapter.title}") — it has ${chapter.tracks.length} track(s).`
      );
    }
    return {
      chapterKey: chapter.key,
      trackKey: track.key,
      chapterTitle: chapter.title,
      trackTitle: track.title,
      duration: track.duration ?? chapter.duration ?? null,
    };
  }

  if (options.track !== undefined) {
    const flattened = chapters.flatMap((chapter) =>
      chapter.tracks.map((track) => ({ chapter, track }))
    );
    const entry = flattened[options.track - 1];
    if (!entry) {
      throw new Error(
        `Track ${options.track} doesn't exist — this card has ${flattened.length} track(s) in total.`
      );
    }
    return {
      chapterKey: entry.chapter.key,
      trackKey: entry.track.key,
      chapterTitle: entry.chapter.title,
      trackTitle: entry.track.title,
      duration: entry.track.duration ?? entry.chapter.duration ?? null,
    };
  }

  throw new Error("Specify --track and/or --chapter to say where to jump to.");
}

// Strict: rejects "1.5", "3abc", "0" and negatives rather than letting
// parseInt quietly truncate them — these are 1-based indexes and timeouts.
function parsePositiveIntOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || parseInt(value, 10) < 1) {
    error(`${label} must be a whole number of 1 or more, got "${value}".`);
    process.exit(1);
  }
  return parseInt(value, 10);
}

// Accepts plain seconds ("30") or an ffmpeg-style clock time ("3:00",
// "1:02:03") — the format most audio/video tools use for seek positions,
// and easier to read than raw seconds once you're more than a minute in.
function parseTimeOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return parseInt(value, 10);

  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    error(
      `${label} must be a number of seconds or a clock time like "3:00" or "1:02:03", got "${value}".`
    );
    process.exit(1);
  }
  const padded = parts.length === 2 ? ["0", ...parts] : parts;
  const [hours = 0, minutes = 0, seconds = 0] = padded.map((p) => parseInt(p, 10));
  // Seconds are always a 0-59 field; minutes only once hours are present
  // ("90:00" meaning ninety minutes is fine, "1:90:00" isn't).
  if (seconds > 59 || (parts.length === 3 && minutes > 59)) {
    error(`${label} isn't a valid clock time: "${value}" (minutes and seconds must be 0-59).`);
    process.exit(1);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

export async function seekDevicePosition(
  deviceId: string,
  options: {
    chapter?: string;
    track?: string;
    seconds?: string;
    fromEnd?: string;
    card?: string;
    json?: boolean;
  }
): Promise<void> {
  const client = await getAuthenticatedClient();
  const accessToken = client.getTokens().accessToken;
  if (!accessToken) {
    error("Not authenticated. Please login first.");
    process.exit(1);
  }

  if (options.seconds !== undefined && options.fromEnd !== undefined) {
    error("Specify only one of --seconds or --from-end, not both.");
    process.exit(1);
  }

  const chapterOpt = parsePositiveIntOption(options.chapter, "--chapter");
  const trackOpt = parsePositiveIntOption(options.track, "--track");
  const secondsOpt = parseTimeOption(options.seconds, "--seconds");
  const fromEndOpt = parseTimeOption(options.fromEnd, "--from-end");

  let cardId = options.card;
  if (!cardId) {
    const state = await getDevicePlaybackState(deviceId, accessToken);
    if (!hasCard(state)) {
      error(
        "Couldn't find a card currently on this device. Pass --card <cardId> to target one explicitly."
      );
      process.exit(1);
    }
    cardId = state.cardId;
  }

  const { card } = await client.getContent(cardId);

  let target: SeekTarget;
  try {
    target = resolveSeekTarget(card.content.chapters, { chapter: chapterOpt, track: trackOpt });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let secondsIn: number;
  if (fromEndOpt !== undefined) {
    if (target.duration === null) {
      error(
        `Don't know the duration of "${target.trackTitle}" — can't compute a position from the end. Use --seconds instead.`
      );
      process.exit(1);
    }
    secondsIn = Math.max(0, target.duration - fromEndOpt);
  } else {
    secondsIn = secondsOpt ?? 0;
  }

  await seekDevice(deviceId, accessToken, {
    cardId,
    chapterKey: target.chapterKey,
    trackKey: target.trackKey,
    secondsIn,
  });

  if (options.json) {
    json({
      ok: true,
      deviceId,
      cardId,
      chapterKey: target.chapterKey,
      trackKey: target.trackKey,
      chapterTitle: target.chapterTitle,
      trackTitle: target.trackTitle,
      secondsIn,
      duration: target.duration,
    });
    return;
  }

  success(
    `Jumped to "${target.trackTitle}" @ ${formatDuration(secondsIn)}` +
      (target.duration !== null ? ` / ${formatDuration(target.duration)}` : "")
  );
}
