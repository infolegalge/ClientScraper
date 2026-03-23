/**
 * bia.ge Full Directory Scraper — Click-Through Approach
 * ========================================================
 * Scrapes companies from bia.ge by browsing naturally through the site:
 *   listing page → click company → extract → go back → click next
 *
 * Why click-through? bia.ge has aggressive anti-bot protection. Plain HTTP
 * requests and even direct Playwright URL visits trigger captcha. But natural
 * click-through navigation from listing pages (with VisitCompanyType=3 param)
 * mimics real user behavior and stays under the radar.
 *
 * Usage:
 *   node scraper.js --list-categories              # Discover all categories
 *   node scraper.js --all                           # Scrape ALL categories
 *   node scraper.js --category 70                   # One main category
 *   node scraper.js --category 70,64,66             # Multiple categories
 *   node scraper.js --subcategory 2809              # One subcategory
 *   node scraper.js --subcategory 2809,2797         # Multiple subcategories
 *   node scraper.js --headed                        # Show browser
 *   node scraper.js --delay 4000                    # Base delay ms (default 4s)
 *   node scraper.js --out ./output                  # Output directory
 *   node scraper.js --resume                        # Resume from checkpoint
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════
//  CLI ARGS
// ═══════════════════════════════════════════
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const param = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const DELAY = parseInt(param('delay', '4000'), 10);
const HEADED = flag('headed');
const LIST_CATEGORIES = flag('list-categories');
const SCRAPE_ALL = flag('all');
const CATEGORY_ARG = param('category', '');
const SUBCATEGORY_ARG = param('subcategory', '');
const OUT_DIR = param('out', path.join(__dirname, 'output'));
const RESUME = flag('resume');

const BASE = 'https://www.bia.ge';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Human-like random delay: base ±50%
function humanDelay(baseMs) {
  const min = baseMs * 0.5;
  const max = baseMs * 1.5;
  const ms = min + Math.random() * (max - min);
  return sleep(Math.round(ms));
}

// Longer random delay for between-page navigation
function longDelay() {
  return sleep(3000 + Math.random() * 5000); // 3–8 seconds
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function saveJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
}
function saveCSV(fp, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))];
  fs.writeFileSync(fp, '\uFEFF' + lines.join('\n'), 'utf-8');
}
function loadCheckpoint(fp) {
  if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return null;
}
const LOG_FILE = path.join(__dirname, 'scraper.log');
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
}
function safeName(name) {
  return (name || 'unknown').replace(/[^a-zA-Z0-9\u10D0-\u10FF]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

// Detect captcha/block page — only check for VISIBLE captcha elements.
// bia.ge HTML may contain "captcha"/"recaptcha" strings in scripts/comments
// without showing an actual captcha overlay — do NOT match on raw HTML strings.
async function isCaptchaPage(page) {
  try {
    return await page.evaluate(() => {
      // Check for visible reCAPTCHA / hCaptcha iframes or containers
      const selectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '.g-recaptcha:not([style*="display: none"])',
        '.h-captcha:not([style*="display: none"])',
        '#captcha-container',
        '[data-sitekey]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return true;   // visible
      }
      // Check for a blocking overlay that covers the page
      const overlay = document.querySelector('.challenge-platform, #challenge-running');
      if (overlay && overlay.offsetParent !== null) return true;
      return false;
    });
  } catch { return false; }
}

// Wait for captcha to be solved manually (when --headed)
async function waitForCaptcha(page) {
  if (!HEADED) {
    log('    CAPTCHA detected in headless mode — cannot solve automatically.');
    log('    Re-run with --headed to solve manually, or wait for auto-retry...');
    await sleep(30000); // wait 30s and hope it clears
    return;
  }
  log('    CAPTCHA detected — please solve it in the browser window...');
  // Wait up to 5 minutes for captcha to be solved
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    if (!(await isCaptchaPage(page))) {
      log('    CAPTCHA solved! Resuming...');
      return;
    }
  }
  log('    CAPTCHA timeout — continuing anyway...');
}

// ═══════════════════════════════════════════
//  PHASE 1: DISCOVER MAIN CATEGORIES
// ═══════════════════════════════════════════
async function discoverMainCategories(page) {
  log('Discovering main categories...');
  await page.goto(`${BASE}/Company/IndustryCategories`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanDelay(DELAY);

  if (await isCaptchaPage(page)) await waitForCaptcha(page);

  return page.evaluate(() => {
    const cats = [];
    document.querySelectorAll('a[href*="/Company/IndustryCategory/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/Company\/IndustryCategory\/(\d+)/);
      if (!m) return;
      const id = m[1];
      const fullText = (a.textContent || '').trim();
      const cm = fullText.match(/^(.+?)\s+([\d\s]+)\s*კომპანია$/);
      const name = cm ? cm[1].trim() : fullText;
      const companyCount = cm ? parseInt(cm[2].replace(/\s/g, ''), 10) : 0;
      if (name && !cats.find((c) => c.id === id)) cats.push({ id, name, companyCount, url: m[0] });
    });
    return cats;
  });
}

// ═══════════════════════════════════════════
//  PHASE 2: DISCOVER SUBCATEGORIES
// ═══════════════════════════════════════════
async function discoverSubcategories(page, mainCategoryId, mainCategoryName) {
  log(`  Subcategories for [${mainCategoryId}] ${mainCategoryName}...`);
  await page.goto(`${BASE}/Company/IndustryCategory/${mainCategoryId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanDelay(DELAY);

  if (await isCaptchaPage(page)) await waitForCaptcha(page);

  const subs = await page.evaluate((parentId) => {
    const result = [];
    document.querySelectorAll('a[href*="/Company/Industry/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/Company\/Industry\/(\d+)/);
      if (!m) return;
      const id = m[1];
      const fullText = (a.textContent || '').trim();
      const cm = fullText.match(/^(.+?)\s*\[(\d+)\]$/);
      const name = cm ? cm[1].trim() : fullText;
      const companyCount = cm ? parseInt(cm[2], 10) : 0;
      if (name && !result.find((s) => s.id === id)) {
        result.push({ id, name, companyCount, parentCategoryId: parentId, url: m[0] });
      }
    });
    return result;
  }, mainCategoryId);

  const nonEmpty = subs.filter((s) => s.companyCount > 0);
  log(`  Found ${nonEmpty.length} non-empty subcategories (${nonEmpty.reduce((s, c) => s + c.companyCount, 0)} companies)`);
  return nonEmpty;
}

// ═══════════════════════════════════════════
//  PHASE 3+4: SCRAPE LISTINGS + DETAILS (CLICK-THROUGH)
// ═══════════════════════════════════════════
//  For each subcategory:
//    1. Load subcategory listing page
//    2. For each company link on the page:
//       a. Click the link (natural navigation with VisitCompanyType param)
//       b. Extract all detail data from the company page
//       c. Go back to listing page
//    3. Paginate to next page and repeat
//
//  This click-through pattern mimics a real user browsing the directory.
async function scrapeSubcategory(page, subcategory, globalSeen, checkpointDir) {
  const { id: subId, parentCategoryId, name: subName, companyCount } = subcategory;
  log(`    Scraping: "${subName}" (Industry/${subId}, ~${companyCount} companies)`);

  const results = [];
  const failed = [];

  // Load checkpoint
  const cpPath = path.join(checkpointDir, `checkpoint_${subId}.json`);
  const doneIds = new Set();
  if (RESUME) {
    const cp = loadCheckpoint(cpPath);
    if (cp) {
      results.push(...cp.results);
      cp.results.forEach((r) => doneIds.add(String(r.biaId)));
      log(`    Resumed: ${results.length} already scraped`);
    }
  }

  // Navigate to subcategory listing
  const listUrl = parentCategoryId
    ? `${BASE}/Company/Industry/${subId}?ServiceCategoryId=${parentCategoryId}`
    : `${BASE}/Company/Industry/${subId}`;
  try {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(DELAY);
  } catch (e) {
    log(`    Failed to load listing: ${e.message}`);
    return { results, failed };
  }

  if (await isCaptchaPage(page)) await waitForCaptcha(page);

  // Debug: log current URL and page title
  log(`    URL: ${page.url()}`);
  const pageTitle = await page.title().catch(() => '?');
  log(`    Title: ${pageTitle}`);

  // Set page limit to 200 to reduce pagination
  try {
    await page.evaluate(() => {
      const sel = document.querySelector('select.page-limits-box, select[name="Filter.PageLimit"]');
      if (sel) {
        const nativeSet = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        nativeSet.call(sel, '200');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await humanDelay(DELAY + 500);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  } catch (e) {
    log(`    Could not set page limit: ${e.message}`);
  }

  // Get total pages (after page limit increase)
  const totalPages = await page.evaluate(() => {
    const body = document.body.innerText || '';
    const m1 = body.match(/(\d+)\s*\/\s*(\d+)\s*\(\s*\u10e1\u10e3\u10da/);
    if (m1) return parseInt(m1[2], 10);
    const m2 = body.match(/\/\s*(\d+)\s*\(\s*\u10e1\u10e3\u10da/);
    if (m2) return parseInt(m2[1], 10);
    const m3 = body.match(/\u10e1\u10e3\u10da[:\s]*(\d+)\s*\u10d9\u10dd\u10db\u10de/);
    if (m3) return Math.ceil(parseInt(m3[1], 10) / 200);
    return 1;
  });
  log(`    Pages: ${totalPages} (limit 200)`);

  // Process each page
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    // Navigate to page (except page 1 — we're already there)
    if (pageNum > 1) {
      try {
        const navigated = await page.evaluate((pg) => {
          // Use the actual pagination input: type="number", class="field-page-number"
          const pageInput = document.querySelector('input.field-page-number')
            || document.querySelector('input[name="Filter.PageNumber"]');
          if (pageInput) {
            const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSet.call(pageInput, pg);
            pageInput.dispatchEvent(new Event('input', { bubbles: true }));
            pageInput.dispatchEvent(new Event('change', { bubbles: true }));
            const container = pageInput.closest('.paging-info') || pageInput.parentElement;
            const goBtn = container?.querySelector('input[type="button"][value="GO"]');
            if (goBtn) { goBtn.click(); return true; }
            const form = pageInput.closest('form');
            if (form) { form.submit(); return true; }
          }
          return false;
        }, pageNum);

        if (navigated) {
          await humanDelay(DELAY + 1000);
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }
      } catch (e) {
        log(`    Page ${pageNum}: navigation error — ${e.message}`);
        break;
      }

      if (await isCaptchaPage(page)) await waitForCaptcha(page);
    }

    // Get all company links on this page
    const companyLinks = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/Company/"]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        // Match /Company/{digits} with or without query params
        const m = href.match(/\/Company\/(\d+)(?:\?|$)/);
        if (!m) return;
        // Exclude IndustryCategory, Industry links, search, etc.
        if (/\/Company\/(Industry|IndustryCategor|Search|Create)/i.test(href)) return;
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          const name = (a.textContent || '').trim();
          if (name && name.length > 1) {
            results.push({ id: m[1], name, href });
          }
        }
      });
      return results;
    });

    log(`    Page ${pageNum}/${totalPages}: ${companyLinks.length} companies`);

    // Click through each company on this page
    for (let ci = 0; ci < companyLinks.length; ci++) {
      const company = companyLinks[ci];

      // Skip already-scraped (checkpoint) or cross-subcategory dupes
      if (doneIds.has(company.id) || globalSeen.has(company.id)) {
        continue;
      }

      try {
        // CLICK the company link — this navigates naturally with all tracking params
        // Use the exact href from the listing to avoid matching wrong links
        const link = await page.$(`a[href="${company.href}"]`)
          || await page.$(`a[href*="/Company/${company.id}?"]`)
          || await page.$(`a[href$="/Company/${company.id}"]`);
        if (!link) {
          log(`      [${ci + 1}/${companyLinks.length}] ${company.name} — link not found, skipping`);
          failed.push(company);
          continue;
        }

        await link.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
        await humanDelay(DELAY);

        if (await isCaptchaPage(page)) await waitForCaptcha(page);

        // Extract company detail
        const detail = await extractCompanyDetail(page, company.id);

        if (detail) {
          results.push(detail);
          doneIds.add(company.id);
          globalSeen.add(company.id);

          const hasContact = detail.emails || detail.phones;
          log(`      [${ci + 1}/${companyLinks.length}] ${detail.name} ${hasContact ? '✓' : '○'}`);
        } else {
          failed.push(company);
          log(`      [${ci + 1}/${companyLinks.length}] ${company.name} — extraction failed`);
        }

        // GO BACK to listing page
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await humanDelay(DELAY * 0.7);   // slightly shorter delay on back navigation

      } catch (e) {
        log(`      [${ci + 1}/${companyLinks.length}] ${company.name} — error: ${e.message}`);
        failed.push(company);

        // Try to recover by navigating back to listing
        try {
          // Check if we're still on a company page or lost
          const currentUrl = page.url();
          if (!currentUrl.includes('/Company/Industry/')) {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            await humanDelay(DELAY);
          }
        } catch {
          // Last resort: navigate directly to the listing page
          try {
            await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await humanDelay(DELAY);
            // Re-navigate to the correct page
            if (pageNum > 1) {
              await page.evaluate((pg) => {
                const pageInput = document.querySelector('input.field-page-number')
                  || document.querySelector('input[name="Filter.PageNumber"]');
                if (pageInput) {
                  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                  nativeSet.call(pageInput, pg);
                  pageInput.dispatchEvent(new Event('input', { bubbles: true }));
                  pageInput.dispatchEvent(new Event('change', { bubbles: true }));
                  const container = pageInput.closest('.paging-info') || pageInput.parentElement;
                  const goBtn = container?.querySelector('input[type="button"][value="GO"]');
                  if (goBtn) goBtn.click();
                }
              }, pageNum);
              await humanDelay(DELAY + 1000);
              await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            }
          } catch {
            log(`    Lost navigation — skipping rest of page ${pageNum}`);
            break;
          }
        }
      }

      // Checkpoint every 15 companies
      if (results.length > 0 && results.length % 15 === 0) {
        saveJSON(cpPath, { results, timestamp: new Date().toISOString() });
      }
    }

    // Between-page longer delay
    if (pageNum < totalPages) {
      await longDelay();
    }

    log(`    Page ${pageNum} done. Total so far: ${results.length} scraped, ${failed.length} failed`);
  }

  // Final checkpoint save
  if (results.length > 0) {
    saveJSON(cpPath, { results, timestamp: new Date().toISOString() });
  }

  log(`    Subcategory "${subName}" complete: ${results.length} companies, ${failed.length} failed`);
  return { results, failed };
}

// ═══════════════════════════════════════════
//  EXTRACT COMPANY DETAIL FROM CURRENT PAGE
// ═══════════════════════════════════════════
async function extractCompanyDetail(page, companyId) {
  try {
    return await page.evaluate((cId) => {
      const text = (el) => (el ? el.textContent.trim() : '');
      const body = document.body.innerText || '';

      // ═══ NAME ═══
      let name = '';
      const h1 = document.querySelector('h1');
      if (h1) name = text(h1);
      if (!name) name = (document.title || '').split('|')[0].split('-')[0].trim();

      // ═══ BRANDS ═══
      let brands = '';
      const brandM = body.match(/(?:სავაჭრო მარკ(?:ებ)?ი|Brand|Trade\s*mark)[:\s]*([^\n\r]+)/i);
      if (brandM) brands = brandM[1].trim();

      // ═══ LEGAL NAME ═══
      let legalName = '';
      const legalM = body.match(/(?:იურიდიული\s*(?:სახელი|დასახელება)|Legal\s*name)[:\s]*([^\n\r]+)/i);
      if (legalM) legalName = legalM[1].trim();

      // ═══ IDENTIFICATION NUMBER ═══
      let identificationNumber = '';
      const idM = body.match(/(?:საიდენტიფიკაციო\s*(?:კოდი|ნომერი)|Identification\s*(?:number|code))[:\s]*(\d+)/i);
      if (idM) identificationNumber = idM[1];

      // ═══ ADDRESS ═══
      let address = '';
      const addrM = body.match(/(?:მისამართი|Address)[:\s]*([^\n\r]+)/i);
      if (addrM) address = addrM[1].trim();

      // ═══ CITY ═══
      let city = '';
      const cityM = body.match(/(?:ქალაქი|City)[:\s]*([^\n\r]+)/i);
      if (cityM) city = cityM[1].trim();

      // ═══ PHONES ═══
      const phones = [];
      document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
        const p = a.getAttribute('href').replace('tel:', '').trim();
        if (p && !phones.includes(p)) phones.push(p);
      });
      const telM = body.match(/(?:ტელ(?:ეფონი)?|Tel|Phone)[:\s]+([^\n\r]+)/i);
      if (telM) {
        const raw = telM[1].replace(/(?:ფაქსი|Fax|ელ\.\s*ფოსტა|E-?mail).*/i, '');
        raw.split(/[,;]/).map((s) => s.trim()).filter((s) => s.match(/[\d()+]/))
          .forEach((n) => { if (!phones.includes(n)) phones.push(n); });
      }

      // ═══ FAX ═══
      let fax = '';
      const faxM = body.match(/(?:ფაქსი|Fax)[:\s]*([^\n\r]+)/i);
      if (faxM) fax = faxM[1].trim().split(/[,;]/)[0].trim();

      // ═══ EMAILS ═══
      const BIA_OWN = ['sales@bia.ge','info@bia.ge','marketing@bia.ge'];
      const emails = [];
      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        const e = a.getAttribute('href').replace('mailto:', '').trim();
        if (e && !emails.includes(e) && !BIA_OWN.includes(e.toLowerCase())) emails.push(e);
      });
      const emM = body.match(/(?:ელ\.\s*ფოსტა|E-?mail)[:\s]*([^\n\r]+)/i);
      if (emM) {
        const found = emM[1].match(/[\w.+-]+@[\w.-]+\.\w{2,}/g);
        if (found) found.forEach((e) => { if (!emails.includes(e) && !BIA_OWN.includes(e.toLowerCase())) emails.push(e); });
      }

      // ═══ LINKS ═══
      const allLinks = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');

      // ═══ WEBSITE ═══
      let website = '';
      const webM = body.match(/(?:ვებ-?გვერდი|Website|Web)[:\s]*(https?:\/\/[^\s\n\r]+)/i);
      if (webM) website = webM[1].trim();
      if (!website) {
        const SKIP = ['bia.ge','facebook.com','google.com','instagram.com','youtube.com','twitter.com','tiktok.com','linkedin.com','viber:','wa.me','whatsapp','yell.ge','follower.ge'];
        for (const href of allLinks) {
          if (/^https?:\/\//.test(href) && href.length < 200 && !SKIP.some((s) => href.includes(s))) {
            website = href; break;
          }
        }
      }

      // ═══ SOCIAL ═══
      let facebook = '', instagram = '', linkedin = '', youtube = '';
      const FB_SKIP = ['oauth','dialog','login','plugins','sharer','share.php'];
      for (const href of allLinks) {
        if (!facebook && href.includes('facebook.com') && !FB_SKIP.some((s) => href.includes(s))) facebook = href;
        if (!instagram && href.includes('instagram.com')) instagram = href;
        if (!linkedin && href.includes('linkedin.com') && !href.includes('bia')) linkedin = href;
        if (!youtube && href.includes('youtube.com') && !href.includes('UC3mytJCNtD8')) youtube = href;
      }

      // ═══ CATEGORIES ═══
      const categories = [];
      const catM = body.match(/(?:საქმიანობის\s*სფერო(?:ები)?|Activity|Activities)[:\s]*([^\n\r]+)/i);
      if (catM) catM[1].split(/[,;|]/).forEach((c) => { const t = c.trim(); if (t.length > 1) categories.push(t); });
      document.querySelectorAll('a[href*="/Company/Industry/"]').forEach((a) => {
        const t = (a.textContent || '').trim();
        if (t.length > 2 && !categories.includes(t)) categories.push(t);
      });

      // ═══ COMPANY SIZE / YEAR / EMPLOYEES ═══
      let companySize = '', yearFounded = '', employees = '';
      const sizeM = body.match(/(?:კომპანიის\s*ზომა|Company\s*size|Size)[:\s]*([^\n\r]+)/i);
      if (sizeM) companySize = sizeM[1].trim();
      const yearM = body.match(/(?:დაარსდა|Founded|Established|წელი)[:\s]*(\d{4})/i);
      if (yearM) yearFounded = yearM[1];
      const empM = body.match(/(?:თანამშრომელთა\s*რაოდენობა|Employees?|Staff)[:\s]*([^\n\r]+)/i);
      if (empM) employees = empM[1].trim();

      // ═══ DESCRIPTION ═══
      let description = '';
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) description = (metaDesc.getAttribute('content') || '').trim();

      // ═══ MAP COORDINATES ═══
      let lat = '', lng = '';
      const mapLink = document.querySelector('a[href*="google.com/maps"], a[href*="maps.google"]');
      if (mapLink) {
        const m2 = (mapLink.getAttribute('href') || '').match(/@?([\d.]+),([\d.]+)/) ||
                    (mapLink.getAttribute('href') || '').match(/destination=([\d.]+)%2C([\d.]+)/);
        if (m2) { lat = m2[1]; lng = m2[2]; }
      }
      if (!lat) {
        for (const iframe of document.querySelectorAll('iframe[src*="google.com/maps"]')) {
          const m3 = (iframe.getAttribute('src') || '').match(/q=([\d.]+),([\d.]+)/) ||
                      (iframe.getAttribute('src') || '').match(/@([\d.]+),([\d.]+)/);
          if (m3) { lat = m3[1]; lng = m3[2]; break; }
        }
      }

      // ═══ WORKING HOURS ═══
      let workingHours = '';
      const hoursM = body.match(/(?:სამუშაო\s*საათები|Working\s*hours?|Hours)[:\s]*([^\n\r]+)/i);
      if (hoursM) workingHours = hoursM[1].trim();

      // ═══ LOGO ═══
      let logoUrl = '';
      for (const img of document.querySelectorAll('img[src*="Logo"], img[src*="logo"], img[src*="company"]')) {
        const src = img.getAttribute('src') || '';
        if (src && !src.includes('nologo') && !src.includes('არ არის')) {
          logoUrl = src.startsWith('http') ? src : (location.origin + src);
          break;
        }
      }

      return {
        biaId: cId, name, brands, legalName, identificationNumber,
        address, city, phones: phones.join('; '), fax, emails: emails.join('; '),
        website, facebook, instagram, linkedin, youtube,
        categories: categories.join('; '), companySize, yearFounded, employees,
        description, workingHours, lat, lng, logoUrl,
        biaUrl: location.origin + '/Company/' + cId,
      };
    }, companyId);
  } catch (e) {
    log(`      Extract error: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════
function printSummary(companies, categoryCount) {
  const t = companies.length;
  if (t === 0) return;
  const pct = (n) => String(Math.round((n / t) * 100)).padStart(3);
  const wEmail = companies.filter((c) => c.emails).length;
  const wPhone = companies.filter((c) => c.phones).length;
  const wWeb   = companies.filter((c) => c.website).length;
  const wFB    = companies.filter((c) => c.facebook).length;
  const wAddr  = companies.filter((c) => c.address).length;
  const wCoord = companies.filter((c) => c.lat && c.lng).length;
  const wId    = companies.filter((c) => c.identificationNumber).length;

  console.log(`
╔══════════════════════════════════════════════════════╗
║              bia.ge SCRAPE COMPLETE                  ║
╠══════════════════════════════════════════════════════╣
║  Categories scraped:  ${String(categoryCount).padEnd(30)}║
║  Companies scraped:   ${String(t).padEnd(30)}║
╠══════════════════════════════════════════════════════╣
║  With email:          ${String(wEmail).padEnd(6)} (${pct(wEmail)}%)                  ║
║  With phone:          ${String(wPhone).padEnd(6)} (${pct(wPhone)}%)                  ║
║  With website:        ${String(wWeb).padEnd(6)} (${pct(wWeb)}%)                  ║
║  With Facebook:       ${String(wFB).padEnd(6)} (${pct(wFB)}%)                  ║
║  With address:        ${String(wAddr).padEnd(6)} (${pct(wAddr)}%)                  ║
║  With coordinates:    ${String(wCoord).padEnd(6)} (${pct(wCoord)}%)                  ║
║  With ID number:      ${String(wId).padEnd(6)} (${pct(wId)}%)                  ║
╚══════════════════════════════════════════════════════╝`);
}

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     bia.ge Scraper — Click-Through Approach            ║
╠════════════════════════════════════════════════════════╣
║                                                        ║
║  Navigates naturally: listing → click → extract → back ║
║  Mimics real user to avoid captcha/blocking             ║
║                                                        ║
║  Usage:                                                ║
║    node scraper.js --list-categories                   ║
║    node scraper.js --all                               ║
║    node scraper.js --category 70                       ║
║    node scraper.js --subcategory 2809                  ║
║                                                        ║
║  Options:                                              ║
║    --delay 4000    Base delay ms (default 4s)          ║
║    --headed        Show browser (solve captcha)        ║
║    --out ./output  Output directory                     ║
║    --resume        Resume from checkpoint              ║
║                                                        ║
║  Category IDs:                                         ║
║    56 Auto  57 Education  58 Entertainment             ║
║    59 Energy  60 Events  61 Food  62 IT                ║
║    63 Culture  64 Construction  65 Media               ║
║    66 Restaurants  67 Children  68 Consulting          ║
║    69 Office  70 Medicine  71 Agriculture              ║
║    72 Non-profit  74 Other  75 Clothing                ║
║    76 Telecom  77 Transport  78 Tourism                ║
║    79 Security  80 Finance  81 Environment             ║
║    86 Distribution  88 Government                      ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
`);
}

