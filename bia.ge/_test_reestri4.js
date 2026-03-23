/**
 * Final test: Use Playwright to search and carefully capture the POST/AJAX flow
 */
const { chromium } = require('playwright');

const TEST_ID = '400003278';

async function run() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Capture ALL requests with full details
  const networkLog = [];
  page.on('request', (req) => {
    if (req.url().includes('reestri.gov.ge/main.php')) {
      networkLog.push({
        type: 'REQ',
        method: req.method(),
        url: req.url(),
        postData: req.postData() || null,
        resourceType: req.resourceType(),
      });
    }
  });
  page.on('response', async (res) => {
    if (res.url().includes('reestri.gov.ge/main.php')) {
      let body = '';
      try { body = await res.text(); } catch {}
      networkLog.push({
        type: 'RES',
        url: res.url(),
        status: res.status(),
        contentType: res.headers()['content-type'],
        bodyLen: body.length,
        hasId: body.includes(TEST_ID),
        bodySnippet: body.includes(TEST_ID) ? body.slice(0, 3000) : body.slice(0, 200),
      });
    }
  });

  console.log('1. Loading page...');
  await page.goto('https://enreg.reestri.gov.ge/main.php?m=new_index&l=en', { waitUntil: 'networkidle' });
  await new Promise(r => setTimeout(r, 1000));

  // Log cookies
  const cookies = await page.context().cookies();
  const sessCookie = cookies.find(c => c.name === 'PHPSESSID');
  console.log(`Session cookie: ${sessCookie ? sessCookie.value.slice(0, 10) + '...' : 'NONE'}`);

  console.log('2. Filling ID code...');
  await page.fill('#s_legal_person_idnumber', TEST_ID);
  
  // Clear the network log before search
  networkLog.length = 0;

  console.log('3. Submitting search...');
  // Click the search/submit in the persons form
  await Promise.all([
    page.waitForResponse(res => res.url().includes('reestri.gov.ge'), { timeout: 15000 }).catch(() => null),
    page.click('#s_search_persons_form input[type="submit"]'),
  ]);
  
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n=== NETWORK LOG (after search) ===');
  networkLog.forEach((entry, i) => {
    if (entry.type === 'REQ') {
      console.log(`\n[${i}] ${entry.method} ${entry.url}`);
      if (entry.postData) console.log(`    POST data: ${entry.postData}`);
    } else {
      console.log(`[${i}] → ${entry.status} (${entry.contentType}) len=${entry.bodyLen} hasId=${entry.hasId}`);
      if (entry.hasId) {
        // Parse HTML to extract useful data
        const text = entry.bodySnippet.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/\s+/g, ' ');
        console.log(`    Content: ${text.slice(0, 500)}`);
      }
    }
  });

  // Now check if there's a detail/view link for the subject
  const links = await page.evaluate(() => {
    return [...document.querySelectorAll('a')].map(a => ({
      href: a.getAttribute('href'),
      text: (a.textContent || '').trim().slice(0, 80),
      onclick: a.getAttribute('onclick')?.slice(0, 200),
    })).filter(a => a.href?.includes('main.php') || a.onclick);
  });
  
  console.log('\n=== CLICKABLE LINKS ON RESULT PAGE ===');
  links.forEach(l => {
    if (l.onclick) console.log(`  onclick: ${l.onclick} | text: ${l.text}`);
    else if (l.href) console.log(`  href: ${l.href} | text: ${l.text}`);
  });

  // Check if clicking the result row leads to a detail page
  const resultRow = await page.evaluate(() => {
    const tds = [...document.querySelectorAll('td')];
    const idTd = tds.find(td => td.textContent.includes('400003278'));
    if (idTd) {
      const row = idTd.closest('tr');
      const onclick = row?.getAttribute('onclick') || '';
      const rowLinks = [...(row?.querySelectorAll('a') || [])].map(a => ({
        href: a.getAttribute('href'),
        onclick: a.getAttribute('onclick')?.slice(0, 200),
      }));
      return { onclick, rowLinks, rowHTML: row?.innerHTML?.slice(0, 500) };
    }
    return null;
  });
  
  if (resultRow) {
    console.log('\n=== RESULT ROW ===');
    console.log('Row onclick:', resultRow.onclick);
    console.log('Row links:', JSON.stringify(resultRow.rowLinks, null, 2));
    console.log('Row HTML:', resultRow.rowHTML);
  }

  await browser.close();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
