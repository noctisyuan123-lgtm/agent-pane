export type BrowserState = {
  url: string;
  title: string;
  screenshotBase64: string;
  error?: string;
};

function assertHttpUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http: and https: URLs are allowed");
  }
}

type PlaywrightPage = {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  goBack(opts?: { waitUntil?: string }): Promise<unknown>;
  screenshot(opts?: { type?: string }): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  title(): Promise<string>;
  url(): string;
  accessibility?: {
    snapshot(): Promise<unknown>;
  };
  evaluate<T>(fn: () => T): Promise<T>;
};

type PlaywrightBrowser = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};

class BrowserSession {
  private browser: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;
  private lastScreenshot = "";
  private lastError: string | undefined;
  private url = "";
  private title = "";

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page;
    try {
      const pw = (await new Function("return import('playwright')")()) as {
        chromium: {
          launch(opts: {
            headless: boolean;
            channel?: string;
            executablePath?: string;
          }): Promise<PlaywrightBrowser>;
          executablePath(): string;
        };
      };
      // Prefer bundled chromium; fall back to channel if headless-shell missing
      let browser: PlaywrightBrowser;
      try {
        browser = await pw.chromium.launch({ headless: true });
      } catch (first) {
        const msg = first instanceof Error ? first.message : String(first);
        // Version skew: playwright package newer than cached browsers
        if (/Executable doesn't exist|chrome-headless-shell/i.test(msg)) {
          try {
            browser = await pw.chromium.launch({
              headless: true,
              channel: "chrome",
            });
          } catch {
            this.lastError =
              `${msg}\n\nFix: cd apps/bridge && npx playwright install chromium`;
            throw first;
          }
        } else {
          this.lastError =
            msg ||
            "Playwright not available. Run: cd apps/bridge && npx playwright install chromium";
          throw first;
        }
      }
      this.browser = browser;
      this.page = await browser.newPage();
      this.lastError = undefined;
      return this.page;
    } catch (e) {
      if (!this.lastError) {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastError =
          msg.includes("Executable doesn't exist") ||
          msg.includes("chrome-headless-shell")
            ? `${msg}\n\nFix: cd apps/bridge && npx playwright install chromium`
            : "Playwright not available. Install with: cd apps/bridge && npx playwright install chromium";
      }
      throw e;
    }
  }

  private async refreshScreenshot(): Promise<void> {
    if (!this.page) return;
    try {
      const buf = await this.page.screenshot({ type: "png" });
      this.lastScreenshot = buf.toString("base64");
      this.lastError = undefined;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  async navigate(url: string): Promise<void> {
    assertHttpUrl(url);
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    this.url = page.url();
    this.title = await page.title();
    await this.refreshScreenshot();
  }

  async back(): Promise<void> {
    const page = await this.ensurePage();
    await page.goBack({ waitUntil: "domcontentloaded" });
    this.url = page.url();
    this.title = await page.title();
    await this.refreshScreenshot();
  }

  async screenshot(): Promise<string> {
    const page = await this.ensurePage();
    const buf = await page.screenshot({ type: "png" });
    this.lastScreenshot = buf.toString("base64");
    return this.lastScreenshot;
  }

  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    try {
      if (page.accessibility?.snapshot) {
        const tree = await page.accessibility.snapshot();
        return JSON.stringify(tree, null, 2);
      }
    } catch {
      /* fall through */
    }
    return page.evaluate(() => document.body?.innerText ?? "");
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector);
    this.url = page.url();
    this.title = await page.title();
    await this.refreshScreenshot();
  }

  async type(selector: string, text: string): Promise<void> {
    const page = await this.ensurePage();
    await page.fill(selector, text);
    await this.refreshScreenshot();
  }

  getState(): BrowserState {
    return {
      url: this.url,
      title: this.title,
      screenshotBase64: this.lastScreenshot,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

let singleton: BrowserSession | null = null;

export function getBrowserSession(): BrowserSession {
  if (!singleton) singleton = new BrowserSession();
  return singleton;
}
