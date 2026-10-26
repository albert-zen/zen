import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { type Session } from "electron";
import {
  isExactRendererEntry,
  rendererHtmlWithStyleNonce,
} from "./renderer-style-policy.js";

const installed = new WeakMap<Session, string>();

/** Called only by main for its own known renderer entry, never by renderer IPC. */
export function installRendererFileProtocol(
  owner: Session,
  rendererEntry: string,
): void {
  const entryUrl = pathToFileURL(rendererEntry).href;
  const previous = installed.get(owner);
  if (previous) {
    if (previous !== entryUrl)
      throw new Error("Renderer session entry changed");
    return;
  }
  owner.protocol.handle("file", async (request) => {
    if (!isExactRendererEntry(request.url, entryUrl))
      return owner.fetch(request, { bypassCustomProtocolHandlers: true });
    const url = new URL(request.url);
    if (url.protocol !== "file:" || url.hostname || request.method !== "GET")
      return new Response("Unsupported renderer entry request", {
        status: 403,
      });
    try {
      const html = await readFile(rendererEntry, "utf8");
      const nonce = randomBytes(24).toString("base64");
      return new Response(rendererHtmlWithStyleNonce(html, nonce), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      // Never return the unmodified template or disclose the nonce on failure.
      return new Response("Renderer security template unavailable", {
        status: 500,
      });
    }
  });
  installed.set(owner, entryUrl);
}
