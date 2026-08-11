import { readFile, stat } from "fs/promises";
import { basename } from "path";
import { getAuthenticatedClient } from "../commands/auth.ts";
import { success, error, info } from "./output.ts";

// The content API only accepts icon16x16 as "yoto:#{mediaId}" with a 43-char mediaId.
const MEDIA_ID_LENGTH = 43;

// Icon listings also expose a 24-char hex displayIconId, which is the ID shown
// in the Yoto web UI. It is NOT interchangeable with a mediaId.
const DISPLAY_ICON_ID = /^[0-9a-f]{24}$/i;

function looksLikeFilePath(icon: string): boolean {
  return (
    icon.startsWith("./") ||
    icon.startsWith("../") ||
    icon.startsWith("/") ||
    /\.(png|jpg|jpeg|gif)$/i.test(icon)
  );
}

async function uploadIconFile(path: string): Promise<string> {
  try {
    await stat(path);
  } catch {
    error(`Icon file not found: ${path}`);
    process.exit(1);
  }

  info(`Uploading icon...`);
  const client = await getAuthenticatedClient();
  const file = await readFile(path);

  const response = await client.uploadIcon(file, {
    filename: basename(path),
    autoConvert: true,
  });

  success(`Icon uploaded`);
  return response.displayIcon.mediaId;
}

async function lookupDisplayIconId(displayIconId: string): Promise<string> {
  const client = await getAuthenticatedClient();
  const [publicIcons, userIcons] = await Promise.all([
    client.getPublicIcons(),
    client.getUserIcons(),
  ]);

  const match = [...publicIcons.displayIcons, ...userIcons.displayIcons].find(
    (i) => i.displayIconId === displayIconId
  );

  if (!match) {
    error(
      `No icon found with displayIconId "${displayIconId}".\n` +
        `  Search for one with: yoto icon list --search <term>`
    );
    process.exit(1);
  }

  return match.mediaId;
}

// Smart icon resolver: accepts a file path (uploads it), a yoto:# reference,
// a mediaId, or a displayIconId (resolved against the icon listings).
export async function resolveIcon(icon: string): Promise<string> {
  let mediaId: string;

  if (icon.startsWith("yoto:#")) {
    mediaId = icon.slice(6);
  } else if (looksLikeFilePath(icon)) {
    mediaId = await uploadIconFile(icon);
  } else if (DISPLAY_ICON_ID.test(icon)) {
    mediaId = await lookupDisplayIconId(icon);
  } else {
    mediaId = icon;
  }

  if (mediaId.length !== MEDIA_ID_LENGTH) {
    error(
      `Invalid icon "${icon}".\n` +
        `  Expected a ${MEDIA_ID_LENGTH}-character mediaId, a 24-character displayIconId,\n` +
        `  or a path to an image file. Find IDs with: yoto icon list --search <term>`
    );
    process.exit(1);
  }

  return mediaId;
}
