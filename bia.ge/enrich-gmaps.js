/**
 * bia.ge → Google Maps Enrichment
 * ==================================
 * Takes bia.ge scraped data as baseline and enriches each company
 * with Google Maps data: images, reviews, rating, placeId, etc.
 *
 * Reuses the same proven search & matching strategies from yell.ge enrichment.
 *
 * Usage:
 *   node enrich-gmaps.js                              # Enrich all (auto-finds biage_all file)
 *   node enrich-gmaps.js --input output/biage_all_*.json
 *   node enrich-gmaps.js --resume                     # Resume from checkpoint
 *   node enrich-gmaps.js --start 100 --end 200        # Enrich slice [100..200)
 *   node enrich-gmaps.js --concurrency 3              # Parallel tabs (default: 3)
 *   node enrich-gmaps.js --delay 400                  # Delay between requests (ms)
 *   node enrich-gmaps.js --headed                     # Show browser
 *   node enrich-gmaps.js --category "მედიცინა"        # Only enrich one source category
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

const CONCURRENCY = parseInt(param('concurrency', '3'), 10);
const DELAY = parseInt(param('delay', '400'), 10);
const HEADED = flag('headed');
const RESUME = flag('resume');
const START = parseInt(param('start', '0'), 10);
const END_IDX = param('end', null) ? parseInt(param('end'), 10) : null;
const CAT_FILTER = param('category', '');
const INPUT_FILE = param('input', '');
const OUT_DIR = path.join(__dirname, 'output');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function findInputFile() {
  if (INPUT_FILE) return INPUT_FILE;
  if (!fs.existsSync(OUT_DIR)) throw new Error(`Output directory not found: ${OUT_DIR}`);
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('biage_all_') && f.endsWith('.json'));
  if (files.length === 0) throw new Error('No input file found. Use --input to specify one.');
  files.sort();
  return path.join(OUT_DIR, files[files.length - 1]);
}

function extractCity(address, city) {
  if (city) return city;
  if (!address) return 'თბილისი';
  const c = address.split(',')[0].trim();
  return c || 'თბილისი';
}

function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u10D0-\u10FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameSimilarity(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const GENERIC = new Set([
    'company','ltd','llc','inc','group','consulting','service','services',
    'clinic','medical','center','centre','agency','international','georgia',
    'თბილისი','ბათუმი','ქუთაისი','რუსთავი','შპს','სს',
    'hotel','restaurant','cafe','salon','bar','shop','store','studio',
    'transport','logistics','construction','production','trade',
    'travel','tourism','tour','design','development','digital','web',
    'security','education','school','training','academy',
    'the','and','of','for','my','we','go','no','up','on','in','to','at','by'
  ]);

  if (na.includes(nb) || nb.includes(na)) {
    const shorter = na.length <= nb.length ? na : nb;
    const shorterWords = shorter.split(' ').filter((w) => w.length >= 2);
    const shorterBrand = shorterWords.filter((w) => !GENERIC.has(w));
    if (shorterBrand.length > 0) return 0.85;
  }

  const wordsA = new Set(na.split(' ').filter((w) => w.length >= 2));
  const wordsB = new Set(nb.split(' ').filter((w) => w.length >= 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function phonesMatch(phoneA, phoneB) {
  if (!phoneA || !phoneB) return false;
  const numsA = phoneA.replace(/[^\d]/g, '').slice(-9);
  const numsB = phoneB.replace(/[^\d]/g, '').slice(-9);
  return numsA.length >= 6 && numsB.length >= 6 && numsA === numsB;
}

// ═══════════════════════════════════════════
//  GOOGLE MAPS SEARCH & EXTRACTION
// ═══════════════════════════════════════════
async function searchGMaps(page, query) {
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(DELAY + 500);

    // Accept cookies if prompted
    const consentBtn = await page.$('button:has-text("Accept all"), button:has-text("I agree")');
    if (consentBtn) {
      await consentBtn.click();
      await sleep(1000);
    }

    // Check if we landed on a single result (place page) or search results list
    const url = page.url();
    if (url.includes('/maps/place/')) {
      // Single result — extract directly
      return await extractPlaceData(page);
    }

    // Multiple results — check for first result
    const firstResult = await page.$('[data-result-index="1"] a, div[role="feed"] > div:first-child a');
    if (firstResult) {
      await firstResult.click();
      await sleep(DELAY + 500);
      await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {});
      return await extractPlaceData(page);
    }

    return null;
  } catch (e) {
    log(`  GMaps search error: ${e.message}`);
    return null;
  }
}

async function extractPlaceData(page) {
  return await page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : '';
    };

    const name = text('h1');
    if (!name) return null;

    // Rating
    let rating = 0;
    let reviewsCount = 0;
    const ratingEl = document.querySelector('div[role="img"][aria-label*="star"]');
    if (ratingEl) {
      const m = (ratingEl.getAttribute('aria-label') || '').match(/([\d.]+)/);
      if (m) rating = parseFloat(m[1]);
    }
    const reviewEl = document.querySelector('button[aria-label*="review"]');
    if (reviewEl) {
      const m = (reviewEl.getAttribute('aria-label') || '').match(/([\d,]+)/);
      if (m) reviewsCount = parseInt(m[1].replace(/,/g, ''), 10);
    }

    // Category
    const categoryEl = document.querySelector('button[jsaction*="category"]');
    const category = categoryEl ? categoryEl.textContent.trim() : '';

    // Address
    let address = '';
    const addrBtn = document.querySelector('button[data-item-id="address"]');
    if (addrBtn) address = addrBtn.textContent.trim();

    // Phone
    let phone = '';
    const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
    if (phoneBtn) phone = phoneBtn.textContent.trim();

    // Website
    let website = '';
    const webLink = document.querySelector('a[data-item-id="authority"]');
    if (webLink) website = webLink.getAttribute('href') || '';

    // Coordinates from URL
    let lat = '', lng = '';
    const url = window.location.href;
    const coordMatch = url.match(/@([\d.-]+),([\d.-]+)/);
    if (coordMatch) {
      lat = coordMatch[1];
      lng = coordMatch[2];
    }

    // Place ID from URL
    let placeId = '';
    const pidMatch = url.match(/place\/[^/]+\/([^/]+)/);
    if (pidMatch) placeId = pidMatch[1];

    // Hours
    let hours = '';
    const hoursEl = document.querySelector('[aria-label*="hour"], [aria-label*="Hours"]');
    if (hoursEl) hours = hoursEl.getAttribute('aria-label') || '';

    // Images
    const images = [];
    document.querySelectorAll('button[style*="background-image"] img, img[src*="lh5.googleusercontent"]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src && !images.includes(src)) images.push(src);
    });

    return {
      gm_name: name,
      gm_rating: rating,
      gm_reviewsCount: reviewsCount,
      gm_category: category,
      gm_address: address,
      gm_phone: phone,
      gm_website: website,
      gm_lat: lat,
      gm_lng: lng,
      gm_placeId: placeId,
      gm_hours: hours,
      gm_url: url,
      gm_imageUrls: images.slice(0, 10),
    };
  });
}

// ═══════════════════════════════════════════
//  ENRICHMENT LOGIC
// ═══════════════════════════════════════════
async function enrichCompany(page, company) {
  const name = company.name || company.brands || '';
  const city = extractCity(company.address, company.city);

  if (!name) return { ...company, gm_matched: false };

  // Strategy 1: Search by name + city
  let gmData = await searchGMaps(page, `"${name}" ${city}`);

  if (gmData) {
    const similarity = nameSimilarity(name, gmData.gm_name);
    const phoneMatch = phonesMatch(company.phones, gmData.gm_phone);

    if (similarity >= 0.5 || phoneMatch) {
      return { ...company, ...gmData, gm_matched: true, gm_matchStrategy: 'name+city', _source: 'biage+gmaps' };
    }
  }

  // Strategy 2: Search unquoted name + city + Georgia
  gmData = await searchGMaps(page, `${name} ${city} Georgia`);

  if (gmData) {
    const similarity = nameSimilarity(name, gmData.gm_name);
    const phoneMatch = phonesMatch(company.phones, gmData.gm_phone);

    if (similarity >= 0.5 || phoneMatch) {
      return { ...company, ...gmData, gm_matched: true, gm_matchStrategy: 'name+city+country', _source: 'biage+gmaps' };
    }
  }

  // Strategy 3: Search by website domain (when available)
  if (company.website) {
    try {
      const domain = new URL(company.website).hostname;
      gmData = await searchGMaps(page, domain);

      if (gmData) {
        const similarity = nameSimilarity(name, gmData.gm_name);
        const phoneMatch = phonesMatch(company.phones, gmData.gm_phone);

        if (similarity >= 0.3 || phoneMatch) {
          return { ...company, ...gmData, gm_matched: true, gm_matchStrategy: 'website', _source: 'biage+gmaps' };
        }
      }
    } catch {}
  }

  return { ...company, gm_matched: false, _source: 'biage' };
}

// ═══════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════
async function main() {
  const inputPath = findInputFile();
  log(`Loading: ${inputPath}`);
  let companies = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  log(`Loaded ${companies.length} companies`);

  if (CAT_FILTER) {
    companies = companies.filter(
      (c) =>
        (c.sourceCategory || '').includes(CAT_FILTER) ||
        (c.sourceSubcategory || '').includes(CAT_FILTER) ||
        (c.categories || '').includes(CAT_FILTER)
    );
    log(`Filtered to "${CAT_FILTER}": ${companies.length} companies`);
  }

  // Apply range
  const end = END_IDX || companies.length;
  companies = companies.slice(START, end);
  log(`Processing range [${START}..${end}): ${companies.length} companies`);

  // Output file
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(OUT_DIR, `biage_enriched_${ts}.jsonl`);
  const progressPath = path.join(OUT_DIR, 'enrich_progress.json');

  // Resume support
  let startIdx = 0;
  const seenGmUrls = new Set();
  if (RESUME && fs.existsSync(outPath)) {
    const lines = fs.readFileSync(outPath, 'utf-8').split('\n').filter(Boolean);
    startIdx = lines.length;
    lines.forEach((line) => {
      try {
        const r = JSON.parse(line);
        if (r.gm_url) seenGmUrls.add(r.gm_url);
      } catch {}
    });
    log(`Resuming from index ${startIdx} (${seenGmUrls.size} GMaps URLs seen)`);
  }

  const browser = await chromium.launch({ headless: !HEADED });
  let matched = 0;
  let unmatched = 0;

  try {
    // Process with concurrency
    for (let i = startIdx; i < companies.length; i += CONCURRENCY) {
      const batch = companies.slice(i, i + CONCURRENCY);
      const contexts = [];

      try {
        const batchResults = await Promise.all(
          batch.map(async (company) => {
            const ctx = await browser.newContext({ userAgent: UA });
            contexts.push(ctx);
            const pg = await ctx.newPage();

            try {
              return await enrichCompany(pg, company);
            } finally {
              await pg.close();
            }
          })
        );

        // Append results to JSONL
        for (const result of batchResults) {
          fs.appendFileSync(outPath, JSON.stringify(result) + '\n');
          if (result.gm_matched) matched++;
          else unmatched++;
        }
      } finally {
        for (const ctx of contexts) {
          await ctx.close().catch(() => {});
        }
      }

      const done = Math.min(i + CONCURRENCY, companies.length);
      if (done % 10 === 0 || done >= companies.length) {
        log(`Progress: ${done}/${companies.length} — matched: ${matched}, unmatched: ${unmatched}`);
      }

      // Save progress
      if (done % 25 === 0) {
        fs.writeFileSync(
          progressPath,
          JSON.stringify({ done, total: companies.length, matched, unmatched, timestamp: new Date().toISOString() }),
          'utf-8'
        );
      }

      await sleep(Math.max(200, DELAY / 3));
    }
  } finally {
    await browser.close();
  }

  // Convert JSONL to final JSON
  const allLines = fs.readFileSync(outPath, 'utf-8').split('\n').filter(Boolean);
  const allResults = allLines.map((line) => JSON.parse(line));
  const finalPath = outPath.replace('.jsonl', '.json');
  fs.writeFileSync(finalPath, JSON.stringify(allResults, null, 2), 'utf-8');

  log(`\n✓ Enrichment complete!`);
  log(`  Total: ${allResults.length}`);
  log(`  GMaps matched: ${allResults.filter((r) => r.gm_matched).length}`);
  log(`  Unmatched: ${allResults.filter((r) => !r.gm_matched).length}`);
  log(`  Output: ${finalPath}`);

  // Cleanup
  if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
