/**
 * yell.ge Full Directory Scraper
 * ================================
 * Scrapes all companies from yell.ge by category with full details.
 *
 * Usage:
 *   node scraper.js --list-categories          # Discover all category IDs & names
 *   node scraper.js --all                       # Scrape ALL categories
 *   node scraper.js --category 174              # Scrape one category by rub ID
 *   node scraper.js --category 174,428,51       # Scrape multiple categories
 *   node scraper.js --headed                    # Show browser for debugging
 *   node scraper.js --lang geo|eng|rus          # Language (default: eng)
 *   node scraper.js --delay 800                 # Delay between requests in ms
 *   node scraper.js --out ./my-output           # Output directory
 *   node scraper.js --concurrency 2             # Parallel detail page fetches
 *   node scraper.js --resume                    # Resume from last checkpoint
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

const LANG = param('lang', 'eng');
const DELAY = parseInt(param('delay', '500'), 10);
const HEADED = flag('headed');
const LIST_CATEGORIES = flag('list-categories');
const SCRAPE_ALL = flag('all');
const CATEGORY_ARG = param('category', '');
const OUT_DIR = param('out', path.join(__dirname, 'output'));
const CONCURRENCY = parseInt(param('concurrency', '3'), 10);
const RESUME = flag('resume');
const DEEP_DISCOVERY = flag('deep-discovery'); // default: skip slow BFS, homepage finds 960+ categories

const BASE = 'https://www.yell.ge';

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function saveCSV(filePath, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v == null ? '' : v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [
    headers.map(escape).join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\n'), 'utf-8'); // BOM for Excel
}

function loadCheckpoint(filePath) {
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════
//  PHASE 1: DISCOVER ALL CATEGORIES
// ═══════════════════════════════════════════
async function discoverCategories(page) {
  log('Discovering all categories from homepage...');

  // Navigate to homepage — it has quick category links in the nav
  await page.goto(`${BASE}/index.php?lan=${LANG}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(DELAY);

  // Approach: get all links on the page that point to companies.php?...rub=
  const categories = await page.evaluate((lang) => {
    const cats = new Map();
    const links = document.querySelectorAll('a[href*="companies.php"]');
    links.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.match(/rub=(\d+)/);
      if (match) {
        const id = match[1];
        const name = (a.textContent || '').trim();
        if (name && !cats.has(id)) {
          cats.set(id, { id, name, url: href });
        }
      }
    });
    return Array.from(cats.values());
  }, LANG);

  // Also try to find a dedicated categories/rubrics page
  try {
    // Many yell.ge setups have a rubrics listing — try common URL patterns
    for (const tryUrl of [
      `${BASE}/rubrics.php?lan=${LANG}`,
      `${BASE}/all_rubrics.php?lan=${LANG}`,
      `${BASE}/categories.php?lan=${LANG}`,
    ]) {
      const resp = await page.goto(tryUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (resp && resp.ok()) {
        await sleep(DELAY);
        const moreCats = await page.evaluate(() => {
          const cats = [];
          const links = document.querySelectorAll('a[href*="companies.php"]');
          links.forEach((a) => {
            const href = a.getAttribute('href') || '';
            const match = href.match(/rub=(\d+)/);
            if (match) {
              const name = (a.textContent || '').trim();
              if (name) cats.push({ id: match[1], name, url: href });
            }
          });
          return cats;
        });
        moreCats.forEach((c) => {
          if (!categories.find((x) => x.id === c.id)) categories.push(c);
        });
        break; // Found a working page
      }
    }
  } catch (e) {
    // Rubrics page doesn't exist, continue with what we have
  }

  // Deep discovery: scan category pages for "see also" related categories
  // This is slow (~6 min) and only finds ~2 extra categories. Skip by default.
  if (DEEP_DISCOVERY) {
    log(`Found ${categories.length} categories from navigation. Starting deep discovery...`);

  const discoveredIds = new Set(categories.map((c) => c.id));
  const toExplore = [...categories];
  let explored = 0;

  // BFS: visit each category page and harvest any new category links
  while (toExplore.length > 0 && explored < 500) {
    const batch = toExplore.splice(0, 5);
    for (const cat of batch) {
      try {
        await page.goto(`${BASE}/companies.php?lan=${LANG}&rub=${cat.id}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        await sleep(Math.max(300, DELAY / 2));

        const newCats = await page.evaluate(() => {
          const found = [];
          const links = document.querySelectorAll('a[href*="companies.php"]');
          links.forEach((a) => {
            const href = a.getAttribute('href') || '';
            const match = href.match(/rub=(\d+)/);
            if (match) {
              const name = (a.textContent || '').trim().replace(/\s*\|$/, '');
              if (name) found.push({ id: match[1], name, url: href });
            }
          });
          return found;
        });

        for (const nc of newCats) {
          if (!discoveredIds.has(nc.id)) {
            discoveredIds.add(nc.id);
            categories.push(nc);
            toExplore.push(nc);
          }
        }
      } catch (e) {
        // skip failed pages
      }
      explored++;
    }

    if (explored % 20 === 0) {
      log(`  Discovery progress: explored ${explored} categories, total found: ${categories.length}`);
    }
  }
  } else {
    log(`Found ${categories.length} categories from navigation (skipping deep discovery).`);
  }

  // Deduplicate by id
  const unique = new Map();
  categories.forEach((c) => {
    if (!unique.has(c.id) || c.name.length > (unique.get(c.id).name || '').length) {
      unique.set(c.id, c);
    }
  });

  const result = Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
  log(`Total unique categories discovered: ${result.length}`);
  return result;
}

// ═══════════════════════════════════════════
//  PHASE 2: SCRAPE COMPANY LISTINGS FROM A CATEGORY
// ═══════════════════════════════════════════
async function scrapeCategory(page, categoryId, categoryName) {
  log(`\n📁 Scraping category: "${categoryName}" (rub=${categoryId})`);
  const companyLinks = [];
  const seenIds = new Set();

  // Load the first page
  const url = `${BASE}/companies.php?lan=${LANG}&rub=${categoryId}`;
  log(`  Loading: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(DELAY);
  } catch (e) {
    log(`  ⚠ Failed to load category page.`);
    return [];
  }

  // Get total number of pages from "Page: X (Y)" text
  const totalPages = await page.evaluate(() => {
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent.trim();
      const match = text.match(/^(\d+)\s*\((\d+)\)$/);
      if (match) return parseInt(match[2], 10);
    }
    // Fallback: check for pagination divs with onclick
    const pgDivs = document.querySelectorAll('div[onclick*="F_change_SR_pg"]');
    let maxPage = 1;
    pgDivs.forEach((d) => {
      const m = d.getAttribute('onclick').match(/F_change_SR_pg\((\d+)\)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    return maxPage;
  });

  log(`  Total pages: ${totalPages}`);

  // Scrape each page
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) {
      // Navigate to next page using the JS pagination function
      try {
        await page.evaluate((pg) => {
          if (typeof F_change_SR_pg === 'function') {
            F_change_SR_pg(pg);
          }
        }, pageNum);
        // Wait for content to update
        await sleep(DELAY + 500);
        // Wait for possible navigation or AJAX update to settle
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      } catch (e) {
        // Navigation context destroyed — page might have reloaded
        log(`  Page ${pageNum}: navigation triggered reload, waiting...`);
        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
          await sleep(DELAY);
        } catch (e2) {
          log(`  ⚠ Failed to navigate to page ${pageNum}`);
          break;
        }
      }
    }

    // Extract company links
    let extractedLinks;
    try {
      extractedLinks = await page.evaluate(() => {
        const results = new Map();
        const anchors = document.querySelectorAll('a');
        anchors.forEach((a) => {
          const href = a.href || '';
          const match = href.match(/company\.php.*?[?&]id=(\d+)/);
          if (match) {
            const id = match[1];
            const name = (a.textContent || '').trim();
            const existing = results.get(id);
            if (!existing || name.length > existing.name.length) {
              results.set(id, { id, name, href });
            }
          }
        });
        return Array.from(results.values()).filter((c) => c.name && c.name.length > 1);
      });
    } catch (e) {
      log(`  ⚠ Page ${pageNum}: context lost during extraction, skipping remaining pages.`);
      break;
    }

    // Check for duplicates (same page content returned)
    let newCount = 0;
    for (const link of extractedLinks) {
      if (!seenIds.has(link.id)) {
        seenIds.add(link.id);
        companyLinks.push(link);
        newCount++;
      }
    }

    log(`  Page ${pageNum}/${totalPages}: ${extractedLinks.length} found, ${newCount} new (total: ${companyLinks.length})`);

    // If no new companies, pagination isn't working — stop
    if (newCount === 0 && pageNum > 1) {
      log(`  No new companies on page ${pageNum}, stopping.`);
      break;
    }
  }

  log(`  ✓ Category "${categoryName}": ${companyLinks.length} unique companies found.`);
  return companyLinks;
}

// ═══════════════════════════════════════════
//  PHASE 3: SCRAPE INDIVIDUAL COMPANY DETAIL PAGE
// ═══════════════════════════════════════════
async function scrapeCompanyDetail(page, companyId) {
  const url = `${BASE}/company.php?lan=${LANG}&id=${companyId}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(DELAY);
  } catch (e) {
    log(`  ⚠ Failed to load company ${companyId}`);
    return null;
  }

  const detail = await page.evaluate(({ cId, baseUrl }) => {
    const text = (el) => (el ? el.textContent.trim() : '');
    const body = document.body.innerText || '';

    // === NAME ===
    let name = '';
    // Try title first — yell.ge puts "COMPANY NAME - City, Address - Category" in title
    const titleText = document.title || '';
    if (titleText.includes(' - ')) {
      name = titleText.split(' - ')[0].trim();
    }
    // Fallback to H1
    if (!name) {
      const h1 = document.querySelector('h1');
      if (h1) name = text(h1);
    }

    // === ADDRESS ===
    // The address appears right after the company name, before "Direction on Google map"
    // Format: "TBILISI, VAKE, 39a Paliashvili St."
    let address = '';
    // Look for the address in the structured area near "Direction on Google map" or "Tel:"
    const bodyLines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      // Address line typically starts with a city name and contains a street/district
      if (line.match(/^(TBILISI|BATUMI|KUTAISI|RUSTAVI|ZUGDIDI|GORI|TELAVI|POTI|SENAKI|KOBULETI|OZURGETI|AKHALTSIKHE|BORJOMI|MARNEULI|SAGAREJO|SIGNAGI|LAGODEKHI|MTSKHETA|BOLNISI|KASPI|KHASHURI|AMBROLAURI|თბილისი|ბათუმი|ქუთაისი|რუსთავი)/i)) {
        // Make sure it's not from the city dropdown (those are single words in all-caps)
        const cleaned = line.replace(/Direction on Google map.*/, '').replace(/\s+/g, ' ').trim();
        // Real addresses have commas or street indicators (St., Ave, etc.) or are longer
        if (cleaned.includes(',') || cleaned.includes('St.') || cleaned.includes('Ave') || cleaned.includes('ქ.') || cleaned.length > 20) {
          address = cleaned;
          break;
        }
      }
    }

    // === PHONES ===
    const phones = [];
    const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
    phoneLinks.forEach((a) => {
      const p = a.getAttribute('href').replace('tel:', '').trim();
      if (p) phones.push(p);
    });
    // Also extract from text: "Tel: XXX XX XX, YYY YY YY"
    const telMatch = body.match(/Tel[:\s]+([^\n\r]+)/i);
    if (telMatch) {
      const raw = telMatch[1].replace(/E-mail.*/, '').replace(/ელ\.\s*ფოსტა.*/, '');
      const nums = raw.split(/[,;]/).map((s) => s.trim()).filter((s) => s.match(/\d/));
      nums.forEach((n) => {
        if (!phones.includes(n)) phones.push(n);
      });
    }

    // === EMAILS ===
    const emails = [];
    const mailLinks = document.querySelectorAll('a[href^="mailto:"]');
    mailLinks.forEach((a) => {
      const e = a.getAttribute('href').replace('mailto:', '').replace(/^\s+/, '').trim();
      if (e && !emails.includes(e)) emails.push(e);
    });

    // === COLLECT ALL LINKS ONCE ===
    const allLinks = document.querySelectorAll('a[href]');

    // === WEBSITE ===
    let website = '';
    allLinks.forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (
        href.match(/^https?:\/\//) &&
        !href.includes('yell.ge') &&
        !href.includes('facebook.com') &&
        !href.includes('google.com') &&
        !href.includes('yandex.') &&
        !href.includes('instagram.com') &&
        !href.includes('viber:') &&
        !href.includes('wa.me') &&
        !href.includes('whatsapp') &&
        !href.includes('youtube.com') &&
        !href.includes('twitter.com') &&
        !href.includes('tiktok.com') &&
        !href.includes('linkedin.com') &&
        href.length < 200
      ) {
        if (!website) website = href;
      }
    });

    // === FACEBOOK ===
    // Look for actual Facebook page links, not OAuth/login URLs
    let facebook = '';
    allLinks.forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (
        href.includes('facebook.com') &&
        !href.includes('oauth') &&
        !href.includes('dialog') &&
        !href.includes('fb-callback') &&
        !href.includes('login') &&
        !facebook
      ) {
        facebook = href;
      }
    });

    // === INSTAGRAM ===
    let instagram = '';
    allLinks.forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (href.includes('instagram.com') && !instagram) {
        instagram = href;
      }
    });

    // === WHATSAPP ===
    let whatsapp = '';
    allLinks.forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if ((href.includes('wa.me') || href.includes('whatsapp')) && !whatsapp) {
        whatsapp = href;
      }
    });

    // === VIBER ===
    let viber = '';
    allLinks.forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (href.includes('viber:') && !viber) {
        viber = href;
      }
    });

    // === RATING & REVIEWS ===
    let rating = '';
    let reviews = '';
    const ratingMatch = body.match(/(\d+(?:\.\d+)?)\s*(?:Rating|რეიტინგ)/i);
    if (ratingMatch) rating = ratingMatch[1];
    const reviewMatch = body.match(/(\d+)\s*(?:Review|რევიუ)/i);
    if (reviewMatch) reviews = reviewMatch[1];

    // === IDENTIFICATION NUMBER ===
    let identificationNumber = '';
    const idMatch = body.match(/(?:Identification number|საიდენტიფიკაციო კოდი)[:\s]+(\d+)/i);
    if (idMatch) identificationNumber = idMatch[1];

    // === LEGAL NAME ===
    let legalName = '';
    const legalMatch = body.match(/(?:Legal name|იურიდიული დასახელება)[:\s]+([^\n\r]+)/i);
    if (legalMatch) legalName = legalMatch[1].trim();

    // === CATEGORIES ===
    // Only grab categories from the "CATEGORIES:" section, not from nav bar
    const categories = [];
    const catSection = body.match(/(?:CATEGORIES|კატეგორიები)[:\s]*([^\n\r]+)/i);
    if (catSection) {
      const catText = catSection[1];
      catText.split('|').forEach((c) => {
        const trimmed = c.trim();
        if (trimmed && trimmed.length > 1) {
          categories.push(trimmed);
        }
      });
    }

    // === MAP COORDINATES ===
    let lat = '';
    let lng = '';
    const mapLink = document.querySelector('a[href*="google.com/maps"]');
    if (mapLink) {
      const href = mapLink.getAttribute('href') || '';
      const coordMatch = href.match(/destination=([\d.]+)%2C([\d.]+)/);
      if (coordMatch) {
        lat = coordMatch[1];
        lng = coordMatch[2];
      }
    }

    // === DESCRIPTION ===
    let description = '';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) description = metaDesc.getAttribute('content') || '';

    // === WORKING HOURS ===
    let workingHours = '';
    const hoursMatch = body.match(/(?:Working hours|სამუშაო საათები)[:\s]*([^\n\r]+)/i);
    if (hoursMatch) workingHours = hoursMatch[1].trim();

    // === YOUTUBE ===
    let youtube = '';
    allLinks.forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (href.includes('youtube.com') && !youtube) {
        youtube = href;
      }
    });

    return {
      yellId: cId,
      name,
      address,
      phones: phones.join('; '),
      emails: emails.join('; '),
      website,
      facebook,
      instagram,
      whatsapp,
      viber,
      youtube,
      rating,
      reviews,
      identificationNumber,
      legalName,
      categories: categories.join('; '),
      description,
      workingHours,
      lat,
      lng,
      yellUrl: `${baseUrl}/company.php?lan=eng&id=${cId}`,
    };
  }, { cId: companyId, baseUrl: BASE });

  return detail;
}

