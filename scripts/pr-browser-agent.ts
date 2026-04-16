/**
 * PR browser agent: Stagehand (LOCAL) + OpenRouter, then hard DOM verification
 * that the primary button appends "Hello world" under [data-testid="hello-output"].
 */
import { writeFileSync } from "node:fs";
import { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import { z } from "zod";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:9333").replace(
  /\/$/,
  ""
);
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const modelName =
  process.env.STAGEHAND_MODEL?.trim() ||
  "openai/meta-llama/llama-3.3-70b-instruct:free";

const failureLogPath = process.env.PR_AGENT_FAILURE_LOG ?? "pr-agent-failure.txt";

async function hardVerifyHelloAfterClick(page: Page) {
  const btn = page.locator('[data-testid="cta-primary"]');
  await btn.waitFor({ state: "visible", timeout: 20_000 });
  if (!(await btn.isEnabled())) {
    throw new Error("Primary button is visible but not enabled.");
  }

  let text = await page.locator('[data-testid="hello-output"]').innerText();
  if (!text.includes("Hello world")) {
    await btn.click();
    await page
      .locator('[data-testid="hello-output"]')
      .getByText("Hello world", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => undefined);
    text = await page.locator('[data-testid="hello-output"]').innerText();
  }

  if (!text.includes("Hello world")) {
    throw new Error(
      'Expected "Hello world" under [data-testid="hello-output"] after clicking the primary button — action appears broken.'
    );
  }
}

async function main() {
  if (!apiKey) {
    const m = "Missing OPENROUTER_API_KEY (required for Stagehand LLM steps in CI).";
    console.error(m);
    writeFileSync(failureLogPath, m, "utf8");
    process.exit(1);
  }

  const referer =
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    "https://github.com/maciejtrabka/qa-bot";

  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: {
      modelName,
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": referer,
        "X-Title": "qa-bot-pr-browser-agent",
      },
    },
    localBrowserLaunchOptions: {
      headless: true,
      chromiumSandbox: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    await page.goto(`${BASE_URL}/`, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });

    await stagehand.act(
      "Exploratory QA only on this page: find the button whose label mentions adding Hello world below the button. Click it once as a real user would, then stop. Do not leave this page."
    );

    const observationSchema = z.object({
      sawButton: z.boolean(),
      clicked: z.boolean(),
      helloVisibleAfterExploration: z.boolean(),
      notes: z.string(),
    });

    let obs: z.infer<typeof observationSchema>;
    try {
      obs = await stagehand.extract(
        "Based on the current page: did you see the primary action button about Hello world? Did you click it? Is the text Hello world visible below that button? One short sentence in notes.",
        observationSchema
      );
    } catch (e) {
      console.warn("extract() failed (non-fatal):", e);
      obs = {
        sawButton: false,
        clicked: false,
        helloVisibleAfterExploration: false,
        notes: "extract failed",
      };
    }
    console.log("LLM extraction summary:", JSON.stringify(obs, null, 2));

    await hardVerifyHelloAfterClick(page as unknown as Page);
    console.log("PR browser agent: hard DOM gate passed.");
  } catch (e) {
    const detail =
      e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e);
    console.error(detail);
    try {
      writeFileSync(failureLogPath, detail, "utf8");
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await stagehand.close().catch(() => undefined);
  }

  if (process.exitCode === 1) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
