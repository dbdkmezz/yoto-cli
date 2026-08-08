import mqtt from "mqtt";
import { DeviceEventSchema, type DeviceEvent } from "./schemas.ts";

// Yoto players don't expose live playback position over REST — only via
// this AWS IoT MQTT broker. Endpoint, auth scheme, and topic names are from
// https://yoto.dev/players-mqtt/. One short-lived connection per device
// (Yoto's own client ID convention is per-device), not a shared fleet
// connection.
const MQTT_URL = "wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt";
const RESPONSE_TIMEOUT_MS = 5000;

function connectToDevice(deviceId: string, accessToken: string) {
  return mqtt.connect(MQTT_URL, {
    port: 443,
    protocol: "wss",
    username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`,
    password: accessToken,
    clientId: `DASH${deviceId}`,
    ALPNProtocols: ["x-amzn-mqtt-ca"],
    keepalive: 300,
    reconnectPeriod: 0,
    connectTimeout: RESPONSE_TIMEOUT_MS,
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
      client.subscribe(`/device/${deviceId}/data/events`, (err) => {
        if (err) {
          finish(null);
          return;
        }
        client.publish(`/device/${deviceId}/command/events/request`, "");
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

export interface CardStartCommand {
  uri: string;
  chapterKey?: string;
  trackKey?: string;
  secondsIn?: number;
}

// Resuming/seeking on a Yoto player is done by re-issuing card/start at the
// desired chapter/track/second — there's no separate seek command. Resolves
// true once the broker has accepted the publish; Yoto's MQTT docs don't
// document an ack topic to confirm the device actually acted on it.
export async function setDevicePlayback(
  deviceId: string,
  accessToken: string,
  command: CardStartCommand
): Promise<boolean> {
  const client = connectToDevice(deviceId, accessToken);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end(true);
      resolve(result);
    };

    const timeout = setTimeout(() => finish(false), RESPONSE_TIMEOUT_MS);

    client.on("connect", () => {
      client.publish(
        `/device/${deviceId}/command/card/start`,
        JSON.stringify(command),
        (err) => finish(!err)
      );
    });

    client.on("error", () => finish(false));
  });
}
