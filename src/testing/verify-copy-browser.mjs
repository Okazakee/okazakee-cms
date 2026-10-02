import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isLoopbackUrl } from './lib/env.mjs';

// Install the optional browser driver outside the repository; no application
// dependency or production environment file is needed for this local check.
const { chromium } = await import(
  process.env.CMS_BROWSER_MODULE || 'playwright'
);
const fixture = process.env.ISOLATED_FIXTURE_URL || 'http://localhost:3200';
assert(isLoopbackUrl(fixture), 'Fixture API must be loopback');
const api = async (endpoint, init) => {
  const response = await fetch(`${fixture}${endpoint}`, init);
  assert(response.ok, `Fixture ${endpoint}: HTTP ${response.status}`);
  return response.json();
};
const runtime = await api('/__fixture/runtime');
for (const url of [runtime.nextUrl, runtime.fixtureUrl, runtime.supabaseUrl])
  assert(isLoopbackUrl(url));
const ports = new Set(
  [runtime.nextUrl, runtime.fixtureUrl, runtime.supabaseUrl].map(
    (url) => new URL(url).port
  )
);
const snapshot = async () =>
  (
    await api(
      '/__fixture/snapshot?tables=i18n_translations,skills_categories,skills'
    )
  ).tables;
const localeRow = (tables, locale) =>
  tables.i18n_translations.find((row) => row.language === locale);
const marker = `Browser-${Date.now()}`;
const results = [];
const errors = [];
const screenshotDir =
  process.env.ISOLATED_SCREENSHOTS || '/tmp/cms-preview-screenshots';
await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  return ['localhost', '127.0.0.1'].includes(url.hostname) &&
    ports.has(url.port)
    ? route.continue()
    : route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', (error) => errors.push(error.message));
