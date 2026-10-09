/**
 * Server-side resume PDF renderer (server-only: imports chromium lazily so
 * the client bundle and unrelated actions never load the binary).
 *
 * Uses the same engine as a manual browser print (headless Chromium
 * printToPDF with print CSS media), so the output keeps real selectable
 * text (ATS-friendly) and the template's exact A4 pagination. `page.pdf()`
 * waits for `document.fonts.ready`, and the template links the print
 * fallbacks (Noto Sans) as webfonts, so metrics match a local print.
 */
import type { Browser } from 'puppeteer-core';

async function launchResumeBrowser(): Promise<Browser> {
  const puppeteer = await import('puppeteer-core');
  // Local escape hatch (dev machines / CI with a system Chrome):
  // RESUME_CHROME_PATH=/usr/bin/google-chrome
  const localPath = process.env.RESUME_CHROME_PATH ?? process.env.CHROME_PATH;
  if (localPath) {
    return puppeteer.launch({
      executablePath: localPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });
  }
  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });
}

/**
 * Renders both locale documents to A4 PDF buffers with one browser
 * instance. Throws on launch/render failure — callers map to action
 * errors and commit nothing.
 */
export async function renderResumePdfs(
  htmlEn: string,
  htmlIt: string
): Promise<{ en: Buffer; it: Buffer }> {
  const browser = await launchResumeBrowser();
  try {
    const out: { en: Buffer; it: Buffer } = {
      en: Buffer.alloc(0),
      it: Buffer.alloc(0),
    };
    const entries = [
      ['en', htmlEn],
      ['it', htmlIt],
    ] as const;
    for (const [key, html] of entries) {
      const page = await browser.newPage();
      try {
        await page.setContent(html, {
          // Font files finish via page.pdf()'s document.fonts.ready wait.
          waitUntil: 'load',
          timeout: 30_000,
        });
        const bytes = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          tagged: true,
          timeout: 30_000,
        });
        out[key] = Buffer.from(bytes);
      } finally {
        await page.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
