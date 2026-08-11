import { readFile } from "fs/promises";
import { basename } from "path";
import { getAuthenticatedClient } from "./auth.ts";
import { success, info, table, json } from "../utils/output.ts";

export async function listPublicIcons(options: {
  json?: boolean;
  tag?: string;
  search?: string;
}): Promise<void> {
  const client = await getAuthenticatedClient();
  const response = await client.getPublicIcons();

  let icons = response.displayIcons;

  if (options.tag) {
    icons = icons.filter((icon) =>
      icon.publicTags.some((t) =>
        t.toLowerCase().includes(options.tag!.toLowerCase())
      )
    );
  }

  if (options.search) {
    const term = options.search.toLowerCase();
    icons = icons.filter(
      (icon) =>
        (icon.title ?? "").toLowerCase().includes(term) ||
        icon.publicTags.some((t) => t.toLowerCase().includes(term))
    );
  }

  if (options.json) {
    json(icons);
    return;
  }

  if (icons.length === 0) {
    info("No icons found.");
    return;
  }

  // mediaId is what the content API needs; displayIconId is what the web UI shows.
  table(
    ["Title", "displayIconId", "mediaId", "Tags"],
    icons.map((icon) => [
      icon.title ?? "",
      icon.displayIconId,
      icon.mediaId,
      icon.publicTags.join(", "),
    ])
  );
}

export async function listUserIcons(options: { json?: boolean }): Promise<void> {
  const client = await getAuthenticatedClient();
  const response = await client.getUserIcons();

  if (options.json) {
    json(response.displayIcons);
    return;
  }

  if (response.displayIcons.length === 0) {
    info("No custom icons found.");
    return;
  }

  table(
    ["displayIconId", "mediaId", "URL"],
    response.displayIcons.map((icon) => [
      icon.displayIconId,
      icon.mediaId,
      icon.url,
    ])
  );
}

export async function uploadIcon(
  filePath: string,
  options: { autoConvert?: boolean; json?: boolean }
): Promise<void> {
  const client = await getAuthenticatedClient();
  const file = await readFile(filePath);
  const filename = basename(filePath);

  const response = await client.uploadIcon(file, {
    filename,
    autoConvert: options.autoConvert ?? true,
  });

  if (options.json) {
    json(response.displayIcon);
    return;
  }

  const icon = response.displayIcon;
  success(`Uploaded icon: ${icon.displayIconId}`);
  if (typeof icon.url === "string" && icon.url) {
    info(`URL: ${icon.url}`);
  }
}
