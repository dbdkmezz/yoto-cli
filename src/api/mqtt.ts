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

// Confirmed against a real device: this is the URI format card/start
// expects.
export function toCardUri(cardId: string): string {
  return `https://yoto.io/${cardId}`;
}

export interface CardStartTarget {
  cardId: string;
  chapterKey?: string;
  trackKey?: string;
  secondsIn: number;
}

// Directly jumps a device to a chapter/track/position, on demand — contrast
// with watchForCardTransfer, which waits for a *different* device to pick
// up a card before publishing the same command.
//
// QoS 1 is required for card/start (here and in watchForCardTransfer),
// verified against a real device: at the default
// QoS 0, `publish()`'s callback fires (the message reached the local socket)
// but the device never acts on it and AWS IoT gives no error — the command
// is just silently dropped somewhere between the client and the device, with
// nothing to catch. QoS 1 gets an actual PUBACK from the broker and the
// device does act on it.
//
// Resolving still only means the broker acknowledged the publish, not that
// the device finished acting on it — a device deep-seeking into a track
// (e.g. `secondsIn` near the end of a long file) has been observed taking
// 15s+ to reflect the new chapter/track/position in its live status/MQTT
// events, seemingly proportional to how far into the track the seek target
// is (consistent with decoding forward to the offset rather than a true
// random-access seek). Callers polling `getDevicePlaybackState` right after
// a seek should expect a delay, not treat a stale reading as failure.
export async function seekDevice(
  deviceId: string,
  accessToken: string,
  target: CardStartTarget
): Promise<void> {
  const client = connectToDevice(deviceId, accessToken);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end(true);
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(
      () => finish(new Error("Timed out sending seek command to device")),
      RESPONSE_TIMEOUT_MS
    );

    client.on("connect", () => {
      client.publish(
        `device/${deviceId}/command/card/start`,
        JSON.stringify({
          uri: toCardUri(target.cardId),
          chapterKey: target.chapterKey,
          trackKey: target.trackKey,
          secondsIn: target.secondsIn,
        }),
        { qos: 1 },
        (err) => finish(err ?? undefined)
      );
    });

    client.on("error", (err) => finish(err));
  });
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

  return new Promise((resolve, reject) => {
    let settled = false;
    // Set once card/start has gone out to a candidate: a second event from
    // that device can land before the broker's PUBACK does, and must not
    // trigger a duplicate publish.
    let seekSent = false;
    const timers: ReturnType<typeof setInterval>[] = [];
    let ackTimeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CardTransferOutcome | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(ackTimeout);
      timers.forEach(clearInterval);
      sourceClient.end(true);
      candidates.forEach(({ client }) => client.end(true));
      if (err) reject(err);
      else resolve(result);
    };

    const timeout = setTimeout(() => finish(null), timeoutMs);

    // Subscribe callbacks can fire *after* finish(): mqtt.js errors out any
    // still-pending subscribe when the connection is force-closed. Without
    // the `settled` guard that late callback would create an interval after
    // `timers` had already been cleared, and it would keep the process alive
    // indefinitely once the command had otherwise completed.
    sourceClient.on("connect", () => {
      sourceClient.subscribe(`device/${sourceDeviceId}/data/events`, (err) => {
        if (err || settled) return;
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
        client.subscribe(`device/${deviceId}/data/events`, (err) => {
          if (err || settled) return;
          const request = () =>
            client.publish(`device/${deviceId}/command/events/request`, "");
          request();
          timers.push(setInterval(request, REFRESH_INTERVAL_MS));
        });
      });

      client.on("message", (_topic, payload) => {
        if (settled || seekSent) return;
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
        // Snapshot now: `latest` can still move between publish and PUBACK,
        // and the reported outcome must describe what was actually sent.
        const { chapterKey, trackKey } = latest;
        seekSent = true;

        // QoS 1 for the same reason as seekDevice (see above): at QoS 0 the
        // device never acts on card/start. That also changes what the
        // callback means — PUBACK received, not "written to the socket" —
        // and mqtt.js never invokes a QoS 1 publish callback if the
        // connection drops first (it parks the message for a reconnect we've
        // disabled), so bound that wait ourselves rather than sitting out the
        // whole watch timeout looking like we're still waiting for the card.
        ackTimeout = setTimeout(
          () =>
            finish(
              null,
              new Error(`Timed out sending card/start to device ${deviceId} after it picked up the card`)
            ),
          RESPONSE_TIMEOUT_MS
        );
        client.publish(
          `device/${deviceId}/command/card/start`,
          JSON.stringify({ uri: toCardUri(cardId), chapterKey, trackKey, secondsIn }),
          { qos: 1 },
          (err) => {
            if (err) finish(null, err);
            else finish({ deviceId, chapterKey, trackKey, secondsIn });
          }
        );
      });

      client.on("error", () => {
        // One candidate having trouble shouldn't cancel watching the rest.
      });
    }
  });
}
