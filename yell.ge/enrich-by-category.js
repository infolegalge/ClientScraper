/**
 * Category-based Google Maps Enrichment
 * ======================================
 * Reverse approach: instead of searching each company by name,
 * search GMaps by CATEGORY (e.g. "dental clinics Tbilisi"),
 * scroll through all results, and match them back to our yell.ge DB.
 *
 * Targets: companies that have email but were NOT matched by the
 * name-based enrichment (enrich-gmaps.js).
 *
 * Usage:
 *   node enrich-by-category.js                           # All categories
 *   node enrich-by-category.js --category "DENTAL CLINICS"
 *   node enrich-by-category.js --resume                  # Resume from progress
 *   node enrich-by-category.js --concurrency 5
 *   node enrich-by-category.js --headed
 *   node enrich-by-category.js --min-targets 3           # Skip categories with < N targets
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Catch unhandled crashes so we see the error
process.on('unhandledRejection', (err) => {
  console.error('\n[UNHANDLED REJECTION]', err);
});
process.on('uncaughtException', (err) => {
  console.error('\n[UNCAUGHT EXCEPTION]', err);
  process.exit(1);
});

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
const DELAY = parseInt(param('delay', '500'), 10);
const HEADED = flag('headed');
const RESUME = flag('resume');
const CAT_FILTER = param('category', '');
const MIN_TARGETS = parseInt(param('min-targets', '3'), 10);
const INPUT_FILE = param('input', '');
const OUT_DIR = path.join(__dirname, 'output');
const RESULTS_JSONL = path.join(OUT_DIR, 'enrich_cat_results.jsonl');
const GMAPS_ONLY_JSONL = path.join(OUT_DIR, 'gmaps_only_results.jsonl');
const PROGRESS_FILE = path.join(OUT_DIR, 'enrich_cat_progress.json');
const GEO_MAP_FILE = path.join(OUT_DIR, 'category_geo_map.json');

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
  // Use the latest enriched file (already has gm_matched from first pass)
  const files = fs.readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('yellge_enriched_') && f.endsWith('.json'));
  if (files.length === 0) throw new Error('No enriched input file found. Use --input.');
  files.sort();
  return path.join(OUT_DIR, files[files.length - 1]);
}

function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u10D0-\u10FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC = new Set([
  'company','insurance','ltd','llc','inc','law','firm','office','group',
  'consulting','service','services','legal','hotel','restaurant','cafe',
  'clinic','medical','center','centre','management','agency','bureau',
  'association','foundation','corporation','international','georgia',
  'tbilisi','batumi','kutaisi','the','and','of','for',
  'lawyer','attorney','attorneys','advocate','partner','partners','holding',
  'cleaning','clean','repair','shop','store','studio','salon','bar','lounge',
  'transport','logistics','construction','production','manufacturing','trade',
  'employment','job','jobs','recruitment','staffing','hire','hiring',
  'investment','finance','financial','bank','banking','credit',
  'travel','tourism','tour','tours','real','estate','property',
  'design','development','digital','web','software','tech','technology',
  'food','market','pharmacy','dental','auto','car','cars','mobile',
  'security','education','school','training','academy','institute',
  'my','we','go','do','no','up','on','in','to','at','by',
]);

function nameSimilarity(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

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
  if (overlap === 0) return 0;
  const standardScore = overlap / Math.max(wordsA.size, wordsB.size);

  const brandA = new Set([...wordsA].filter((w) => !GENERIC.has(w)));
  const brandB = new Set([...wordsB].filter((w) => !GENERIC.has(w)));
  if (brandA.size > 0 && brandB.size > 0) {
    let brandOverlap = 0;
    for (const w of brandA) if (brandB.has(w)) brandOverlap++;
    if (brandOverlap > 0) {
      return brandOverlap / Math.max(brandA.size, brandB.size);
    }
    return Math.min(standardScore, 0.5);
  }
  if (brandA.size === 0) {
    return standardScore >= 0.85 ? standardScore : Math.min(standardScore, 0.4);
  }
  return Math.max(standardScore, brandA.size > 0 ? 0 : standardScore);
}

function phonesMatch(yellPhones, gmPhone) {
  if (!yellPhones || !gmPhone) return false;
  const normalize = (p) => p.replace(/[^\d]/g, '').slice(-9);
  const gmNorm = normalize(gmPhone);
  if (gmNorm.length < 6) return false;
  const yellParts = yellPhones.split(/[;,]/);
  return yellParts.some((p) => {
    const pNorm = normalize(p);
    return pNorm.length >= 6 && (pNorm.includes(gmNorm) || gmNorm.includes(pNorm));
  });
}

// ═══════════════════════════════════════════
//  BUILD CATEGORY SEARCH TERMS
// ═══════════════════════════════════════════

// Load Georgian category map if available
let geoMap = {};
if (fs.existsSync(GEO_MAP_FILE)) {
  geoMap = JSON.parse(fs.readFileSync(GEO_MAP_FILE, 'utf-8'));
  log(`Loaded Georgian category map: ${Object.keys(geoMap).length} entries`);
}

function buildSearchQuery(category, categoryId) {
  // Use Georgian name if available (first term before comma for cleaner search)
  if (categoryId && geoMap[categoryId]?.ge) {
    const geoFull = geoMap[categoryId].ge;
    // Take just the primary term (before first comma) to avoid SEO keyword stuffing
    const primary = geoFull.split(',')[0].trim();
    return `${primary} თბილისი`;
  }
  // Fallback: English
  const clean = category
    .replace(/_/g, ' ')
    .replace(/,\s*Tbilisi$/i, '')
    .trim();
  return `${clean} Tbilisi`;
}

// ═══════════════════════════════════════════
//  GOOGLE MAPS CATEGORY SEARCH
// ═══════════════════════════════════════════

async function dismissConsent(page) {
  try {
    const consentBtn = page.locator([
      'button:has-text("Accept all")', 'button:has-text("Reject all")',
      'button:has-text("ყველაფრის მიღება")', 'button:has-text("ყველას მიღება")',
      'button:has-text("მიღება")', 'button:has-text("Agree")',
      'form[action*="consent"] button',
    ].join(', '));
    if (await consentBtn.count() > 0) {
      await consentBtn.first().click();
      await sleep(2000);
    }
  } catch {}
}

/**
 * Search a category on Google Maps and scroll to collect all listings.
 * Returns array of { name, href, phone? } for each listing found.
 */
