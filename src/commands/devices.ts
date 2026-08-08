import { getAuthenticatedClient } from "./auth.ts";
import { info, table, json, success, error, confirm } from "../utils/output.ts";
import { getDevicePlaybackState, setDevicePlayback, toCardUri } from "../api/mqtt.ts";
import { hasCard, type Device, type DeviceEvent } from "../api/schemas.ts";

const STALE_THRESHOLD_SECONDS = 30;

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
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

export async function syncDevicePosition(
  sourceDeviceId: string,
  options: { to?: string; all?: boolean; yes?: boolean; json?: boolean }
): Promise<void> {
  if (!options.to && !options.all) {
    error("Specify --to <deviceId,...> or --all.");
    process.exit(1);
  }
  if (options.to && options.all) {
    error("Pass either --to or --all, not both.");
    process.exit(1);
  }

  const client = await getAuthenticatedClient();
  const accessToken = client.getTokens().accessToken;
  if (!accessToken) {
    error("Not authenticated. Please login first.");
    process.exit(1);
  }

  const { devices } = await client.getDevices();
  const source = devices.find((d) => d.deviceId === sourceDeviceId);
  if (!source) {
    error(`Device ${sourceDeviceId} not found. Run 'yoto device list'.`);
    process.exit(1);
  }

  const sourceState = await getDevicePlaybackState(sourceDeviceId, accessToken);
  if (!hasCard(sourceState)) {
    error(`${source.name} isn't currently on a card — nothing to sync.`);
    process.exit(1);
  }

  const targetIds = options.all
    ? devices.filter((d) => d.deviceId !== sourceDeviceId).map((d) => d.deviceId)
    : (options.to ?? "").split(",").map((id) => id.trim()).filter(Boolean);

  const targets: Device[] = [];
  for (const id of targetIds) {
    const device = devices.find((d) => d.deviceId === id);
    if (!device) {
      error(`Device ${id} not found. Run 'yoto device list'.`);
      process.exit(1);
    }
    if (device.deviceId === sourceDeviceId) continue; // --to may list the source itself; skip rather than syncing to itself
    targets.push(device);
  }

  if (targets.length === 0) {
    info("No target devices to sync.");
    return;
  }

  const position = sourceState.position ?? 0;
  const stale = (ageSeconds(sourceState.eventUtc) ?? 0) > STALE_THRESHOLD_SECONDS;

  if (!options.yes) {
    const staleNote = stale ? ` — ${source.name} may not be playing right now` : "";
    const ok = await confirm(
      `This will move ${targets.length} other device${targets.length === 1 ? "" : "s"} to ` +
        `${sourceState.cardId} ch${sourceState.chapterKey ?? "?"}/tr${sourceState.trackKey ?? "?"} ` +
        `(@${formatDuration(position)}, as of ${formatAge(sourceState.eventUtc)}${staleNote}):\n` +
        `  ${targets.map((t) => t.name).join(", ")}\nContinue?`
    );
    if (!ok) {
      info("Aborted.");
      return;
    }
  }

  const uri = toCardUri(sourceState.cardId);
  const results = await Promise.allSettled(
    targets.map((target) =>
      setDevicePlayback(target.deviceId, accessToken, {
        uri,
        chapterKey: sourceState.chapterKey,
        trackKey: sourceState.trackKey,
        secondsIn: position,
      })
    )
  );

  const outcomes = targets.map((target, i) => {
    const result = results[i];
    const ok = result !== undefined && result.status === "fulfilled" && result.value === true;
    return { device: target, ok };
  });

  if (options.json) {
    json(
      outcomes.map(({ device, ok }) => ({
        deviceId: device.deviceId,
        name: device.name,
        ok,
      }))
    );
    return;
  }

  for (const { device, ok } of outcomes) {
    if (ok) {
      success(`${device.name} -> done`);
    } else {
      error(`${device.name} -> failed`);
    }
  }
}
