#!/usr/bin/env node
/**
 * Screenshot the real app in Chrome at three widths, against the live API.
 *
 * Creates a throwaway account, keeps its session cookie, and captures each page.
 * Output: .data/shots/<page>-<width>.png (gitignored).
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = (process.env.BASE ?? "https://talisman-agent.vercel.app").replace(/\/$/, "");
const email = `shot-${Date.now()}@example.test`;
const password = "screenshot password 2026";

const signup = await fetch(`${base}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, orgName: "Screenshots" }),
});
if (!signup.ok) throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
const setCookie = signup.headers.get("set-cookie") ?? "";
const value = setCookie.split(";")[0]?.split("=")[1];
if (!value) throw new Error("no session cookie");

const pages = ["/", "/chat", "/tasks", "/artifacts", "/connectors", "/devices", "/settings"];
const widths = [1440, 768, 390];

await mkdir(".data/shots", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const width of widths) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  await context.addCookies([
    { name: "talisman_session", value, domain: new URL(base).hostname, path: "/" },
  ]);
  const page = await context.newPage();
  for (const path of pages) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const name = path === "/" ? "today" : path.slice(1).replace(/\//g, "-");
    await page.screenshot({ path: `.data/shots/${name}-${width}.png`, fullPage: true });
  }
  await context.close();
}

// Light theme, desktop only: both themes have to be finished.
const light = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "light",
});
await light.addCookies([
  { name: "talisman_session", value, domain: new URL(base).hostname, path: "/" },
]);
const lightPage = await light.newPage();
await lightPage.goto(`${base}/`, { waitUntil: "networkidle" });
await lightPage.screenshot({ path: ".data/shots/today-light-1440.png", fullPage: true });
await light.close();

await browser.close();
console.log("shots written to .data/shots");