// ═══════════════════════════════════════════
//  PARALLEL COMPANY DETAIL SCRAPING
// ═══════════════════════════════════════════
async function scrapeCompanyDetails(browser, companyList, checkpointPath) {
  const results = [];
  const failed = [];

  // Load checkpoint if resuming
  let doneIds = new Set();
  if (RESUME && checkpointPath) {
    const checkpoint = loadCheckpoint(checkpointPath);
    if (checkpoint) {
      results.push(...checkpoint.results);
      checkpoint.results.forEach((r) => doneIds.add(r.yellId));
      log(`Resumed from checkpoint: ${results.length} companies already scraped.`);
    }
  }

  const remaining = companyList.filter((c) => !doneIds.has(c.id));
  log(`Scraping details for ${remaining.length} companies (${CONCURRENCY} concurrent)...`);

  // Process in batches with concurrency
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const contexts = [];

    try {
      const batchResults = await Promise.all(
        batch.map(async (company) => {
          const ctx = await browser.newContext({
            userAgent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          });
          contexts.push(ctx);
          const pg = await ctx.newPage();

          try {
            const detail = await scrapeCompanyDetail(pg, company.id);
            return detail;
          } finally {
            await pg.close();
          }
        })
      );

      for (const r of batchResults) {
        if (r) {
          results.push(r);
        } else {
          failed.push(batch[batchResults.indexOf(r)]);
        }
      }
    } finally {
      for (const ctx of contexts) {
        await ctx.close().catch(() => {});
      }
    }

    // Progress
    const done = results.length;
    const total = companyList.length;
    if (done % 10 === 0 || i + CONCURRENCY >= remaining.length) {
      log(`  Progress: ${done}/${total} companies scraped`);
    }

    // Checkpoint every 25 companies
    if (checkpointPath && done % 25 === 0) {
      saveJSON(checkpointPath, { results, timestamp: new Date().toISOString() });
    }

    await sleep(Math.max(200, DELAY / 3));
  }

  return { results, failed };
}