// ═══════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════
async function main() {
  if (!LIST_CATEGORIES && !SCRAPE_ALL && !CATEGORY_ARG && !SUBCATEGORY_ARG) {
    showHelp();
    return;
  }

  ensureDir(OUT_DIR);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    locale: 'ka-GE',
  });
  const page = await context.newPage();

  // Block heavy resources to speed up navigation
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  try {
    // ── LIST CATEGORIES ──
    if (LIST_CATEGORIES) {
      const mainCats = await discoverMainCategories(page);
      const fullTree = [];
      for (const cat of mainCats) {
        const subs = await discoverSubcategories(page, cat.id, cat.name);
        fullTree.push({ ...cat, subcategories: subs });
        await longDelay();
      }
      const outPath = path.join(OUT_DIR, 'categories.json');
      saveJSON(outPath, fullTree);
      console.log(`\n  ${mainCats.length} main categories, ${fullTree.reduce((s, c) => s + c.subcategories.length, 0)} subcategories`);
      for (const cat of fullTree) {
        console.log(`  [${cat.id}] ${cat.name} — ${cat.companyCount} co, ${cat.subcategories.length} subs`);
      }
      console.log(`\n  Saved: ${outPath}`);
      return;
    }

    // ── BUILD SUBCATEGORY LIST ──
    let subcategoriesToScrape = [];
    let mainCategoryNames = {};

    if (SCRAPE_ALL) {
      log('Mode: ALL categories');
      const mainCats = await discoverMainCategories(page);
      for (const cat of mainCats) {
        mainCategoryNames[cat.id] = cat.name;
        const subs = await discoverSubcategories(page, cat.id, cat.name);
        subs.forEach((s) => { s.mainCategoryName = cat.name; s.mainCategoryId = cat.id; });
        subcategoriesToScrape.push(...subs);
        await longDelay();
      }
    } else if (CATEGORY_ARG) {
      const ids = CATEGORY_ARG.split(',').map((s) => s.trim());
      log(`Mode: categories ${ids.join(', ')}`);
      for (const catId of ids) {
        await page.goto(`${BASE}/Company/IndustryCategory/${catId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(DELAY);
        const catName = await page.evaluate(() => {
          const h = document.querySelector('h1, h2');
          return h ? h.textContent.trim() : document.title.split('|')[0].trim();
        });
        mainCategoryNames[catId] = catName || `Category ${catId}`;
        const subs = await discoverSubcategories(page, catId, catName);
        subs.forEach((s) => { s.mainCategoryName = catName; s.mainCategoryId = catId; });
        subcategoriesToScrape.push(...subs);
        await longDelay();
      }
    } else if (SUBCATEGORY_ARG) {
      const ids = SUBCATEGORY_ARG.split(',').map((s) => s.trim());
      log(`Mode: subcategories ${ids.join(', ')}`);
      for (const subId of ids) {
        subcategoriesToScrape.push({
          id: subId, name: `Subcategory ${subId}`, companyCount: 0,
          parentCategoryId: '', mainCategoryName: 'Direct', mainCategoryId: '',
        });
      }
    }

    if (!subcategoriesToScrape.length) {
      log('Nothing to scrape.');
      return;
    }

    // Deduplicate subcategories
    const uniqueSubs = new Map();
    subcategoriesToScrape.forEach((s) => { if (!uniqueSubs.has(s.id)) uniqueSubs.set(s.id, s); });
    subcategoriesToScrape = Array.from(uniqueSubs.values());

    log(`\nSubcategories: ${subcategoriesToScrape.length}, est. companies: ${subcategoriesToScrape.reduce((s, c) => s + c.companyCount, 0)}`);

    // ── SCRAPE ──
    const allCompanies = [];
    const globalSeen = new Set();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const progressPath = path.join(OUT_DIR, 'progress.json');

    // Resume
    let startFrom = 0;
    if (RESUME && fs.existsSync(progressPath)) {
      const prog = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      startFrom = prog.completedSubcategoryIndex + 1;
      for (let i = 0; i < startFrom && i < subcategoriesToScrape.length; i++) {
        const sub = subcategoriesToScrape[i];
        const subFile = path.join(OUT_DIR, `sub_${sub.id}_${safeName(sub.name)}.json`);
        if (fs.existsSync(subFile)) {
          const prev = JSON.parse(fs.readFileSync(subFile, 'utf-8'));
          prev.forEach((r) => { globalSeen.add(String(r.biaId)); allCompanies.push(r); });
        }
      }
      log(`Resumed from subcategory ${startFrom + 1} (${allCompanies.length} loaded)`);
    }

    for (let si = startFrom; si < subcategoriesToScrape.length; si++) {
      const sub = subcategoriesToScrape[si];
      const catName = sub.mainCategoryName || mainCategoryNames[sub.mainCategoryId] || '';
      log(`\n== [${si + 1}/${subcategoriesToScrape.length}] ${sub.name} (parent: ${catName}) ==`);

      try {
        const { results, failed } = await scrapeSubcategory(page, sub, globalSeen, OUT_DIR);

        results.forEach((r) => {
          r.sourceSubcategory = sub.name;
          r.sourceSubcategoryId = sub.id;
          r.sourceCategory = catName;
          r.sourceCategoryId = sub.mainCategoryId || sub.parentCategoryId;
        });
        allCompanies.push(...results);

        // Save per-subcategory file
        const subFile = path.join(OUT_DIR, `sub_${sub.id}_${safeName(sub.name)}.json`);
        saveJSON(subFile, results);
        log(`    Saved: ${path.basename(subFile)} (${results.length} companies)`);

        // Clean checkpoint on success
        const cpPath = path.join(OUT_DIR, `checkpoint_${sub.id}.json`);
        if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);

      } catch (e) {
        log(`    Subcategory error: ${e.message}`);
      }

      saveJSON(progressPath, {
        completedSubcategoryIndex: si,
        totalSubcategories: subcategoriesToScrape.length,
        totalCompanies: allCompanies.length,
        timestamp: new Date().toISOString(),
      });

      // Longer delay between subcategories
      await longDelay();
    }

    // ── SAVE COMBINED OUTPUT ──
    if (allCompanies.length > 0) {
      const jsonPath = path.join(OUT_DIR, `biage_all_${ts}.json`);
      saveJSON(jsonPath, allCompanies);
      log(`\nSaved ${allCompanies.length} companies to ${jsonPath}`);

      const csvPath = path.join(OUT_DIR, `biage_all_${ts}.csv`);
      saveCSV(csvPath, allCompanies);
      log(`Saved CSV: ${csvPath}`);

      printSummary(allCompanies, subcategoriesToScrape.length);

      if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
    } else {
      log('\nNo companies scraped.');
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
