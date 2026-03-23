const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  // Block heavy resources
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  // Try listing page for subcategory 3140
  const url = 'https://www.bia.ge/Company/Industry/3140';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  const title = await page.title();
  console.log('Title:', title);

  // Check for captcha
  const html = await page.content();
  console.log('Has captcha?', html.toLowerCase().includes('captcha') || html.toLowerCase().includes('recaptcha'));

  // Get all links that contain /Company/
  const links = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('a[href*="/Company/"]').forEach(a => {
      result.push({
        href: a.getAttribute('href'),
        text: (a.textContent || '').trim().substring(0, 80),
      });
    });
    return result;
  });

  console.log('\nAll /Company/ links on page:', links.length);
  links.forEach((l, i) => console.log(`  ${i}: ${l.href} => "${l.text}"`));

  // Get page text snippet
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').substring(0, 2000));
  console.log('\n--- BODY TEXT (first 2000 chars) ---');
  console.log(bodyText);

  // Also check with ServiceCategoryId
  const url2 = 'https://www.bia.ge/Company/Industry/3140?ServiceCategoryId=86';
  console.log('\n\nNavigating to:', url2);
  await page.goto(url2, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  console.log('Current URL:', page.url());
  const links2 = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('a[href*="/Company/"]').forEach(a => {
      result.push({
        href: a.getAttribute('href'),
        text: (a.textContent || '').trim().substring(0, 80),
      });
    });
    return result;
  });
  console.log('Links with ServiceCategoryId:', links2.length);
  links2.slice(0, 5).forEach((l, i) => console.log(`  ${i}: ${l.href} => "${l.text}"`));

  const paginationText = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const lines = body.split('\n').filter(l => l.includes('/') && (l.includes('GO') || l.includes('\u10e1\u10e3\u10da')));
    return lines.join('\n');
  });
  console.log('\nPagination text:', paginationText || 'NOT FOUND');

  await browser.close();
})();
