/**
 * yell.ge → Google Maps Enrichment
 * ==================================
 * Takes the yell.ge scraped data as baseline and enriches each company
 * with Google Maps data: images, reviews, rating, placeId, category, etc.
 *
 * Usage:
 *   node enrich-gmaps.js                              # Enrich all (auto-finds COMPLETE file)
 *   node enrich-gmaps.js --input output/yellge_COMPLETE_*.json
 *   node enrich-gmaps.js --resume                     # Resume from checkpoint
 *   node enrich-gmaps.js --start 100 --end 200        # Enrich slice [100..200)
 *   node enrich-gmaps.js --concurrency 3              # Parallel tabs (default: 3)
 *   node enrich-gmaps.js --delay 400                  # Delay between requests (ms)
 *   node enrich-gmaps.js --headed                     # Show browser
 *   node enrich-gmaps.js --category "LEGAL SERVICES"  # Only enrich one category
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
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('yellge_COMPLETE_') && f.endsWith('.json'));
  if (files.length === 0) {
    // fallback to yellge_all_
    const allFiles = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('yellge_all_') && f.endsWith('.json'));
    if (allFiles.length === 0) throw new Error('No input file found. Use --input to specify one.');
    allFiles.sort();
    return path.join(OUT_DIR, allFiles[allFiles.length - 1]);
  }
  files.sort();
  return path.join(OUT_DIR, files[files.length - 1]);
}

function extractCity(address) {
  if (!address) return 'Tbilisi';
  // Address format: "TBILISI, SABURTALO, 12 St. ..."
  const city = address.split(',')[0].trim();
  return city || 'Tbilisi';
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

  // Common business words to ignore for brand matching
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
    'my','we','go','do','no','up','on','in','to','at','by'
  ]);

  // Substring check: only grant 0.85 if the shorter name has brand words
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = na.length <= nb.length ? na : nb;
    const shorterWords = shorter.split(' ').filter((w) => w.length >= 2);
    const shorterBrand = shorterWords.filter((w) => !GENERIC.has(w));
    if (shorterBrand.length > 0) return 0.85;
    // All-generic substring — fall through to standard scoring
  }

  const wordsA = new Set(na.split(' ').filter((w) => w.length >= 2));
  const wordsB = new Set(nb.split(' ').filter((w) => w.length >= 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  // Standard word overlap (current method)
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  if (overlap === 0) return 0;
  const standardScore = overlap / Math.max(wordsA.size, wordsB.size);

  // Brand word overlap (strip generic business terms)
  const brandA = new Set([...wordsA].filter((w) => !GENERIC.has(w)));
  const brandB = new Set([...wordsB].filter((w) => !GENERIC.has(w)));
  let brandScore = 0;
  if (brandA.size > 0 && brandB.size > 0) {
    let brandOverlap = 0;
    for (const w of brandA) if (brandB.has(w)) brandOverlap++;
    if (brandOverlap > 0) {
      brandScore = brandOverlap / Math.max(brandA.size, brandB.size);
    } else {
      // Brand words exist on both sides but don't overlap = likely different company
      return Math.min(standardScore, 0.5);
    }
  }

  // If the original name has brand words, require brand-level match
  if (brandA.size > 0 && brandB.size > 0) {
    return brandScore;
  }
  // If all words in the yell.ge name are generic, require very high standard overlap
  if (brandA.size === 0) {
    return standardScore >= 0.85 ? standardScore : Math.min(standardScore, 0.4);
  }
  return Math.max(standardScore, brandScore);
}

function phonesMatch(yellPhones, gmPhone) {
  if (!yellPhones || !gmPhone) return false;
  // Normalize: strip all non-digits except leading +
  const normalize = (p) => p.replace(/[^\d]/g, '').slice(-9); // last 9 digits
  const gmNorm = normalize(gmPhone);
  if (gmNorm.length < 6) return false;
  // Check if any yell.ge phone matches
  const yellParts = yellPhones.split(/[;,]/); 
  return yellParts.some((p) => {
    const pNorm = normalize(p);
    return pNorm.length >= 6 && (pNorm.includes(gmNorm) || gmNorm.includes(pNorm));
  });
}

// ═══════════════════════════════════════════
//  GOOGLE MAPS SEARCH + EXTRACTION
// ═══════════════════════════════════════════

async function dismissConsent(page) {
  try {
    const consentBtn = page.locator(
      'button:has-text("Accept all"), button:has-text("Reject all")'
    );
    if (await consentBtn.count() > 0) {
      await consentBtn.first().click();
      await sleep(1500);
    }
  } catch {}
}

async function doGMapsSearch(page, query) {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2500);
  } catch (e) {
    return null;
  }

  await dismissConsent(page);

  // Check if we landed directly on a place page
  if (page.url().includes('/maps/place/')) {
    return { type: 'direct', url: page.url() };
  }

  // Wait for listings
  try {
    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 6000 });
  } catch {
    return null;
  }

  const listings = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/maps/place/"]');
    return Array.from(links)
      .map((a) => ({
        name: a.getAttribute('aria-label') || a.textContent?.trim()?.slice(0, 80) || '',
        href: a.href,
      }))
      .filter((x) => x.href && x.name);
  });

  if (listings.length === 0) return null;
  return { type: 'list', listings };
}

async function searchGoogleMaps(page, company) {
  const city = extractCity(company.address);
  const name = company.name;

  // Strategy 1: Exact name + city
  let result = await doGMapsSearch(page, `"${name}" ${city}`);
  if (result) return result;

  // Strategy 2: Name + city (without quotes)
  result = await doGMapsSearch(page, `${name} ${city} Georgia`);
  if (result) return result;

  // Strategy 3: If we have a website domain, search by that
  if (company.website) {
    try {
      const domain = new URL(company.website).hostname.replace('www.', '');
      result = await doGMapsSearch(page, `${domain} ${city}`);
      if (result) return result;
    } catch {}
  }

  return null;
}

async function pickBestMatch(page, listings, company) {
  // Score each listing by name similarity
  let best = null;
  let bestScore = 0;
  for (const l of listings.slice(0, 5)) {
    const score = nameSimilarity(l.name, company.name);
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }

  // Require meaningful similarity (0.5)
  if (!best || bestScore < 0.5) {
    return null;
  }

  // Navigate to the best match
  try {
    await page.goto(best.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
  } catch {
    return null;
  }

  return { ...best, score: bestScore };
}

async function extractGMapsData(page) {
  const data = await page.evaluate(() => {
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const name = $('h1')?.textContent?.trim() || '';

    // Category
    const categoryBtn = $('button[jsaction*="category"]') || $('button.DkEaL');
    const category = categoryBtn?.textContent?.trim() || '';
    const allCategories = $$('button[jsaction*="category"], button.DkEaL')
      .map((b) => b.textContent?.trim())
      .filter(Boolean);

    // Address
    const addressEl = $(
      'button[data-item-id="address"] .Io6YTe, button[data-item-id="address"]'
    );
    const address = addressEl?.textContent?.trim() || '';

    // Phone
    const phoneEl = $(
      'button[data-item-id*="phone"] .Io6YTe, button[data-item-id*="phone"]'
    );
    const phone = phoneEl?.textContent?.trim() || '';

    // Website
    const websiteEl = $(
      'a[data-item-id="authority"] .Io6YTe, a[data-item-id="authority"]'
    );
    const website = websiteEl?.closest('a')?.href || '';

    // Rating
    const ratingEl = $('div.F7nice span[aria-hidden]');
    const rating = parseFloat(ratingEl?.textContent?.replace(',', '.') || '0');

    // Review count — be specific to avoid grabbing rating element
    const reviewCountEl = $(
      'div.F7nice span[aria-label*="review"]'
    );
    let reviewsCount = 0;
    if (reviewCountEl) {
      const reviewsText = reviewCountEl.getAttribute('aria-label') || reviewCountEl.textContent || '';
      const reviewMatch = reviewsText.match(/(\d[\d,. ]*)/); 
      if (reviewMatch) {
        reviewsCount = parseInt(reviewMatch[1].replace(/[^\d]/g, ''), 10) || 0;
      }
    }
    // Fallback: look for parenthesized number near rating
    if (reviewsCount === 0) {
      const parenEl = $('div.F7nice span:last-child');
      const parenText = parenEl?.textContent || '';
      const parenMatch = parenText.match(/\((\d[\d,. ]*)\)/);
      if (parenMatch) {
        reviewsCount = parseInt(parenMatch[1].replace(/[^\d]/g, ''), 10) || 0;
      }
    }

    // Price level
    const priceEl = $('span[aria-label*="Price"]');
    const priceLevel = priceEl?.textContent?.trim() || '';

    // Description
    const descEl = $('div.PYvSYb span, div[class*="editorial"]');
    const description = descEl?.textContent?.trim() || '';

    // Working hours
    const hoursBtn = $(
      'div[data-hide-tooltip-on-mouse-move] button[aria-label], button[aria-label*="hour"], button[data-item-id*="hour"]'
    );
    let workingHoursText = '';
    if (hoursBtn) {
      workingHoursText = hoursBtn.getAttribute('aria-label') || '';
    }
    // Also try table
    const hoursEls = $$('table.eK4R0e tr');
    const workingHoursArr = hoursEls
      .map((el) => el.textContent?.trim())
      .filter(Boolean);

    // Plus code
    const plusEl = $('button[data-item-id="oloc"] .Io6YTe');
    const plusCode = plusEl?.textContent?.trim() || '';

    // Place ID from URL
    const urlMatch = window.location.href.match(/0x[\da-f]+:0x[\da-f]+/i);
    const placeId = urlMatch ? urlMatch[0] : '';

    // Coordinates from URL
    let lat = '',
      lng = '';
    const coordMatch = window.location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (coordMatch) {
      lat = coordMatch[1];
      lng = coordMatch[2];
    }
    const dataCoord = window.location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (dataCoord && !lat) {
      lat = dataCoord[1];
      lng = dataCoord[2];
    }

    // Images
    const imageUrls = $$(
      'button[jsaction*="photo"] img, div[jsaction*="photo"] img, img.gallery-cell, img[decoding]'
    )
      .map((img) => img.src || img.dataset?.src || '')
      .filter((u) => u.startsWith('https://') && u.includes('googleusercontent'));
    const heroImg = $('img.RZ66Rb, img[decoding="async"][src*="googleusercontent"]');
    if (heroImg?.src && heroImg.src.startsWith('https://')) {
      imageUrls.unshift(heroImg.src);
    }

    // Social links
    const socialLinks = $$(
      'a[data-tooltip*="facebook"], a[data-tooltip*="instagram"], a[data-tooltip*="twitter"], a[href*="facebook.com"], a[href*="instagram.com"]'
    )
      .map((a) => a.href)
      .filter(Boolean);

    // Menu / booking
    const menuEl = $('a[data-item-id="menu"], a[aria-label*="Menu"]');
    const menuLink = menuEl?.href || '';
    const bookingEl = $(
      'a[data-item-id*="reserve"], a[data-item-id*="book"], a[aria-label*="appointment"]'
    );
    const bookingLink = bookingEl?.href || '';

    // Attribute sections
    function getAttrSection(label) {
      const sections = $$('div[aria-label]');
      for (const sec of sections) {
        const ariaLabel = sec.getAttribute('aria-label') || '';
        if (ariaLabel.toLowerCase().includes(label.toLowerCase())) {
          const items = sec.querySelectorAll('li');
          return Array.from(items)
            .map((li) => li.textContent?.trim())
            .filter(Boolean);
        }
      }
      return [];
    }

    return {
      gm_name: name,
      gm_category: category || allCategories[0] || '',
      gm_allCategories: [...new Set(allCategories)],
      gm_address: address,
      gm_phone: phone,
      gm_website: website,
      gm_rating: rating,
      gm_reviewsCount: reviewsCount,
      gm_priceLevel: priceLevel,
      gm_description: description,
      gm_workingHours: workingHoursText || workingHoursArr.join(' | '),
      gm_plusCode: plusCode,
      gm_placeId: placeId,
      gm_lat: lat,
      gm_lng: lng,
      gm_imageUrls: [...new Set(imageUrls)].slice(0, 10),
      gm_socialLinks: [...new Set(socialLinks)],
      gm_menuLink: menuLink,
      gm_bookingLink: bookingLink,
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
    const reviewTab = page.locator(
      'button[aria-label*="review"], button[role="tab"]:has-text("review")'
    );
    if ((await reviewTab.count()) > 0) {
      await reviewTab.first().click();
      await sleep(2000);
    } else {
      return [];
    }

    // Scroll reviews
    const reviewsPanel = page.locator('div.m6QErb[aria-label]');
    if ((await reviewsPanel.count()) > 0) {
      for (let i = 0; i < 5; i++) {
        await reviewsPanel.first().evaluate((el) => (el.scrollTop += 500));
        await sleep(500);
      }
    }

    // Expand "More" buttons
    const moreButtons = page.locator(
      'button.w8nwRe, button[aria-label*="More"], button[jsaction*="review.expand"]'
    );
    const moreCount = await moreButtons.count();
    for (let i = 0; i < Math.min(moreCount, 10); i++) {
      try {
        await moreButtons.nth(i).click();
      } catch {}
    }
    await sleep(500);

    const reviews = await page.evaluate(() => {
      const reviewEls = document.querySelectorAll(
        'div[data-review-id], div.jftiEf'
      );
      return Array.from(reviewEls)
        .slice(0, 20)
        .map((el) => {
          const authorEl = el.querySelector(
            'div.d4r55, button[class*="name"], a[class*="name"]'
          );
          const author = authorEl?.textContent?.trim() || '';

          const starsEl = el.querySelector(
            'span[role="img"], span[aria-label*="star"]'
          );
          const starsText = starsEl?.getAttribute('aria-label') || '';
          const rating = parseInt(starsText.match(/\d/)?.[0] || '0', 10);

          const dateEl = el.querySelector('span.rsqaWe, span[class*="date"]');
          const date = dateEl?.textContent?.trim() || '';

          const textEl = el.querySelector('span.wiI7pd, div.MyEned span');
          const text = textEl?.textContent?.trim() || '';

          const responseEl = el.querySelector('div.CDe7pd span');
          const ownerResponse = responseEl?.textContent?.trim() || '';

          return { author, rating, date, text, ownerResponse };
        })
        .filter((r) => r.author || r.text);
    });

    return reviews;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════
//  ENRICH ONE COMPANY
// ═══════════════════════════════════════════

async function enrichCompany(page, company) {
  const result = await searchGoogleMaps(page, company);

  if (!result) {
    return { ...company, gm_matched: false };
  }

  let matchInfo;
  if (result.type === 'direct') {
    matchInfo = { score: 0.9 }; // direct hit, still verify below
  } else {
    matchInfo = await pickBestMatch(page, result.listings, company);
    if (!matchInfo) {
      return { ...company, gm_matched: false };
    }
  }

  // Extract GMaps data
  const gmData = await extractGMapsData(page);

  // Verify match quality with multiple signals
  const nameScore = nameSimilarity(gmData.gm_name, company.name);
  const phoneMatch = phonesMatch(company.phones, gmData.gm_phone);

  // Accept if: strong name match (>=0.65) OR phone matches OR borderline name + phone
  const isValidMatch = nameScore >= 0.65 || phoneMatch;

  if (!isValidMatch) {
    return { ...company, gm_matched: false, gm_matchScore: nameScore, gm_phoneMatch: phoneMatch };
  }

  const matchScore = phoneMatch ? Math.max(nameScore, 0.7) : nameScore;

  // Scrape reviews
  const gm_reviews = await scrapeGMapsReviews(page);

  return {
    ...company,
    gm_matched: true,
    gm_matchScore: Math.round(matchScore * 100) / 100,
    gm_phoneMatch: phoneMatch,
    ...gmData,
    gm_reviews,
    gm_reviewSnippets: gm_reviews
      .slice(0, 5)
      .map((r) => r.text?.slice(0, 200) || ''),
    gm_enrichedAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════
//  CONCURRENT WORKER
// ═══════════════════════════════════════════

const RESULTS_JSONL = path.join(OUT_DIR, 'enrich_results.jsonl');
const PROGRESS_FILE = path.join(OUT_DIR, 'enrich_progress.json');

async function enrichAll(browser, companies, startIdx, enrichedSet, resultFile) {
  let idx = 0;
  let completedCount = 0;
  const pending = [];  // small buffer for current flush window

  async function worker(workerId) {
    let context = await browser.newContext({
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      geolocation: { latitude: 41.7151, longitude: 44.8271 },
      permissions: ['geolocation'],
    });
    let page = await context.newPage();

    while (true) {
      const localIdx = idx++;
      if (localIdx >= companies.length) break;

      const company = companies[localIdx];
      const globalIdx = startIdx + localIdx;

      // Skip if already enriched (resume)
      if (enrichedSet.has(company.yellId)) {
        completedCount++;
        continue;
      }

      let result;
      try {
        result = await enrichCompany(page, company);
        const status = result.gm_matched
          ? `✓ ${result.gm_rating}★ (${result.gm_reviewsCount} reviews) ${result.gm_imageUrls?.length || 0} imgs`
          : '✗ not found';
        log(`  [${globalIdx + 1}] ${company.name} — ${status}`);
      } catch (err) {
        log(`  [${globalIdx + 1}] ${company.name} — ⚠ Error: ${err.message}`);
        result = { ...company, gm_matched: false, gm_error: err.message };

        // Recover: create fresh context/page if destroyed
        try {
          await page.close().catch(() => {});
          await context.close().catch(() => {});
        } catch {}
        context = await browser.newContext({
          locale: 'en-US',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          viewport: { width: 1440, height: 900 },
          geolocation: { latitude: 41.7151, longitude: 44.8271 },
          permissions: ['geolocation'],
        });
        page = await context.newPage();
      }

      // Add to flush buffer
      pending.push(result);
      completedCount++;

      // Flush every 50 → append to JSONL + update progress
      if (completedCount % 50 === 0) {
        flushResults(resultFile, pending);
        saveProgress(startIdx + completedCount);
        pending.length = 0;
      }

      await sleep(DELAY);
    }

    await context.close();
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, companies.length) }, (_, i) =>
      worker(i)
    )
  );

  // Flush any remaining
  if (pending.length > 0) {
    flushResults(resultFile, pending);
    saveProgress(startIdx + completedCount);
    pending.length = 0;
  }

  return completedCount;
}

function flushResults(filePath, records) {
  // Append each record as a single JSON line
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf-8');
  log(`  💾 Flushed ${records.length} records to disk`);
}

function saveProgress(processedCount) {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({ processedCount, updatedAt: new Date().toISOString() }),
    'utf-8'
  );
  log(`  📊 Progress: ${processedCount} / 12778`);
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    return raw.processedCount || 0;
  } catch {
    return 0;
  }
}

function loadResultsJsonl(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const map = new Map();
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
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

  // Load input data
  const inputPath = findInputFile();
  log(`Loading input: ${inputPath}`);
  const allCompanies = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  log(`Loaded ${allCompanies.length} companies`);

  // Filter by category if specified
  let companies = allCompanies;
  if (CAT_FILTER) {
    companies = allCompanies.filter(
      (c) =>
        c.categories &&
        c.categories.toLowerCase().includes(CAT_FILTER.toLowerCase())
    );
    log(`Filtered to ${companies.length} companies in "${CAT_FILTER}"`);
  }

  // Slice range
  const start = START;
  const end = END_IDX !== null ? Math.min(END_IDX, companies.length) : companies.length;
  companies = companies.slice(start, end);
  log(`Processing range [${start}..${start + companies.length}) = ${companies.length} companies`);

  // Load resume state: read JSONL results + progress file
  const enrichedSet = new Set();
  let resumeOffset = 0;
  if (RESUME) {
    const existingResults = loadResultsJsonl(RESULTS_JSONL);
    existingResults.forEach((_, id) => enrichedSet.add(id));
    resumeOffset = loadProgress();
    if (enrichedSet.size > 0) {
      log(`Resumed: ${enrichedSet.size} companies already on disk, progress at ${resumeOffset}`);
    }
  } else {
    // Fresh start — clear old results
    if (fs.existsSync(RESULTS_JSONL)) fs.unlinkSync(RESULTS_JSONL);
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
  }

  // Skip already-processed companies
  const remaining = companies.slice(resumeOffset);
  log(`${remaining.length} companies to process (skipping ${resumeOffset} already done)`);

  // Launch browser
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  log(
    `Starting enrichment: ${remaining.length} companies, concurrency=${CONCURRENCY}, delay=${DELAY}ms`
  );

  const totalProcessed = await enrichAll(
    browser,
    remaining,
    resumeOffset,
    enrichedSet,
    RESULTS_JSONL
  );

  await browser.close();

  // Build final output: read all results from JSONL, merge with input
  log('\nBuilding final output...');
  const allResultsMap = loadResultsJsonl(RESULTS_JSONL);
  const finalData = allCompanies.map((c) => allResultsMap.get(c.yellId) || c);

  // Save output
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `yellge_enriched_${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(finalData, null, 2), 'utf-8');
  log(`📄 Saved ${finalData.length} companies to ${jsonPath}`);

  // CSV
  const csvPath = path.join(OUT_DIR, `yellge_enriched_${ts}.csv`);
  fs.writeFileSync(csvPath, buildCSV(finalData), 'utf-8');
  log(`📄 Saved CSV to ${csvPath}`);

  // Clean up progress (keep JSONL as backup)
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

  // Summary
  const allResults = [...allResultsMap.values()];
  const matched = allResults.filter((r) => r.gm_matched).length;
  const withImages = allResults.filter((r) => r.gm_imageUrls?.length > 0).length;
  const withReviews = allResults.filter((r) => r.gm_reviews?.length > 0).length;
  const avgRating =
    allResults.filter((r) => r.gm_rating > 0).length > 0
      ? (
          allResults
            .filter((r) => r.gm_rating > 0)
            .reduce((s, r) => s + r.gm_rating, 0) /
          allResults.filter((r) => r.gm_rating > 0).length
        ).toFixed(1)
      : 'N/A';

  console.log('\n' + '═'.repeat(56));
  console.log('  GOOGLE MAPS ENRICHMENT COMPLETE');
  console.log('═'.repeat(56));
  console.log(`  Processed:        ${allResults.length}`);
  console.log(`  GMaps matched:    ${matched} (${Math.round((matched / allResults.length) * 100)}%)`);
  console.log(`  With images:      ${withImages}`);
  console.log(`  With reviews:     ${withReviews}`);
  console.log(`  Avg GMaps rating: ${avgRating}★`);
  console.log('═'.repeat(56));
}

// ═══════════════════════════════════════════
//  CSV EXPORT
// ═══════════════════════════════════════════

function buildCSV(data) {
  const headers = [
    'yellId', 'name', 'address', 'phones', 'emails', 'website',
    'facebook', 'instagram', 'categories', 'rating', 'identificationNumber',
    // GMaps enriched fields
    'gm_matched', 'gm_matchScore', 'gm_name', 'gm_category', 'gm_address',
    'gm_phone', 'gm_website', 'gm_rating', 'gm_reviewsCount', 'gm_priceLevel',
    'gm_description', 'gm_workingHours', 'gm_placeId', 'gm_lat', 'gm_lng',
    'gm_url', 'gm_imageUrls', 'gm_reviewSnippets', 'gm_menuLink', 'gm_bookingLink',
    'yellUrl', 'sourceCategory',
  ];

  const esc = (val) => {
    let s = val == null ? '' : String(val);
    if (Array.isArray(val)) s = val.join('; ');
    s = s.replace(/"/g, '""');
    return `"${s}"`;
  };

  const BOM = '\uFEFF';
  const rows = data.map((c) =>
    headers.map((h) => esc(c[h])).join(',')
  );

  return BOM + [headers.join(','), ...rows].join('\n');
}

// ═══════════════════════════════════════════
//  RUN
// ═══════════════════════════════════════════
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
