/**
 * Focused test: scrape page 1 (10 companies), then navigate to page 2, scrape 10 more.
 * Goal: debug pagination navigation on bia.ge
 */
const { chromium } = require('playwright');

const BASE = 'https://www.bia.ge';
const SUB_ID = '3279';  // Dealers — small category, ~85 companies
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'ka-GE',
  });
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const t = route.request().resourceType();
    if (['image', 'font', 'media'].includes(t)) return route.abort();
    return route.continue();
  });

  // ── PAGE 1 ──
  console.log('\n=== Loading subcategory listing ===');
  await page.goto(`${BASE}/Company/Industry/${SUB_ID}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Dump pagination area
  const paginationInfo = await page.evaluate(() => {
    const body = document.body.innerText;
    // Find the pagination text
    const lines = body.split('\n').filter(l => l.includes('სულ') || l.includes('GO') || l.includes('გვერდი'));
    // Find all inputs
    const inputs = [...document.querySelectorAll('input')].map(i => ({
      type: i.type, name: i.name, id: i.id, value: i.value,
      parentText: (i.parentElement?.textContent || '').trim().slice(0, 100),
    }));
    // Find pagination container
    const pagDiv = document.querySelector('.paging, .pagination, [class*="pag"]');
    return {
      paginationLines: lines.slice(0, 5),
      inputs: inputs.filter(i => i.type === 'text' || i.type === 'button' || i.type === 'submit'),
      pagDivClass: pagDiv?.className || 'none',
      pagDivHTML: pagDiv?.innerHTML?.slice(0, 500) || 'none',
    };
  });
  console.log('Pagination info:', JSON.stringify(paginationInfo, null, 2));

  // Get company links on page 1
  const page1Links = await getCompanyLinks(page);
  console.log(`\n=== PAGE 1: ${page1Links.length} company links ===`);
  page1Links.forEach((c, i) => console.log(`  ${i+1}. [${c.id}] ${c.name}`));

  // Scrape first 10 companies via click-through
  const page1Results = [];
  for (let i = 0; i < Math.min(10, page1Links.length); i++) {
    const c = page1Links[i];
    try {
      const link = await page.$(`a[href*="/Company/${c.id}?"], a[href*="/Company/${c.id}"]`);
      if (!link) { console.log(`  ${i+1}. SKIP — link not found for ${c.id}`); continue; }
      // Filter out Industry links
      const href = await link.getAttribute('href');
      if (href.includes('/Company/Industry/')) { console.log(`  ${i+1}. SKIP — Industry link`); continue; }

      await link.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await sleep(2000);

      const detail = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const name = h1 ? h1.textContent.trim() : '';
        const phones = [...document.querySelectorAll('a[href^="tel:"]')].map(a => a.getAttribute('href').replace('tel:','').trim());
        // Filter out bia.ge's own emails from header/footer
        const BIA_EMAILS = ['sales@bia.ge', 'info@bia.ge'];
        const emails = [...document.querySelectorAll('a[href^="mailto:"]')]
          .map(a => a.getAttribute('href').replace('mailto:','').trim())
          .filter(e => !BIA_EMAILS.includes(e.toLowerCase()));
        return { name, phones: phones.join('; '), emails: emails.join('; '), url: location.href };
      });
      console.log(`  ${i+1}. ✓ ${detail.name} | ph: ${detail.phones || '-'} | em: ${detail.emails || '-'}`);
      page1Results.push(detail);

      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(1500);
    } catch (e) {
      console.log(`  ${i+1}. ERROR: ${e.message}`);
      // Try to recover
      try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }); await sleep(2000); } catch {}
    }
  }
  console.log(`\nPage 1 scraped: ${page1Results.length} companies`);

  // ── NAVIGATE TO PAGE 2 ──
  console.log('\n=== Navigating to PAGE 2 ===');

  // Dump current page state before navigation
  const beforeNav = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
  }));
  console.log(`Before nav — URL: ${beforeNav.url}, Title: ${beforeNav.title}`);

  // Navigate to page 2 using the actual pagination input (type="number", class="field-page-number")
  const navResult = await page.evaluate((targetPage) => {
    // The pagination input is type="number" with name="Filter.PageNumber"
    const pageInput = document.querySelector('input.field-page-number')
      || document.querySelector('input[name="Filter.PageNumber"]');
    if (!pageInput) return { success: false, reason: 'page input not found' };

    // Set native value via setter to trigger change detection
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSet.call(pageInput, targetPage);
    pageInput.dispatchEvent(new Event('input', { bubbles: true }));
    pageInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Find and click the GO button in the same paging container
    const container = pageInput.closest('.paging-info') || pageInput.parentElement;
    const goBtn = container?.querySelector('input[type="button"][value="GO"]');
    if (goBtn) {
      goBtn.click();
      return { success: true, method: 'field-page-number + GO click' };
    }

    // Fallback: submit the form
    const form = pageInput.closest('form');
    if (form) { form.submit(); return { success: true, method: 'form submit' }; }

    return { success: false, reason: 'GO button not found' };
  }, 2);

  console.log('Navigation result:', JSON.stringify(navResult, null, 2));

  // Wait for page to reload
  await sleep(4000);
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

  const afterNav = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodySnippet: document.body.innerText.slice(0, 300),
  }));
  console.log(`After nav — URL: ${afterNav.url}`);

  // Get company links on page 2
  const page2Links = await getCompanyLinks(page);
  console.log(`\n=== PAGE 2: ${page2Links.length} company links ===`);
  page2Links.forEach((c, i) => console.log(`  ${i+1}. [${c.id}] ${c.name}`));

  // Check if page 2 has different companies than page 1
  const page1Ids = new Set(page1Links.map(c => c.id));
  const newOnPage2 = page2Links.filter(c => !page1Ids.has(c.id));
  console.log(`\nNew companies on page 2 (not on page 1): ${newOnPage2.length}`);

  if (newOnPage2.length > 0) {
    // Scrape page 2 companies
    const page2Results = [];
    for (let i = 0; i < Math.min(10, page2Links.length); i++) {
      const c = page2Links[i];
      try {
        const link = await page.$(`a[href*="/Company/${c.id}?"], a[href*="/Company/${c.id}"]`);
        if (!link) { console.log(`  ${i+1}. SKIP — not found`); continue; }
        const href = await link.getAttribute('href');
        if (href.includes('/Company/Industry/')) { console.log(`  ${i+1}. SKIP — Industry link`); continue; }

        await link.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await sleep(2000);

        const detail = await page.evaluate(() => {
          const h1 = document.querySelector('h1');
          const name = h1 ? h1.textContent.trim() : '';
          const phones = [...document.querySelectorAll('a[href^="tel:"]')].map(a => a.getAttribute('href').replace('tel:','').trim());
          const BIA_EMAILS = ['sales@bia.ge', 'info@bia.ge'];
          const emails = [...document.querySelectorAll('a[href^="mailto:"]')]
            .map(a => a.getAttribute('href').replace('mailto:','').trim())
            .filter(e => !BIA_EMAILS.includes(e.toLowerCase()));
          return { name, phones: phones.join('; '), emails: emails.join('; '), url: location.href };
        });
        console.log(`  ${i+1}. ✓ ${detail.name} | ph: ${detail.phones || '-'} | em: ${detail.emails || '-'}`);
        page2Results.push(detail);

        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(1500);
      } catch (e) {
        console.log(`  ${i+1}. ERROR: ${e.message}`);
        try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }); await sleep(2000); } catch {}
      }
    }
    console.log(`\nPage 2 scraped: ${page2Results.length} companies`);
    console.log(`\n=== TOTAL: ${page1Results.length + page2Results.length} companies across 2 pages ===`);
  }

  await browser.close();
}

async function getCompanyLinks(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/Company/"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/Company\/(\d+)(?:\?|$)/);
      if (!m) return;
      if (/\/Company\/(Industry|IndustryCategor|Search|Create)/i.test(href)) return;
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        const name = (a.textContent || '').trim();
        if (name && name.length > 1) results.push({ id: m[1], name, href });
      }
    });
    return results;
  });
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
