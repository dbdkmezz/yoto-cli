import { readFile } from "fs/promises";
import { basename } from "path";
import { stat } from "fs/promises";
import { getAuthenticatedClient } from "./auth.ts";
import { success, error, info, json } from "../utils/output.ts";
import { resolveIcon } from "../utils/icon.ts";


// Shared helper for uploading and transcoding audio
interface UploadResult {
  uploadId: string;
  trackUrl?: string;
  sha256?: string;
  duration?: number;
  format?: string;
  channels?: string;
}

async function uploadAndTranscode(
  filePath: string,
  options: { wait?: boolean } = { wait: true }
): Promise<UploadResult> {
  const client = await getAuthenticatedClient();
  const file = await readFile(filePath);
  const filename = basename(filePath);

  // Calculate SHA256 hash
  const hashBuffer = await crypto.subtle.digest("SHA-256", file);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sha256 = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  // Get upload URL
  const uploadResponse = await client.getAudioUploadUrl(sha256, filename);
  const uploadId = uploadResponse.upload.uploadId;

  if (uploadResponse.upload.uploadUrl) {
    info(`Uploading ${filename}...`);
    await client.uploadFile(uploadResponse.upload.uploadUrl, file);
    success(`Uploaded successfully`);
  } else {
    info(`File already exists on server`);
  }

  // Return early if not waiting for transcoding
  if (options.wait === false) {
    return { uploadId };
  }

  // Poll for transcoding to complete
  info(`Waiting for transcoding...`);
  const maxAttempts = 60; // Up to 5 minutes (5s intervals)

  for (let i = 0; i < maxAttempts; i++) {
    const transcodeResponse = await client.getTranscodedAudio(uploadId);
    const transcode = transcodeResponse.transcode;
    const phase = transcode.progress?.phase;

    if (phase === "complete" || transcode.transcodedSha256) {
      success(`Transcoding complete`);
      return {
        uploadId,
        trackUrl: `yoto:#${transcode.transcodedSha256}`,
        sha256: transcode.transcodedSha256,
        duration: transcode.transcodedInfo?.duration,
        format: transcode.transcodedInfo?.format,
        channels: transcode.transcodedInfo?.channels,
      };
    }

    if (
      phase &&
      phase !== "queued" &&
      phase !== "processing" &&
      phase !== "transcoding" &&
      phase !== "analyzing"
    ) {
      error(`Transcoding failed with status: ${phase}`);
      process.exit(1);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  error(`Transcoding timed out after ${maxAttempts * 5} seconds`);
  process.exit(1);
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

export async function addEntry(
  cardId: string,
  title: string,
  options: { icon?: string; file?: string; json?: boolean }
): Promise<void> {
  if (!options.file) {
    error("--file is required for entry add");
    process.exit(1);
  }

  // Get file size before upload
  const fileStat = await stat(options.file);
  const fileSize = fileStat.size;
  const originalFileName = basename(options.file).replace(/\.[^/.]+$/, ""); // Remove extension

  const result = await uploadAndTranscode(options.file, { wait: true });
  if (!result.trackUrl) {
    error(`Failed to get track URL from upload`);
    process.exit(1);
  }
  const trackUrl = result.trackUrl;
  const duration = result.duration;
  const format = result.format || "opus";
  const channels = result.channels || "stereo";

  // Resolve icon (upload if file path, use directly if hash)
  const DEFAULT_ICON = "aUm9i3ex3qqAMYBv-i-O-pYMKuMJGICtR3Vhf289u2Q";
  const mediaId = options.icon ? await resolveIcon(options.icon) : DEFAULT_ICON;
  const iconRef = `yoto:#${mediaId}`;

  const client = await getAuthenticatedClient();
  const existing = await client.getContent(cardId);
  const card = existing.card;

  // Generate a short key (API requires ≤20 chars)
  const nextIndex = card.content.chapters.length;
  const overlayLabel = String(nextIndex + 1); // 1-based for display

  const track = {
    key: "01",
    title,
    trackUrl,
    type: "audio",
    format,
    channels,
    duration,
    fileSize,
    overlayLabel,
    display: { icon16x16: iconRef },
    ambient: null,
  };

  const newChapter = {
    key: String(nextIndex).padStart(2, "0"),
    title,
    duration,
    tracks: [track],
    overlayLabel,
    display: { icon16x16: iconRef },
    fileSize,
    _originalFileName: originalFileName,
    availableFrom: null,
    ambient: null,
    defaultTrackDisplay: null,
    defaultTrackAmbient: null,
  };

  card.content.chapters.push(newChapter);

  await client.updateContent(cardId, {
    title: card.title,
    content: card.content,
    metadata: card.metadata,
  });

  if (options.json) {
    json({
      cardId,
      entryIndex: nextIndex,
      title,
      trackUrl,
      duration,
    });
    return;
  }

  success(`Added entry "${title}" to playlist`);
  if (duration) {
    info(`Duration: ${formatDuration(duration)}`);
  }
}

// Pass "all" as the index to update every entry in one read-modify-write,
// rather than one full card round-trip per entry.
export async function updateEntry(
  cardId: string,
  entryIndex: number | "all",
  options: { title?: string; icon?: string }
): Promise<void> {
  if (!options.title && !options.icon) {
    error("Nothing to update. Pass --title and/or --icon.");
    process.exit(1);
  }

  const client = await getAuthenticatedClient();
  const existing = await client.getContent(cardId);
  const card = existing.card;

  let targets;
  if (entryIndex === "all") {
    targets = card.content.chapters;
    if (targets.length === 0) {
      error(`Playlist ${cardId} has no entries.`);
      process.exit(1);
    }
  } else {
    const chapter = card.content.chapters[entryIndex];
    if (!chapter) {
      error(`Entry ${entryIndex} not found. Use 0-based index.`);
      process.exit(1);
    }
    targets = [chapter];
  }

  // Resolve once, not per entry — it may hit the network or upload a file.
  const iconRef = options.icon
    ? `yoto:#${await resolveIcon(options.icon)}`
    : undefined;

  for (const chapter of targets) {
    // Update title on both chapter and all tracks
    if (options.title) {
      chapter.title = options.title;
      for (const track of chapter.tracks) {
        track.title = options.title;
      }
    }

    // Update icon on both chapter and all tracks
    if (iconRef) {
      chapter.display = { ...chapter.display, icon16x16: iconRef };
      for (const track of chapter.tracks) {
        track.display = { ...track.display, icon16x16: iconRef };
      }
    }
  }

  await client.updateContent(cardId, {
    title: card.title,
    content: card.content,
    metadata: card.metadata,
  });

  if (entryIndex === "all") {
    success(`Updated ${targets.length} entries`);
  } else {
    success(`Updated entry "${targets[0]!.title}"`);
  }
}

export async function deleteEntry(
  cardId: string,
  entryIndex: number
): Promise<void> {
  const client = await getAuthenticatedClient();
  const existing = await client.getContent(cardId);
  const card = existing.card;

  if (entryIndex < 0 || entryIndex >= card.content.chapters.length) {
    error(`Entry ${entryIndex} not found. Use 0-based index.`);
    process.exit(1);
  }

  const removed = card.content.chapters.splice(entryIndex, 1)[0];

  await client.updateContent(cardId, {
    title: card.title,
    content: card.content,
    metadata: card.metadata,
  });

  success(`Deleted entry "${removed?.title}"`);
}
