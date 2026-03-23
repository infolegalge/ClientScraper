/**
 * Actually search enreg.reestri.gov.ge by ID code and capture the response
 */
const { chromium } = require('playwright');

const TEST_ID = '400003278'; // bautech

async function run() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Capture AJAX/XHR responses
  const ajaxResponses = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('reestri') && (url.includes('search') || url.includes('find') || url.includes('subject'))) {
      let body = '';
      try { body = await res.text(); } catch {}
      ajaxResponses.push({ url, status: res.status(), body: body.slice(0, 5000) });
    }
  });

  await page.goto('https://enreg.reestri.gov.ge/main.php?m=new_index&l=en', { waitUntil: 'networkidle', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Fill the ID code field
  await page.fill('#s_legal_person_idnumber', TEST_ID);
  await new Promise(r => setTimeout(r, 500));

  console.log('Filled ID code, now clicking Search...');

  // Find and click the search button in the s_search_persons_form
  await page.evaluate(() => {
    const form = document.getElementById('s_search_persons_form');
    if (form) {
      const btn = form.querySelector('input[type="submit"], button[type="submit"]');
      if (btn) { btn.click(); return 'clicked submit'; }
      // Try submitting the form directly
      form.submit();
      return 'form submitted';
    }
    return 'form not found';
  });

  // Wait for response
  await new Promise(r => setTimeout(r, 5000));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Check page content after search
  const results = await page.evaluate(() => {
    const body = document.body.innerText;
    const html = document.body.innerHTML;
    
    // Look for result tables
    const tables = [...document.querySelectorAll('table')];
    const tableData = tables.map((t, i) => ({
      index: i,
      rows: t.rows.length,
      text: t.innerText.slice(0, 1000),
    })).filter(t => t.rows > 1);

    // Look for result divs
    const resultDivs = [...document.querySelectorAll('div')]
      .filter(d => d.innerText.includes('400003278') || d.className.includes('result') || d.id.includes('result'))
      .map(d => ({ class: d.className, id: d.id, text: d.innerText.slice(0, 500) }));

    // Check for links with subject details
    const subjectLinks = [...document.querySelectorAll('a')]
      .filter(a => {
        const href = a.getAttribute('href') || '';
        return href.includes('subject') || href.includes('view') || href.includes('detail');
      })
      .map(a => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 100) }));

    return {
      currentUrl: location.href,
      hasIdInPage: body.includes('400003278'),
      bodySnippet: body.slice(0, 3000),
      tables: tableData,
      resultDivs: resultDivs.slice(0, 5),
      subjectLinks: subjectLinks.slice(0, 10),
    };
  });

  console.log('\n=== SEARCH RESULTS ===');
  console.log('URL:', results.currentUrl);
  console.log('Has ID in page:', results.hasIdInPage);
  
  if (results.tables.length > 0) {
    console.log('\nTables found:');
    results.tables.forEach(t => {
      console.log(`  Table ${t.index}: ${t.rows} rows`);
      console.log(`  Text: ${t.text}`);
    });
  }

  if (results.resultDivs.length > 0) {
    console.log('\nResult divs:');
    results.resultDivs.forEach(d => console.log(`  ${d.class || d.id}: ${d.text.slice(0, 300)}`));
  }

  if (results.subjectLinks.length > 0) {
    console.log('\nSubject links:');
    results.subjectLinks.forEach(l => console.log(`  ${l.text} → ${l.href}`));
  }

  console.log('\n=== AJAX RESPONSES ===');
  ajaxResponses.forEach(r => {
    console.log(`  ${r.status} ${r.url}`);
    console.log(`  Body (first 2000): ${r.body.slice(0, 2000)}`);
  });

  // Also just print first part of body text
  console.log('\n=== PAGE TEXT (first 2000 chars) ===');
  console.log(results.bodySnippet.slice(0, 2000));

  await browser.close();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