async function searchCategoryOnMaps(page, query) {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=ka`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3000);
  } catch {
    return [];
  }

  await dismissConsent(page);

  // If landed on a single place, not a list
  if (page.url().includes('/maps/place/')) {
    const name = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() || '');
    return [{ name, href: page.url() }];
  }

  // Wait for listings panel
  try {
    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 8000 });
  } catch {
    return [];
  }

  // Scroll the results panel to load more listings
  const scrollable = page.locator('div[role="feed"]');
  if (await scrollable.count() === 0) {
    // Try alternative scrollable container
    const alt = page.locator('div.m6QErb.DxyBCb');
    if (await alt.count() > 0) {
      await scrollListPanel(alt);
    }
  } else {
    await scrollListPanel(scrollable);
  }

  // Collect all listings
  const listings = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/maps/place/"]');
    return Array.from(links)
      .map((a) => ({
        name: a.getAttribute('aria-label') || a.textContent?.trim()?.slice(0, 100) || '',
        href: a.href,
      }))
      .filter((x) => x.href && x.name);
  });

  // Deduplicate by href
  const seen = new Set();
  const unique = [];
  for (const l of listings) {
    if (!seen.has(l.href)) {
      seen.add(l.href);
      unique.push(l);
    }
  }

  return unique;
}

async function scrollListPanel(locator) {
  let prevCount = 0;
  let noChangeRuns = 0;

  for (let i = 0; i < 30; i++) { // up to 30 scroll iterations
    const count = await locator.evaluate((el) => {
      const links = el.querySelectorAll('a[href*="/maps/place/"]');
      el.scrollTop = el.scrollHeight;
      return links.length;
    });

    await sleep(1500);

    // Check if "end of list" indicator appeared
    const hasEnd = await locator.evaluate((el) => {
      const endEl = el.querySelector('span.HlvSq');
      return !!endEl;
    }).catch(() => false);
    if (hasEnd) break;

    if (count === prevCount) {
      noChangeRuns++;
      if (noChangeRuns >= 3) break; // no new results after 3 tries
    } else {
      noChangeRuns = 0;
    }
    prevCount = count;
  }
}

// ═══════════════════════════════════════════
//  EXTRACT & ENRICH A SINGLE GMAPS PAGE
// ═══════════════════════════════════════════

async function extractGMapsData(page) {
  const data = await page.evaluate(() => {
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const name = $('h1')?.textContent?.trim() || '';
    const categoryBtn = $('button[jsaction*="category"]') || $('button.DkEaL');
    const category = categoryBtn?.textContent?.trim() || '';
    const allCategories = $$('button[jsaction*="category"], button.DkEaL')
      .map((b) => b.textContent?.trim()).filter(Boolean);

    const addressEl = $('button[data-item-id="address"] .Io6YTe, button[data-item-id="address"]');
    const address = addressEl?.textContent?.trim() || '';

    const phoneEl = $('button[data-item-id*="phone"] .Io6YTe, button[data-item-id*="phone"]');
    const phone = phoneEl?.textContent?.trim() || '';

    const websiteEl = $('a[data-item-id="authority"] .Io6YTe, a[data-item-id="authority"]');
    const website = websiteEl?.closest('a')?.href || '';

    const ratingEl = $('div.F7nice span[aria-hidden]');
    const rating = parseFloat(ratingEl?.textContent?.replace(',', '.') || '0');

    const reviewCountEl = $('div.F7nice span[aria-label*="review"]');
    let reviewsCount = 0;
    if (reviewCountEl) {
      const reviewsText = reviewCountEl.getAttribute('aria-label') || reviewCountEl.textContent || '';
      const m = reviewsText.match(/(\d[\d,. ]*)/);
      if (m) reviewsCount = parseInt(m[1].replace(/[^\d]/g, ''), 10) || 0;
    }
    if (reviewsCount === 0) {
      const parenEl = $('div.F7nice span:last-child');
      const pText = parenEl?.textContent || '';
      const pm = pText.match(/\((\d[\d,. ]*)\)/);
      if (pm) reviewsCount = parseInt(pm[1].replace(/[^\d]/g, ''), 10) || 0;
    }

    const priceEl = $('span[aria-label*="Price"]');
    const priceLevel = priceEl?.textContent?.trim() || '';

    const descEl = $('div.PYvSYb span, div[class*="editorial"]');
    const description = descEl?.textContent?.trim() || '';

    const hoursBtn = $('div[data-hide-tooltip-on-mouse-move] button[aria-label], button[aria-label*="hour"], button[data-item-id*="hour"]');
    let workingHoursText = '';
    if (hoursBtn) workingHoursText = hoursBtn.getAttribute('aria-label') || '';

    const plusEl = $('button[data-item-id="oloc"] .Io6YTe');
    const plusCode = plusEl?.textContent?.trim() || '';

    const urlMatch = window.location.href.match(/0x[\da-f]+:0x[\da-f]+/i);
    const placeId = urlMatch ? urlMatch[0] : '';

    let lat = '', lng = '';
    const coordMatch = window.location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (coordMatch) { lat = coordMatch[1]; lng = coordMatch[2]; }
    const dataCoord = window.location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (dataCoord && !lat) { lat = dataCoord[1]; lng = dataCoord[2]; }

    const imageUrls = $$('button[jsaction*="photo"] img, div[jsaction*="photo"] img, img.gallery-cell, img[decoding]')
      .map((img) => img.src || img.dataset?.src || '')
      .filter((u) => u.startsWith('https://') && u.includes('googleusercontent'));
    const heroImg = $('img.RZ66Rb, img[decoding="async"][src*="googleusercontent"]');
    if (heroImg?.src && heroImg.src.startsWith('https://')) imageUrls.unshift(heroImg.src);

    const socialLinks = $$('a[data-tooltip*="facebook"], a[data-tooltip*="instagram"], a[href*="facebook.com"], a[href*="instagram.com"]')
      .map((a) => a.href).filter(Boolean);

    const menuEl = $('a[data-item-id="menu"], a[aria-label*="Menu"]');
    const menuLink = menuEl?.href || '';
    const bookingEl = $('a[data-item-id*="reserve"], a[data-item-id*="book"], a[aria-label*="appointment"]');
    const bookingLink = bookingEl?.href || '';

    function getAttrSection(label) {
      const sections = $$('div[aria-label]');
      for (const sec of sections) {
        const al = sec.getAttribute('aria-label') || '';
        if (al.toLowerCase().includes(label.toLowerCase())) {
          return Array.from(sec.querySelectorAll('li')).map((li) => li.textContent?.trim()).filter(Boolean);
        }
      }
      return [];
    }

    return {
      gm_name: name, gm_category: category || allCategories[0] || '',
      gm_allCategories: [...new Set(allCategories)],
      gm_address: address, gm_phone: phone, gm_website: website,
      gm_rating: rating, gm_reviewsCount: reviewsCount,
      gm_priceLevel: priceLevel, gm_description: description,
      gm_workingHours: workingHoursText, gm_plusCode: plusCode,
      gm_placeId: placeId, gm_lat: lat, gm_lng: lng,
      gm_imageUrls: [...new Set(imageUrls)].slice(0, 10),
      gm_socialLinks: [...new Set(socialLinks)],
      gm_menuLink: menuLink, gm_bookingLink: bookingLink,
      gm_url: window.location.href,
      gm_services: getAttrSection('service'),
      gm_amenities: getAttrSection('amenities'),
      gm_accessibility: getAttrSection('accessibility'),
    };
  });
  return data;
}

async function scrapeGMapsReviews(page) {
  try {
    const reviewTab = page.locator('button[aria-label*="review"], button[role="tab"]:has-text("review")');
    if ((await reviewTab.count()) > 0) {
      await reviewTab.first().click();
      await sleep(2000);
    } else {
      return [];
    }

    const reviewsPanel = page.locator('div.m6QErb[aria-label]');
    if ((await reviewsPanel.count()) > 0) {
      for (let i = 0; i < 5; i++) {
        await reviewsPanel.first().evaluate((el) => (el.scrollTop += 500));
        await sleep(500);
      }
    }

    const moreButtons = page.locator('button.w8nwRe, button[aria-label*="More"], button[jsaction*="review.expand"]');
    const moreCount = await moreButtons.count();
    for (let i = 0; i < Math.min(moreCount, 10); i++) {
      try { await moreButtons.nth(i).click(); } catch {}
    }
    await sleep(500);

    return await page.evaluate(() => {
      const reviewEls = document.querySelectorAll('div[data-review-id], div.jftiEf');
      return Array.from(reviewEls).slice(0, 20).map((el) => {
        const author = (el.querySelector('div.d4r55, button[class*="name"], a[class*="name"]'))?.textContent?.trim() || '';
        const starsEl = el.querySelector('span[role="img"], span[aria-label*="star"]');
        const rating = parseInt((starsEl?.getAttribute('aria-label') || '').match(/\d/)?.[0] || '0', 10);
        const date = (el.querySelector('span.rsqaWe, span[class*="date"]'))?.textContent?.trim() || '';
        const text = (el.querySelector('span.wiI7pd, div.MyEned span'))?.textContent?.trim() || '';
        const ownerResponse = (el.querySelector('div.CDe7pd span'))?.textContent?.trim() || '';
        return { author, rating, date, text, ownerResponse };
      }).filter((r) => r.author || r.text);
    });
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════
//  MATCH GMAPS LISTING → YELL.GE DB
// ═══════════════════════════════════════════

/**
 * Try to match a GMaps listing (with extracted detail data) against
 * our target companies. Returns { company, nameScore, phoneMatch } or null.
 */
function findMatchInDB(gmData, targets, alreadyEnriched) {
  let bestCompany = null;
  let bestNameScore = 0;
  let bestPhoneMatch = false;

  for (const t of targets) {
    if (alreadyEnriched.has(t.yellId)) continue;

    const nameScore = nameSimilarity(gmData.gm_name, t.name);
    const phoneMatch = phonesMatch(t.phones, gmData.gm_phone);

    // Accept: strong name match OR phone match
    const isMatch = nameScore >= 0.65 || phoneMatch;
    if (!isMatch) continue;

    // Prefer phone+name match, then highest name score
    const score = (phoneMatch ? 1 : 0) + nameScore;
    if (score > (bestPhoneMatch ? 1 : 0) + bestNameScore) {
      bestCompany = t;
      bestNameScore = nameScore;
      bestPhoneMatch = phoneMatch;
    }
  }

  if (!bestCompany) return null;
  return { company: bestCompany, nameScore: bestNameScore, phoneMatch: bestPhoneMatch };
}

// ═══════════════════════════════════════════
//  PROCESS ONE CATEGORY
// ═══════════════════════════════════════════

async function processCategory(context, page, categoryName, categoryId, targets, alreadyEnriched, seenGmapsUrls) {
  const query = buildSearchQuery(categoryName, categoryId);
  log(`  🔍 Searching: "${query}" (${targets.length} targets)`);

  const listings = await searchCategoryOnMaps(page, query);
  log(`  📋 Found ${listings.length} GMaps listings`);

  if (listings.length === 0) return { enriched: [], gmapsOnly: [] };

  const enriched = [];
  const gmapsOnly = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];

    // Skip if we already scraped this GMaps URL in a previous category
    if (seenGmapsUrls.has(listing.href)) {
      continue;
    }

    try {
      // Navigate to the listing detail page
      await page.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(2500);

      // Extract detailed data
      const gmData = await extractGMapsData(page);
      seenGmapsUrls.add(listing.href);
      if (gmData.gm_url) seenGmapsUrls.add(gmData.gm_url);

      // Scrape reviews for every listing
      let reviews = [];
      try {
        reviews = await scrapeGMapsReviews(page);
      } catch {}

      // Try matching against our DB
      const match = findMatchInDB(gmData, targets, alreadyEnriched);

      if (match) {
        const matchScore = match.phoneMatch ? Math.max(match.nameScore, 0.7) : match.nameScore;
        const result = {
          ...match.company,
          gm_matched: true,
          gm_matchScore: Math.round(matchScore * 100) / 100,
          gm_phoneMatch: match.phoneMatch,
          ...gmData,
          gm_reviews: reviews,
          gm_reviewSnippets: reviews.slice(0, 5).map((r) => r.text?.slice(0, 200) || ''),
          gm_enrichedAt: new Date().toISOString(),
          gm_enrichMethod: 'category-search',
        };
        enriched.push(result);
        alreadyEnriched.add(match.company.yellId);
        log(`    ✓ [${i + 1}/${listings.length}] MATCH: ${match.company.name} ↔ ${gmData.gm_name} (${matchScore.toFixed(2)}, phone:${match.phoneMatch})`);
      } else {
        // GMaps-only: not in yell.ge DB
        const gmOnly = {
          ...gmData,
          gm_reviews: reviews,
          gm_reviewSnippets: reviews.slice(0, 5).map((r) => r.text?.slice(0, 200) || ''),
          gm_scrapedAt: new Date().toISOString(),
          gm_sourceCategory: categoryName,
          gm_sourceCategoryId: categoryId,
          gm_searchQuery: query,
        };
        gmapsOnly.push(gmOnly);
        log(`    ● [${i + 1}/${listings.length}] GMAPS-ONLY: ${(gmData.gm_name || listing.name).slice(0, 50)}`);
      }
    } catch (err) {
      const msg = (err.message || String(err)).slice(0, 120);
      log(`    ⚠ [${i + 1}/${listings.length}] Error on ${listing.name.slice(0, 40)}: ${msg}`);
      // Check if the page is still alive; if not, create fresh page
      try { await page.evaluate(() => 1); } catch {
        log(`    💀 Page crashed, creating fresh page...`);
        try {
          page = await context.newPage();
        } catch {
          log(`    💀 Context dead, aborting this category`);
          break;
        }
      }
    }

    await sleep(DELAY);
  }

  return { enriched, gmapsOnly };
}

// ═══════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════

function flushResults(records) {
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(RESULTS_JSONL, lines, 'utf-8');
}

function flushGmapsOnly(records) {
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(GMAPS_ONLY_JSONL, lines, 'utf-8');
}

function saveProgress(completedCategories, totalMatched) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    completedCategories,
    totalMatched,
    updatedAt: new Date().toISOString(),
  }), 'utf-8');
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { completedCategories: [], totalMatched: 0 };
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return { completedCategories: [], totalMatched: 0 };
  }
}

function loadResultsJsonl() {
  if (!fs.existsSync(RESULTS_JSONL)) return new Map();
  const map = new Map();
  const lines = fs.readFileSync(RESULTS_JSONL, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.yellId) map.set(obj.yellId, obj);
    } catch {}
  }
  return map;
}

// ═══════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load enriched data
  const inputPath = findInputFile();
  log(`Loading: ${inputPath}`);
  const allCompanies = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  log(`Loaded ${allCompanies.length} companies`);

  // Target: companies with email but NOT matched by first pass
  const hasEmail = (d) => d.emails && d.emails.trim() && d.emails.includes('@');
  const targets = allCompanies.filter((d) => !d.gm_matched && hasEmail(d));
  log(`Targets: ${targets.length} companies (email + no GMaps match)`);

  // Group targets by sourceCategory (+ track categoryId)
  const catMap = {};
  const catIdMap = {}; // categoryName -> sourceCategoryId
  for (const t of targets) {
    const cat = t.sourceCategory || '?';
    if (!catMap[cat]) catMap[cat] = [];
    catMap[cat].push(t);
    if (t.sourceCategoryId && !catIdMap[cat]) catIdMap[cat] = t.sourceCategoryId;
  }

  // Build category queue sorted by target count (biggest first)
  let catQueue = Object.entries(catMap)
    .filter(([, arr]) => arr.length >= MIN_TARGETS)
    .sort((a, b) => b[1].length - a[1].length);

  if (CAT_FILTER) {
    const f = CAT_FILTER.toUpperCase();
    catQueue = catQueue.filter(([cat]) => cat.toUpperCase().includes(f));
    log(`Filtered to categories matching "${CAT_FILTER}": ${catQueue.length}`);
  }

  log(`Categories to search: ${catQueue.length} (min ${MIN_TARGETS} targets each)`);
  log(`Total target companies in scope: ${catQueue.reduce((s, [, arr]) => s + arr.length, 0)}`);

  // Resume state
  let progress = { completedCategories: [], totalMatched: 0 };
  const alreadyEnriched = new Set();

  // Track GMaps URLs we've already scraped (dedup across categories)
  const seenGmapsUrls = new Set();

  if (RESUME) {
    progress = loadProgress();
    const existingResults = loadResultsJsonl();
    existingResults.forEach((_, id) => alreadyEnriched.add(id));
    // Load already-scraped GMaps URLs from both JSONL files for dedup
    if (fs.existsSync(GMAPS_ONLY_JSONL)) {
      for (const line of fs.readFileSync(GMAPS_ONLY_JSONL, 'utf-8').split('\n').filter(Boolean)) {
        try { const o = JSON.parse(line); if (o.gm_url) seenGmapsUrls.add(o.gm_url); } catch {}
      }
    }
    log(`Resumed: ${progress.completedCategories.length} categories done, ${alreadyEnriched.size} matches, ${seenGmapsUrls.size} GMaps URLs on disk`);
  } else {
    if (fs.existsSync(RESULTS_JSONL)) fs.unlinkSync(RESULTS_JSONL);
    if (fs.existsSync(GMAPS_ONLY_JSONL)) fs.unlinkSync(GMAPS_ONLY_JSONL);
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
  }

  const doneSet = new Set(progress.completedCategories);
  const remaining = catQueue.filter(([cat]) => !doneSet.has(cat));
  log(`Remaining categories: ${remaining.length}`);

  // Launch browser — use single context with multiple pages for category work
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let totalMatched = progress.totalMatched;
  let totalGmapsOnly = 0;
  let catsProcessed = progress.completedCategories.length;

  // Shared queue index — JS is single-threaded so ++ is safe
  let queueIdx = 0;

  async function worker(workerId) {
    while (true) {
      const ci = queueIdx++;
      if (ci >= remaining.length) break;

      const [catName, catTargets] = remaining[ci];
      const activeTargets = catTargets.filter((t) => !alreadyEnriched.has(t.yellId));
      if (activeTargets.length === 0) {
        catsProcessed++;
        progress.completedCategories.push(catName);
        log(`[W${workerId}] [${catsProcessed}/${catQueue.length}] ${catName} — all targets already enriched, skipping`);
        continue;
      }

      log(`\n[W${workerId}] [${catsProcessed + 1}/${catQueue.length}] ▶ ${catName} (${activeTargets.length} targets)`);

      let context;
      let page;
      try {
        context = await browser.newContext({
          locale: 'ka-GE',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          viewport: { width: 1440, height: 900 },
          geolocation: { latitude: 41.7151, longitude: 44.8271 },
          permissions: ['geolocation'],
        });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        page = await context.newPage();
      } catch (err) {
        log(`  [W${workerId}] ⚠ Failed to create context: ${err.message}`);
        continue;
      }

      try {
        const { enriched, gmapsOnly } = await processCategory(context, page, catName, catIdMap[catName], activeTargets, alreadyEnriched, seenGmapsUrls);

        if (enriched.length > 0) {
          flushResults(enriched);
          totalMatched += enriched.length;
        }
        if (gmapsOnly.length > 0) {
          flushGmapsOnly(gmapsOnly);
          totalGmapsOnly += gmapsOnly.length;
        }
        log(`  [W${workerId}] 💾 ${enriched.length} matched, ${gmapsOnly.length} gmaps-only (totals: ${totalMatched} matched, ${totalGmapsOnly} gmaps-only)`);
      } catch (err) {
        log(`  [W${workerId}] ⚠ Error processing category "${catName}": ${err.message}`);
        log(`    Stack: ${(err.stack || '').split('\n').slice(0, 3).join(' | ')}`);
      }

      await context.close().catch(() => {});

      // Update progress
      progress.completedCategories.push(catName);
      catsProcessed++;
      saveProgress(progress.completedCategories, totalMatched);

      log(`  [W${workerId}] 📊 Progress: ${catsProcessed}/${catQueue.length} categories, ${totalMatched} matched, ${totalGmapsOnly} gmaps-only`);
      await sleep(DELAY);
    }
  }

  log(`🚀 Launching ${CONCURRENCY} parallel workers...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  await browser.close().catch(() => {});

  // Build final merged output
  log('\nBuilding final merged output...');
  const catResults = loadResultsJsonl();
  log(`Category enrichment found ${catResults.size} new matches`);

  // Merge: start with existing enriched data, overlay category matches
  const finalData = allCompanies.map((c) => {
    if (catResults.has(c.yellId)) return catResults.get(c.yellId);
    return c;
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `yellge_enriched_v2_${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(finalData, null, 2), 'utf-8');
  log(`📄 Saved ${finalData.length} companies to ${jsonPath}`);

  const csvPath = path.join(OUT_DIR, `yellge_enriched_v2_${ts}.csv`);
  fs.writeFileSync(csvPath, buildCSV(finalData), 'utf-8');
  log(`📄 Saved CSV to ${csvPath}`);

  // Build GMaps-only output (businesses on Maps but not in yell.ge)
  const gmapsOnlyData = loadGmapsOnlyJsonl();
  log(`GMaps-only businesses found: ${gmapsOnlyData.length}`);
  if (gmapsOnlyData.length > 0) {
    const goJsonPath = path.join(OUT_DIR, `gmaps_only_${ts}.json`);
    fs.writeFileSync(goJsonPath, JSON.stringify(gmapsOnlyData, null, 2), 'utf-8');
    log(`📄 Saved ${gmapsOnlyData.length} GMaps-only businesses to ${goJsonPath}`);

    const goCsvPath = path.join(OUT_DIR, `gmaps_only_${ts}.csv`);
    fs.writeFileSync(goCsvPath, buildGmapsOnlyCSV(gmapsOnlyData), 'utf-8');
    log(`📄 Saved GMaps-only CSV to ${goCsvPath}`);
  }

  // Clean up progress
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

  // Summary
  const allMatched = finalData.filter((r) => r.gm_matched).length;
  const catMatched = [...catResults.values()].filter((r) => r.gm_matched).length;
  const firstPassMatched = finalData.filter((r) => r.gm_matched && r.gm_enrichMethod !== 'category-search').length;

  console.log('\n' + '═'.repeat(60));
  console.log('  CATEGORY-BASED ENRICHMENT COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  First-pass matches:      ${firstPassMatched}`);
  console.log(`  Category-search matches: ${catMatched} (new)`);
  console.log(`  Total GMaps matched:     ${allMatched} / ${finalData.length} (${Math.round(allMatched / finalData.length * 100)}%)`);
  console.log(`  GMaps-only (no yell.ge): ${gmapsOnlyData.length}`);
  console.log('═'.repeat(60));
}

function loadGmapsOnlyJsonl() {
  if (!fs.existsSync(GMAPS_ONLY_JSONL)) return [];
  const results = [];
  const seen = new Set();
  for (const line of fs.readFileSync(GMAPS_ONLY_JSONL, 'utf-8').split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      const key = obj.gm_placeId || obj.gm_url || obj.gm_name;
      if (key && !seen.has(key)) {
        seen.add(key);
        results.push(obj);
      }
    } catch {}
  }
  return results;
}

