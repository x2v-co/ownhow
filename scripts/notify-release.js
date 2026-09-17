// Optional outbound webhook for an operator-configured Agent gateway.
// The payload is a version hint; receivers must fetch the official manifest.
import { readFile } from "node:fs/promises";
import { updateNotice } from "../src/upgrade.js";
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const destination = process.env.OWNHOW_UPDATE_WEBHOOK;
if (!destination) { console.log("No update webhook configured; release notice asset remains available."); process.exit(0); }
const url = new URL(destination);
if (url.protocol !== "https:" || url.username || url.password) throw new Error("Update webhook must be HTTPS without embedded credentials");
const headers = { "content-type": "application/json" };
if (process.env.OWNHOW_UPDATE_WEBHOOK_TOKEN) headers.authorization = `Bearer ${process.env.OWNHOW_UPDATE_WEBHOOK_TOKEN}`;
const response = await fetch(url, { method: "POST", redirect: "error", headers, signal: AbortSignal.timeout(15000), body: JSON.stringify({ event: "ownhow.release", version: pkg.version, notice: updateNotice(pkg.version), releaseUrl: `https://github.com/x2v-co/ownhow/releases/tag/v${pkg.version}` }) });
if (!response.ok) throw new Error(`Agent update notification failed: HTTP ${response.status}`);
console.log(`Sent release notice for ${pkg.version}. Delivery does not prove Agent installation.`);
