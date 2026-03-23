/**
 * Probe enreg.reestri.gov.ge for API endpoints.
 * Search by identification code and capture network requests.
 */
const { chromium } = require('playwright');

const TEST_ID = '400003278'; // bautech from bia.ge

async function run() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Capture all network requests
  const requests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('reestri') && !url.endsWith('.css') && !url.endsWith('.js') && !url.endsWith('.png') && !url.endsWith('.gif') && !url.endsWith('.ico')) {
      requests.push({
        method: req.method(),
        url: url,
        postData: req.postData() || null,
        headers: req.headers(),
      });
    }
  });

  // Capture responses
  const responses = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('reestri') && !url.endsWith('.css') && !url.endsWith('.js') && !url.endsWith('.png') && !url.endsWith('.gif') && !url.endsWith('.ico')) {
      let body = '';
      try { body = await res.text(); } catch {}
      if (body.length > 0 && body.length < 50000) {
        responses.push({ url, status: res.status(), contentType: res.headers()['content-type'], bodySnippet: body.slice(0, 2000) });
      }
    }
  });

  console.log('Loading page...');
  await page.goto('https://enreg.reestri.gov.ge/main.php?m=new_index&l=en', { waitUntil: 'networkidle', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Log page JS functions related to search
  const searchFunctions = await page.evaluate(() => {
    const fns = [];
    // Check for global search-related functions
    for (const key of Object.keys(window)) {
      if (typeof window[key] === 'function' && /search|find|subject|query/i.test(key)) {
        fns.push(key);
      }
    }
    // Check jQuery AJAX setup
    if (window.jQuery || window.$) fns.push('jQuery_available');
    // Check for form action
    const forms = [...document.querySelectorAll('form')];
    forms.forEach((f, i) => {
      fns.push(`form_${i}: action=${f.action}, method=${f.method}, id=${f.id}`);
    });
    return fns;
  });
  console.log('\nSearch-related functions/forms:', searchFunctions);

  // Try to find the search form and fill it
  console.log('\nFilling search form with ID:', TEST_ID);

  // Look for the ID code input and fill it
  const filled = await page.evaluate((idCode) => {
    // Try various selectors
    const selectors = [
      'input[name="id_code"]',
      'input[name="identificationCode"]',
      'input[name="idCode"]',
      'input[placeholder*="Identif"]',
      'input[placeholder*="საიდენტიფიკაციო"]',
    ];
    for (const sel of selectors) {
      const input = document.querySelector(sel);
      if (input) {
        input.value = idCode;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { found: true, selector: sel, name: input.name, id: input.id };
      }
    }
    // Try all text inputs
    const allInputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
    return {
      found: false,
      allInputs: allInputs.map(i => ({
        name: i.name, id: i.id, placeholder: i.placeholder,
        label: i.closest('label')?.textContent?.trim()?.slice(0, 50) || '',
        parentText: i.parentElement?.textContent?.trim()?.slice(0, 80) || '',
      })),
    };
  }, TEST_ID);
  console.log('Fill result:', JSON.stringify(filled, null, 2));

  if (filled.found) {
    // Click search button
    console.log('\nClicking search...');
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('input[type="submit"], button[type="submit"], input[value="Search"], input[value="ძებნა"]')];
      for (const btn of btns) {
        const text = (btn.value || btn.textContent || '').trim();
        if (text.includes('Search') || text.includes('ძებნა') || text.includes('Resest') === false) {
          btn.click();
          return { clicked: true, text };
        }
      }
      return { clicked: false, btns: btns.map(b => b.value || b.textContent) };
    });
    console.log('Click result:', clicked);

    // Wait for results
    await new Promise(r => setTimeout(r, 5000));
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  // Dump all captured requests
  console.log('\n=== NETWORK REQUESTS ===');
  for (const req of requests) {
    console.log(`  ${req.method} ${req.url}`);
    if (req.postData) console.log(`    POST: ${req.postData.slice(0, 500)}`);
  }

  console.log('\n=== NETWORK RESPONSES (with body) ===');
  for (const res of responses) {
    console.log(`  ${res.status} ${res.url}`);
    console.log(`    Type: ${res.contentType}`);
    if (res.bodySnippet.includes(TEST_ID) || res.bodySnippet.includes('bautech') || res.bodySnippet.includes('json')) {
      console.log(`    Body: ${res.bodySnippet.slice(0, 1000)}`);
    }
  }

  // Check for results on page
  const pageContent = await page.evaluate(() => {
    const body = document.body.innerText;
    const tables = [...document.querySelectorAll('table')];
    return {
      hasResults: body.includes('400003278') || body.includes('bautech'),
      tableCount: tables.length,
      visibleText: body.slice(0, 3000),
    };
  });
  console.log('\n=== PAGE RESULTS ===');
  console.log('Has our ID:', pageContent.hasResults);
  console.log('Tables:', pageContent.tableCount);
  if (pageContent.hasResults) {
    console.log('Text snippet:', pageContent.visibleText.slice(0, 1500));
  }

  await browser.close();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