const names = {
  hero: 'Hero Section',
  skills: 'Skills',
  career: 'Career',
  portfolio: 'Portfolio',
  blog: 'Blog',
  contacts: 'Contacts',
  'request-form': 'Request form',
  layout: 'Layout',
  'site-copy': 'Website copy',
  'privacy-policy': 'Privacy Policy',
};
const section = (key) => page.locator(`[data-section="${key}"]:not([hidden])`);
const nav = () => page.locator('#cms-navigation');
async function until(predicate, message, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(message);
}
async function open(key) {
  await nav().getByRole('button', { name: names[key], exact: true }).click();
  await section(key).waitFor();
  return section(key);
}
async function field(key, selector) {
  const input =
    selector === 'footer:left'
      ? section(key).getByLabel('Left', { exact: true })
      : section(key).locator(selector);
  await input.waitFor();
  await until(
    () => input.isEnabled(),
    `Field did not load: ${key}/${selector}`
  );
  return input;
}
async function publishAll() {
  await nav().getByRole('button', { name: 'Publish all', exact: true }).click();
  await until(
    async () => !/unsaved changes|publishing/i.test(await nav().innerText()),
    'Publish All retained failed/busy drafts'
  );
  const alerts = (await page.locator('[role=alert]').allInnerTexts())
    .map((text) => text.trim())
    .filter(Boolean);
  // Next's empty route-announcer is also role=alert; only messages are errors.
  assert.deepEqual(alerts, [], 'Publish All displayed errors');
}
async function preview(key, locale) {
  await open(key);
  await section(key)
    .getByRole('button', {
      name: locale === 'it' ? 'Italian' : 'English',
      exact: true,
    })
    .first()
    .click();
  await section(key)
    .getByRole('button', { name: 'Preview', exact: true })
    .click();
  const modal = page.getByRole('dialog');
  await modal.waitFor();
  await until(
    async () => !(await modal.innerText()).includes('Loading preview'),
    'Preview copy did not load'
  );
  return modal;
}
const pass = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
try {
  await page.goto(`${fixture}/__fixture/session?user=admin`);
  await (await field('hero', '#tf-name-en')).inputValue();
  const before = await snapshot();
  for (const key of [
    'hero',
    'skills',
    'career',
    'portfolio',
    'blog',
    'contacts',
  ]) {
    await open(key);
    await (
      await field(key, key === 'hero' ? '#tf-name-en' : '#tf-title-en')
    ).fill(`${marker}-${key}`);
  }
  await open('request-form');
  await (
    await field('request-form', '[aria-label="request-form.title (EN)"]')
  ).fill(`${marker}-request`);
  await open('layout');
  await (await field('layout', 'footer:left')).fill(`${marker}-footer`);
  await open('site-copy');
  await (
    await field('site-copy', '[aria-label="posts-section.button (EN)"]')
  ).fill(`${marker}-links`);
  await open('privacy-policy');
  await (await field('privacy-policy', 'textarea')).fill(`# ${marker}-privacy`);
  await open('hero');
  assert.equal(
    await section('hero').locator('#tf-name-en').inputValue(),
    `${marker}-hero`
  );
  pass('hidden drafts retained across all ten content/copy editors');
  await publishAll();
  const after = await snapshot();
  const en = localeRow(after, 'en');
  for (const [namespace, key, value] of [
    ['hero-section', 'top', null],
    ['skills-section', 'title', 'skills'],
    ['career-section', 'title', 'career'],
    ['posts-section', 'title1', 'portfolio'],
    ['posts-section', 'title2', 'blog'],
    ['posts-section', 'button', 'links'],
    ['contacts-section', 'title', 'contacts'],
    ['request-form', 'title', 'request'],
    ['footer', 'left', 'footer'],
  ]) {
    if (value)
      assert.equal(en.translations[namespace][key], `${marker}-${value}`);
  }
  assert.equal(en.translations['hero-section'].top.name, `${marker}-hero`);
  assert.equal(en.privacy_policy, `# ${marker}-privacy`);
  assert.deepEqual(
    localeRow(after, 'it'),
    localeRow(before, 'it'),
    'EN publication overwrote untouched Italian data'
  );
  assert.equal(
    en.translations['posts-section'].source,
    localeRow(before, 'en').translations['posts-section'].source
  );
  pass(
    'Publish All persists every editor, preserves IT/privacy and three independent posts-section patches'
  );

  // Test Italian draft-driven preview before saving, then ensure EN is unchanged.
  await open('hero');
  await section('hero')
    .getByRole('button', { name: 'Italian', exact: true })
    .click();
  await (await field('hero', '#tf-name-it')).fill(`${marker}-hero-it`);
  let modal = await preview('hero', 'it');
  assert((await modal.innerText()).includes(`${marker}-hero-it`));
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await open('request-form');
  await section('request-form')
    .getByRole('button', { name: 'Italian', exact: true })
    .click();
  await (
    await field('request-form', '[aria-label="request-form.title (IT)"]')
  ).fill(`${marker}-request-it`);
  modal = await preview('request-form', 'it');
  assert((await modal.innerText()).includes(`${marker}-request-it`));
  const writesBefore = (await api('/__fixture/writes?limit=1000')).writes
    .length;
  await modal
    .locator('form')
    .evaluate((form) =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      )
    );
  assert.equal(
    (await api('/__fixture/writes?limit=1000')).writes.length,
    writesBefore
  );
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await publishAll();
  const itAfter = await snapshot();
  assert.deepEqual(localeRow(itAfter, 'en'), en);
  assert.equal(
    localeRow(itAfter, 'it').translations['hero-section'].top.name,
    `${marker}-hero-it`
  );
  assert.equal(
    localeRow(itAfter, 'it').translations['request-form'].title,
    `${marker}-request-it`
  );
  pass(
    'Italian previews reflect unsaved drafts; inert form; IT publication preserves EN'
  );

  await open('hero');
  await section('hero')
    .getByRole('button', { name: 'English', exact: true })
    .click();
  await (await field('hero', '#tf-name-en')).fill('Discard this hidden draft');
  await open('layout');
  await (await field('layout', 'footer:left')).fill(
    'Discard this visible draft'
  );
  let confirmations = 0;
  const accept = async (dialog) => {
    confirmations++;
    await dialog.accept();
  };
  page.on('dialog', accept);
  await nav().getByRole('button', { name: 'Revert', exact: true }).click();
  await until(
    async () => !(await nav().innerText()).includes('unsaved changes'),
    'Global revert retained hidden drafts'
  );
  page.off('dialog', accept);
  assert.equal(confirmations, 1);
  await open('hero');
  assert.equal(
    await section('hero').locator('#tf-name-en').inputValue(),
    `${marker}-hero`
  );
  await open('layout');
  assert.equal(
    await section('layout').getByLabel('Left', { exact: true }).inputValue(),
    `${marker}-footer`
  );
  assert.equal(await page.getByRole('dialog').count(), 0);
  pass(
    'single global discard confirmation resets hidden and visible drafts without nested dialogs'
  );

  // All preview families in both languages and viewports; styles in both themes.
  const baselineWrites = (await api('/__fixture/writes?limit=1000')).writes
    .length;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const dark of [false, true]) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        dark
      );
      assert.equal(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--c-surface-base')
            .trim()
        ),
        dark ? '#0a0a0a' : '#f4f5f9'
      );
      for (const locale of ['en', 'it']) {
        for (const key of [
          'hero',
          'skills',
          'career',
          'portfolio',
          'blog',
          'contacts',
          'request-form',
          'layout',
        ]) {
          if (width < 1024) {
            const menu = page.getByRole('button', {
              name: 'Toggle menu',
              exact: true,
            });
            if ((await menu.count()) && (await menu.isVisible()))
              await menu.click();
          }
          modal = await preview(key, locale);
          assert((await modal.innerText()).trim().length > 20);
          assert.equal(
            await modal.locator('[role=alert]').count(),
            0,
            'Preview read failed'
          );
          if (key === 'portfolio') {
            const card = modal.locator('a.group.flex').first();
            assert.equal(
              await card.evaluate(
                (node) => getComputedStyle(node).flexDirection
              ),
              width >= 768 ? 'row' : 'column'
            );
          }
          await page.screenshot({
            path: path.join(
              screenshotDir,
              `${key}-${locale}-${width}-${dark ? 'dark' : 'light'}.png`
            ),
          });
          await page.keyboard.press('Escape');
          await modal.waitFor({ state: 'hidden' });
        }
      }
    }
  }
  assert.equal(
    (await api('/__fixture/writes?limit=1000')).writes.length,
    baselineWrites,
    'Opening previews mutated content'
  );
  pass(
    '64 preview combinations: EN/IT, mobile/desktop, light/dark; responsive cards; zero content writes'
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    passed: results.length,
    screenshots: screenshotDir,
    pageErrors: errors.length,
  })
);