function buildGmapsOnlyCSV(data) {
  const headers = [
    'gm_name','gm_category','gm_allCategories','gm_address','gm_phone','gm_website',
    'gm_rating','gm_reviewsCount','gm_priceLevel','gm_description',
    'gm_workingHours','gm_placeId','gm_lat','gm_lng',
    'gm_url','gm_imageUrls','gm_reviewSnippets','gm_menuLink','gm_bookingLink',
    'gm_socialLinks','gm_services','gm_amenities',
    'gm_sourceCategory','gm_sourceCategoryId','gm_searchQuery','gm_scrapedAt',
  ];
  const esc = (val) => {
    let s = val == null ? '' : String(val);
    if (Array.isArray(val)) s = val.join('; ');
    s = s.replace(/"/g, '""');
    return `"${s}"`;
  };
  const BOM = '\uFEFF';
  const rows = data.map((c) => headers.map((h) => esc(c[h])).join(','));
  return BOM + [headers.join(','), ...rows].join('\n');
}

function buildCSV(data) {
  const headers = [
    'yellId','name','address','phones','emails','website',
    'facebook','instagram','categories','rating','identificationNumber',
    'gm_matched','gm_matchScore','gm_name','gm_category','gm_address',
    'gm_phone','gm_website','gm_rating','gm_reviewsCount','gm_priceLevel',
    'gm_description','gm_workingHours','gm_placeId','gm_lat','gm_lng',
    'gm_url','gm_imageUrls','gm_reviewSnippets','gm_menuLink','gm_bookingLink',
    'yellUrl','sourceCategory','gm_enrichMethod',
  ];
  const esc = (val) => {
    let s = val == null ? '' : String(val);
    if (Array.isArray(val)) s = val.join('; ');
    s = s.replace(/"/g, '""');
    return `"${s}"`;
  };
  const BOM = '\uFEFF';
  const rows = data.map((c) => headers.map((h) => esc(c[h])).join(','));
  return BOM + [headers.join(','), ...rows].join('\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
