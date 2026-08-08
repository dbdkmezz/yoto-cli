import mqtt from "mqtt";
import { DeviceEventSchema, hasCard, type DeviceEvent } from "./schemas.ts";

// Yoto players don't expose live playback position over REST — only via
// this AWS IoT MQTT broker. Endpoint and auth scheme are from
// https://yoto.dev/players-mqtt/. One short-lived connection per device
// (Yoto's own client ID convention is per-device), not a shared fleet
// connection.
//
// Two things verified empirically against a real device that the docs got
// wrong/inconsistent on:
// - Topics have NO leading slash (`device/{id}/...`, not `/device/{id}/...`).
//   AWS IoT's custom authorizer matches topic strings exactly; a leading
//   slash mismatch doesn't error the subscribe/publish — it silently kills
//   the whole connection right after, which looked identical to "device
//   didn't respond" until traced with a raw WebSocket close-code hook.
// - `forceNativeWebSocket: true` is required under Bun: mqtt.js's default
//   Node transport calls `ws`'s `createWebSocketStream`, which Bun doesn't
//   implement ("Not supported yet in Bun"), and it throws synchronously
//   inside `mqtt.connect()` — silently turning into a rejected promise
//   wherever this is awaited inside Promise.allSettled. Forcing the
//   browser-style native-WebSocket transport sidesteps that; the ALPN
//   option from Yoto's own sample is irrelevant to it (native WebSocket
//   doesn't expose ALPN) and connections work fine without it.
const MQTT_URL = "wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt";
const RESPONSE_TIMEOUT_MS = 5000;

function connectToDevice(deviceId: string, accessToken: string) {
  return mqtt.connect(MQTT_URL, {
    port: 443,
    protocol: "wss",
    username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`,
    password: accessToken,
    clientId: `DASH${deviceId}`,
    keepalive: 300,
    reconnectPeriod: 0,
    connectTimeout: RESPONSE_TIMEOUT_MS,
    forceNativeWebSocket: true,
  });
}

// Opens a connection, asks the device to publish a fresh status report, and
// returns the first event received. Resolves null (rather than throwing) on
// a timeout, since an offline/asleep device simply won't answer — that's an
// expected outcome callers need to handle per-device, not a hard error.
export async function getDevicePlaybackState(
  deviceId: string,
  accessToken: string
): Promise<DeviceEvent | null> {
  const client = connectToDevice(deviceId, accessToken);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeviceEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end(true);
      resolve(result);
    };

    const timeout = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);

    client.on("connect", () => {
      client.subscribe(`device/${deviceId}/data/events`, (err) => {
        if (err) {
          finish(null);
          return;
        }
        client.publish(`device/${deviceId}/command/events/request`, "");
      });
    });

    client.on("message", (_topic, payload) => {
      try {
        finish(DeviceEventSchema.parse(JSON.parse(payload.toString())));
      } catch {
        finish(null);
      }
    });

    client.on("error", () => finish(null));
  });
}

// Not verified against a live device — Yoto's docs give this as the URI
// format but this codebase hasn't confirmed it against a real card/start
// response yet.
export function toCardUri(cardId: string): string {
  return `https://yoto.io/${cardId}`;
}

const REFRESH_INTERVAL_MS = 10_000;

export interface CardTransferOutcome {
  deviceId: string;
  chapterKey?: string;
  trackKey?: string;
  secondsIn: number;
}

// Yoto players are a single physical card moved between devices — only one
// device is ever "on" a card at a time, so there's no moment where both a
// live source position and a live target both exist for a plain "copy
// position now" command to work. This instead watches: keeps refreshing the
// source's position (in case the user leaves it playing a while before
// moving the card) and watches every candidate device for that same cardId
// to show up (the user physically moving the card there). The instant it
// does, it re-issues card/start on that device — which is already open and
// mid-subscribe, so no reconnect — at the source's estimated current
// position (extrapolated forward if the source was still "playing" when we
// last heard from it; frozen as-is if it was paused/stopped).
export async function watchForCardTransfer(
  sourceDeviceId: string,
  initialSourceState: DeviceEvent & { cardId: string },
  candidateDeviceIds: string[],
  accessToken: string,
  timeoutMs: number
): Promise<CardTransferOutcome | null> {
  const cardId = initialSourceState.cardId;
  let latest: DeviceEvent = initialSourceState;

  const sourceClient = connectToDevice(sourceDeviceId, accessToken);
  const candidates = candidateDeviceIds.map((deviceId) => ({
    deviceId,
    client: connectToDevice(deviceId, accessToken),
  }));

  return new Promise((resolve) => {
    let settled = false;
    const timers: ReturnType<typeof setInterval>[] = [];

    const finish = (result: CardTransferOutcome | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      timers.forEach(clearInterval);
      sourceClient.end(true);
      candidates.forEach(({ client }) => client.end(true));
      resolve(result);
    };

    const timeout = setTimeout(() => finish(null), timeoutMs);

    sourceClient.on("connect", () => {
      sourceClient.subscribe(`device/${sourceDeviceId}/data/events`, () => {
        const request = () =>
          sourceClient.publish(`device/${sourceDeviceId}/command/events/request`, "");
        request();
        timers.push(setInterval(request, REFRESH_INTERVAL_MS));
      });
    });
    sourceClient.on("message", (_topic, payload) => {
      try {
        const event = DeviceEventSchema.parse(JSON.parse(payload.toString()));
        if (hasCard(event) && event.cardId === cardId) latest = event;
      } catch {
        // Malformed payload — keep the last good snapshot rather than losing it.
      }
    });
    sourceClient.on("error", () => {
      // Source hiccup: stop refreshing its estimate, but don't cancel the
      // whole watch over it — the target device is what matters now.
    });

    for (const { deviceId, client } of candidates) {
      client.on("connect", () => {
        client.subscribe(`device/${deviceId}/data/events`, () => {
          const request = () =>
            client.publish(`device/${deviceId}/command/events/request`, "");
          request();
          timers.push(setInterval(request, REFRESH_INTERVAL_MS));
        });
      });

      client.on("message", (_topic, payload) => {
        if (settled) return;
        let event: DeviceEvent;
        try {
          event = DeviceEventSchema.parse(JSON.parse(payload.toString()));
        } catch {
          return;
        }
        if (!hasCard(event) || event.cardId !== cardId) return;

        const stillPlaying = latest.playbackStatus === "playing";
        const elapsed =
          stillPlaying && latest.eventUtc !== undefined
            ? Math.max(0, Math.round(Date.now() / 1000 - latest.eventUtc))
            : 0;
        const secondsIn = (latest.position ?? 0) + elapsed;

        client.publish(
          `device/${deviceId}/command/card/start`,
          JSON.stringify({
            uri: toCardUri(cardId),
            chapterKey: latest.chapterKey,
            trackKey: latest.trackKey,
            secondsIn,
          }),
          () =>
            finish({
              deviceId,
              chapterKey: latest.chapterKey,
              trackKey: latest.trackKey,
              secondsIn,
            })
        );
      });

      client.on("error", () => {
        // One candidate having trouble shouldn't cancel watching the rest.
      });
    }
  });
}
