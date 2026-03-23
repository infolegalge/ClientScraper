const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  const url = 'https://www.bia.ge/Company/Industry/3140?ServiceCategoryId=86';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  // ═══ 1. Examine pagination area DOM ═══
  console.log('\n═══ PAGINATION DOM ANALYSIS ═══');
  
  const paginationInfo = await page.evaluate(() => {
    const result = {};
    
    // Find all text inputs
    const inputs = document.querySelectorAll('input[type="text"]');
    result.textInputs = [];
    inputs.forEach((input, i) => {
      const parent = input.parentElement;
      const container = input.closest('div') || parent;
      result.textInputs.push({
        index: i,
        id: input.id,
        name: input.name,
        value: input.value,
        parentTag: parent?.tagName,
        parentHTML: parent?.outerHTML?.substring(0, 500),
        containerText: (container?.textContent || '').substring(0, 200),
        hasSul: (container?.textContent || '').includes('სულ'),
        hasSlash: (container?.textContent || '').includes('/'),
      });
    });
    
    // Find all buttons near pagination
    result.allButtons = [];
    document.querySelectorAll('input[type="button"], input[type="submit"], button').forEach((btn, i) => {
      result.allButtons.push({
        index: i,
        tag: btn.tagName,
        type: btn.type,
        value: btn.value || '',
        text: (btn.textContent || '').trim(),
        id: btn.id,
        name: btn.name,
        onclick: btn.getAttribute('onclick')?.substring(0, 200) || '',
        parentHTML: btn.parentElement?.outerHTML?.substring(0, 300) || '',
      });
    });
    
    // Find links with "შემდეგი" (Next) or "წინა" (Previous)
    result.navLinks = [];
    document.querySelectorAll('a').forEach(a => {
      const text = (a.textContent || '').trim();
      if (text.includes('შემდეგი') || text.includes('წინა') || text === '>' || text === '<' || text === '>>' || text === '<<') {
        result.navLinks.push({
          text,
          href: a.getAttribute('href')?.substring(0, 200) || '',
          onclick: a.getAttribute('onclick')?.substring(0, 200) || '',
        });
      }
    });
    
    // Get the full pagination container HTML
    // Look for the element containing "სულ" (total)
    const allElements = document.querySelectorAll('*');
    let paginationEl = null;
    for (const el of allElements) {
      const directText = el.childNodes.length > 0 ? 
        [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') : '';
      if (directText.includes('სულ') && directText.includes('/')) {
        paginationEl = el;
        break;
      }
    }
    if (!paginationEl) {
      // Try broader search
      for (const el of allElements) {
        if ((el.textContent || '').includes('სულ') && (el.textContent || '').includes('/') && el.children.length < 10) {
          paginationEl = el;
          break;
        }
      }
    }
    
    if (paginationEl) {
      result.paginationContainer = {
        tag: paginationEl.tagName,
        id: paginationEl.id,
        outerHTML: paginationEl.outerHTML?.substring(0, 1000),
        childCount: paginationEl.children.length,
      };
    }
    
    // Check for forms
    result.forms = [];
    document.querySelectorAll('form').forEach((form, i) => {
      result.forms.push({
        index: i,
        id: form.id,
        action: form.action?.substring(0, 200) || '',
        method: form.method || '',
        childInputCount: form.querySelectorAll('input').length,
      });
    });
    
    // Check for __doPostBack (ASP.NET)
    result.hasDoPostBack = typeof window.__doPostBack === 'function';
    
    return result;
  });

  console.log('\n--- Text Inputs ---');
  paginationInfo.textInputs.forEach(i => {
    console.log(`  [${i.index}] id="${i.id}" name="${i.name}" value="${i.value}"`);
    console.log(`    hasSul=${i.hasSul} hasSlash=${i.hasSlash}`);
    console.log(`    parentHTML: ${i.parentHTML?.substring(0, 200)}`);
  });
  
  console.log('\n--- Buttons ---');
  paginationInfo.allButtons.forEach(b => {
    console.log(`  [${b.index}] <${b.tag}> type="${b.type}" value="${b.value}" text="${b.text}" id="${b.id}"`);
    console.log(`    onclick: ${b.onclick}`);
  });
  
  console.log('\n--- Nav Links ---');
  paginationInfo.navLinks.forEach(l => {
    console.log(`  "${l.text}" href="${l.href}" onclick="${l.onclick}"`);
  });
  
  console.log('\n--- Pagination Container ---');
  if (paginationInfo.paginationContainer) {
    console.log(`  Tag: ${paginationInfo.paginationContainer.tag}`);
    console.log(`  HTML: ${paginationInfo.paginationContainer.outerHTML}`);
  } else {
    console.log('  NOT FOUND');
  }
  
  console.log('\n--- Forms ---');
  paginationInfo.forms.forEach(f => {
    console.log(`  [${f.index}] id="${f.id}" action="${f.action}" method="${f.method}" inputs=${f.childInputCount}`);
  });
  
  console.log('\n--- __doPostBack ---');
  console.log(`  Available: ${paginationInfo.hasDoPostBack}`);

  // ═══ 2. Try to navigate to page 2 and see what changes ═══
  console.log('\n\n═══ ATTEMPTING PAGE 2 NAVIGATION ═══');
  
  // Get page 1 company links for comparison
  const page1Links = await page.evaluate(() => {
    return [...document.querySelectorAll('a[href*="/Company/"]')]
      .map(a => a.getAttribute('href'))
      .filter(h => /\/Company\/\d+/.test(h) && !/\/Company\/(Industry|IndustryCategor)/.test(h))
      .slice(0, 3);
  });
  console.log('Page 1 sample links:', page1Links);

  // Method 1: Try using Playwright's fill + click instead of evaluate
  const paginationInput = await page.$('input[type="text"]');
  if (paginationInput) {
    console.log('\nFound text input, attempting Playwright fill...');
    await paginationInput.fill('2');
    await new Promise(r => setTimeout(r, 500));
    
    // Look for GO button
    const goBtn = await page.$('input[type="button"][value*="GO"]')
      || await page.$('input[type="button"]')
      || await page.$('button');
    if (goBtn) {
      const btnVal = await goBtn.getAttribute('value') || await goBtn.textContent();
      console.log(`Found button: "${btnVal}"`);
      await goBtn.click();
      console.log('Clicked GO, waiting...');
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => console.log('  networkidle timeout'));
      await new Promise(r => setTimeout(r, 3000));
      
      const page2Links = await page.evaluate(() => {
        return [...document.querySelectorAll('a[href*="/Company/"]')]
          .map(a => a.getAttribute('href'))
          .filter(h => /\/Company\/\d+/.test(h) && !/\/Company\/(Industry|IndustryCategor)/.test(h))
          .slice(0, 3);
      });
      console.log('Page 2 sample links:', page2Links);
      console.log('Different from page 1?', JSON.stringify(page1Links) !== JSON.stringify(page2Links));
    } else {
      console.log('No GO button found!');
    }
  }
  
  await browser.close();
})();