// ═══════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════
async function main() {
  ensureDir(OUT_DIR);

  const browser = await chromium.launch({
    headless: !HEADED,
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // ── LIST CATEGORIES MODE ──
    if (LIST_CATEGORIES) {
      const categories = await discoverCategories(page);
      const outPath = path.join(OUT_DIR, 'categories.json');
      saveJSON(outPath, categories);

      console.log('\n═══════════════════════════════════════════');
      console.log(`  Found ${categories.length} categories`);
      console.log('═══════════════════════════════════════════\n');
      categories.forEach((c) => console.log(`  [${c.id}] ${c.name}`));
      console.log(`\nSaved to: ${outPath}`);
      return;
    }

    // ── DETERMINE WHICH CATEGORIES TO SCRAPE ──
    let categoriesToScrape = [];

    if (SCRAPE_ALL) {
      log('Mode: Scrape ALL categories');
      const categories = await discoverCategories(page);
      categoriesToScrape = categories;
    } else if (CATEGORY_ARG) {
      const ids = CATEGORY_ARG.split(',').map((s) => s.trim());
      log(`Mode: Scrape specific categories: ${ids.join(', ')}`);

      // Get names by visiting each category page
      for (const id of ids) {
        try {
          await page.goto(`${BASE}/companies.php?lan=${LANG}&rub=${id}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          await sleep(DELAY);
          const name = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            return h1 ? h1.textContent.trim().replace(/\s+/g, ' ') : '';
          });
          categoriesToScrape.push({ id, name: name || `Category ${id}` });
        } catch {
          categoriesToScrape.push({ id, name: `Category ${id}` });
        }
      }
    } else {
      console.log(`
╔════════════════════════════════════════════════════╗
║        yell.ge Business Directory Scraper          ║
╠════════════════════════════════════════════════════╣
║                                                    ║
║  Usage:                                            ║
║    node scraper.js --list-categories               ║
║      → Discover all category IDs & names           ║
║                                                    ║
║    node scraper.js --all                           ║
║      → Scrape ALL categories (full crawl)          ║
║                                                    ║
║    node scraper.js --category 174                  ║
║      → Scrape one category by ID                   ║
║                                                    ║
║    node scraper.js --category 174,428,51           ║
║      → Scrape multiple categories                  ║
║                                                    ║
║  Options:                                          ║
║    --lang eng|geo|rus     Language (default: eng)   ║
║    --delay 500            Delay between requests   ║
║    --headed               Show browser             ║
║    --out ./output         Output directory          ║
║    --concurrency 3        Parallel fetches          ║
║    --resume               Resume from checkpoint   ║
║                                                    ║
╚════════════════════════════════════════════════════╝
`);
      return;
    }

    if (categoriesToScrape.length === 0) {
      log('No categories to scrape. Use --list-categories first.');
      return;
    }

    // ── SCRAPE EACH CATEGORY ──
    const allCompanies = [];
    const globalSeen = new Set(); // cross-category dedup by yellId
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const progressPath = path.join(OUT_DIR, 'progress.json');

    // Load global resume state
    let startFromIndex = 0;
    if (RESUME && fs.existsSync(progressPath)) {
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      startFromIndex = progress.completedCategoryIndex + 1;
      // Reload previously scraped company IDs from per-category files
      for (let i = 0; i < startFromIndex && i < categoriesToScrape.length; i++) {
        const cat = categoriesToScrape[i];
        const safeName = cat.name.replace(/[^a-zA-Z0-9\u10D0-\u10FF]/g, '_').slice(0, 60);
        const catFile = path.join(OUT_DIR, `cat_${cat.id}_${safeName}.json`);
        if (fs.existsSync(catFile)) {
          const prev = JSON.parse(fs.readFileSync(catFile, 'utf-8'));
          prev.forEach((r) => {
            globalSeen.add(r.yellId);
            allCompanies.push(r);
          });
        }
      }
      log(`Resuming from category ${startFromIndex + 1}/${categoriesToScrape.length} (${allCompanies.length} companies loaded from previous run)`);
    }

    for (let ci = startFromIndex; ci < categoriesToScrape.length; ci++) {
      const cat = categoriesToScrape[ci];
      log(`\n══ Category ${ci + 1}/${categoriesToScrape.length}: [${cat.id}] ${cat.name} ══`);

      try {
      // Get company listings
      const listings = await scrapeCategory(page, cat.id, cat.name);

      if (listings.length === 0) {
        log(`  No companies in this category, skipping.`);
        // Still save progress
        saveJSON(progressPath, {
          completedCategoryIndex: ci,
          totalCategories: categoriesToScrape.length,
          totalCompanies: allCompanies.length,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Filter out already-scraped companies (cross-category dedup)
      const newListings = listings.filter((c) => !globalSeen.has(c.id));
      const dupeCount = listings.length - newListings.length;
      if (dupeCount > 0) {
        log(`  ${dupeCount} companies already scraped in other categories, skipping dupes.`);
      }

      if (newListings.length === 0) {
        log(`  All companies already scraped, skipping.`);
        saveJSON(progressPath, {
          completedCategoryIndex: ci,
          totalCategories: categoriesToScrape.length,
          totalCompanies: allCompanies.length,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Scrape details
      const checkpointPath = path.join(OUT_DIR, `checkpoint_${cat.id}.json`);
      const { results, failed } = await scrapeCompanyDetails(browser, newListings, checkpointPath);

      // Tag each company with which category it was found under
      results.forEach((r) => {
        r.sourceCategory = cat.name;
        r.sourceCategoryId = cat.id;
        globalSeen.add(r.yellId);
      });

      allCompanies.push(...results);

      // Save per-category output
      const safeName = cat.name.replace(/[^a-zA-Z0-9\u10D0-\u10FF]/g, '_').slice(0, 60);
      const catFile = path.join(OUT_DIR, `cat_${cat.id}_${safeName}.json`);
      saveJSON(catFile, results);
      log(`  ✓ Saved ${results.length} companies to ${path.basename(catFile)}`);

      if (failed.length > 0) {
        log(`  ⚠ ${failed.length} companies failed to scrape in this category.`);
      }

      // Clean up checkpoint on success
      if (fs.existsSync(checkpointPath)) {
        fs.unlinkSync(checkpointPath);
      }

      // Save global progress for resume
      saveJSON(progressPath, {
        completedCategoryIndex: ci,
        totalCategories: categoriesToScrape.length,
        totalCompanies: allCompanies.length,
        timestamp: new Date().toISOString(),
      });

      } catch (catError) {
        log(`  ⚠ Error in category [${cat.id}] ${cat.name}: ${catError.message}`);
        log(`  Saving progress and continuing to next category...`);
        // Save progress so we can resume
        saveJSON(progressPath, {
          completedCategoryIndex: ci,
          totalCategories: categoriesToScrape.length,
          totalCompanies: allCompanies.length,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ── SAVE COMBINED OUTPUT ──
    if (allCompanies.length > 0) {
      // JSON
      const jsonPath = path.join(OUT_DIR, `yellge_all_${ts}.json`);
      saveJSON(jsonPath, allCompanies);
      log(`\n📄 Saved ${allCompanies.length} companies to ${jsonPath}`);

      // CSV
      const csvPath = path.join(OUT_DIR, `yellge_all_${ts}.csv`);
      saveCSV(csvPath, allCompanies);
      log(`📄 Saved CSV to ${csvPath}`);

      // Summary
      printSummary(allCompanies, categoriesToScrape);

      // Clean up progress file — scrape complete
      if (fs.existsSync(progressPath)) {
        fs.unlinkSync(progressPath);
      }
    } else {
      log('\n⚠ No companies scraped.');
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

// ═══════════════════════════════════════════
//  SUMMARY REPORT
// ═══════════════════════════════════════════
function printSummary(companies, categories) {
  const totalCompanies = companies.length;
  const withEmail = companies.filter((c) => c.emails).length;
  const withPhone = companies.filter((c) => c.phones).length;
  const withWebsite = companies.filter((c) => c.website).length;
  const withFacebook = companies.filter((c) => c.facebook).length;
  const withAddress = companies.filter((c) => c.address).length;
  const withCoords = companies.filter((c) => c.lat && c.lng).length;

  console.log(`
╔══════════════════════════════════════════════════════╗
║              yell.ge SCRAPE COMPLETE                 ║
╠══════════════════════════════════════════════════════╣
║  Categories scraped:  ${String(categories.length).padEnd(30)}║
║  Total companies:     ${String(totalCompanies).padEnd(30)}║
╠══════════════════════════════════════════════════════╣
║  With email:          ${String(withEmail).padEnd(5)} (${String(Math.round((withEmail / totalCompanies) * 100)).padStart(3)}%)                    ║
║  With phone:          ${String(withPhone).padEnd(5)} (${String(Math.round((withPhone / totalCompanies) * 100)).padStart(3)}%)                    ║
║  With website:        ${String(withWebsite).padEnd(5)} (${String(Math.round((withWebsite / totalCompanies) * 100)).padStart(3)}%)                    ║
║  With Facebook:       ${String(withFacebook).padEnd(5)} (${String(Math.round((withFacebook / totalCompanies) * 100)).padStart(3)}%)                    ║
║  With address:        ${String(withAddress).padEnd(5)} (${String(Math.round((withAddress / totalCompanies) * 100)).padStart(3)}%)                    ║
║  With coordinates:    ${String(withCoords).padEnd(5)} (${String(Math.round((withCoords / totalCompanies) * 100)).padStart(3)}%)                    ║
╚══════════════════════════════════════════════════════╝
`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
