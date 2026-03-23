/**
 * Debug: test different GMaps search strategies for bot-detection bypass
 */
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY_GE = 'სტომატოლოგიური კლინიკები თბილისი';
const QUERY_EN = 'dental clinics Tbilisi';

async function dismissConsent(page) {
  try {
    const btn = page.locator([
      'button:has-text("Accept all")', 'button:has-text("Reject all")',
      'button:has-text("მიღება")', 'button:has-text("ყველას მიღება")',
      'button:has-text("ყველაფრის მიღება")', 'button:has-text("Agree")',
      'form[action*="consent"] button',
    ].join(', '));
    if (await btn.count() > 0) {
      await btn.first().click();
      await sleep(2000);
    }
  } catch {}
}

async function countResults(page) {
  await dismissConsent(page);
  
  // Wait for listings
  try {
    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 10000 });
  } catch {
    // Check what we got instead
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log('  No links found. Body:', body.replace(/\n/g, ' ').slice(0, 200));
    return 0;
  }
  const links = await page.locator('a[href*="/maps/place/"]').count();
  return links;
}

async function runTest(name, testFn) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log('─'.repeat(60));
  
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    locale: 'ka-GE',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    geolocation: { latitude: 41.7151, longitude: 44.8271 },
    permissions: ['geolocation'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  try {
    const count = await testFn(page);
    console.log(`  ★ RESULT: ${count} listing links`);
  } catch (err) {
    console.log(`  ★ ERROR: ${err.message}`);
  }
  await sleep(1000);
  await browser.close();
}

(async () => {
  // 1. Direct GE URL — current broken approach
  await runTest('Direct URL (Georgian, hl=ka)', async (page) => {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(QUERY_GE)}?hl=ka`;
    console.log(`  URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(5000);
    return countResults(page);
  });

  // 2. Direct EN URL — the old approach
  await runTest('Direct URL (English, hl=en)', async (page) => {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(QUERY_EN)}?hl=en`;
    console.log(`  URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(5000);
    return countResults(page);
  });

  // 3. Go to Maps homepage first, then type the GE query
  await runTest('Homepage → searchbox type (Georgian)', async (page) => {
    await page.goto('https://www.google.com/maps?hl=ka', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3000);
    await dismissConsent(page);
    const box = page.locator('#searchboxinput');
    await box.waitFor({ timeout: 8000 });
    await box.click();
    await sleep(300);
    // Type like a human — char by char
    for (const ch of QUERY_GE) {
      await page.keyboard.type(ch, { delay: 30 + Math.random() * 40 });
    }
    await sleep(800);
    await page.keyboard.press('Enter');
    await sleep(6000);
    return countResults(page);
  });

  // 4. Go to Maps homepage first, then type the EN query
  await runTest('Homepage → searchbox type (English)', async (page) => {
    await page.goto('https://www.google.com/maps?hl=ka', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3000);
    await dismissConsent(page);
    const box = page.locator('#searchboxinput');
    await box.waitFor({ timeout: 8000 });
    await box.click();
    await sleep(300);
    for (const ch of QUERY_EN) {
      await page.keyboard.type(ch, { delay: 30 + Math.random() * 40 });
    }
    await sleep(800);
    await page.keyboard.press('Enter');
    await sleep(6000);
    return countResults(page);
  });

  // 5. Direct URL but with hl=en and locale en-US (most like first-pass)
  await runTest('Direct URL (English, hl=en, locale=en-US) — first-pass style', async (page) => {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(QUERY_EN)}?hl=en`;
    console.log(`  URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(5000);
    return countResults(page);
  });

  console.log('\n\n★★★ ALL TESTS DONE ★★★\n');
})().catch(console.error);
