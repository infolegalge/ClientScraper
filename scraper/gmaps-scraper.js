#!/usr/bin/env node
/**
 * Google Maps Business Scraper (Multi-Query Parallel)
 * 
 * Usage:
 *   node gmaps-scraper.js "dental clinic Tbilisi"
 *   node gmaps-scraper.js "სტომატოლოგიური კლინიკა თბილისი" --lang ka --max 50
 *   node gmaps-scraper.js "query one" "query two" "query three" --max 120
 *   node gmaps-scraper.js --queries queries.txt --max 120
 * 
 * Options:
 *   --lang        Language for Google Maps (ka, en, ru)    default: ka
 *   --max         Max businesses per query                 default: 120
 *   --headed      Run with visible browser (debug)
 *   --out         Output directory for results             default: ./output
 *   --delay       Extra delay between actions in ms        default: 500
 *   --queries     Path to a text file with one query per line
 *   --concurrency Max parallel browser contexts            default: 3
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── CLI Parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

// Collect all positional (non-flag) arguments as queries
const BOOLEAN_FLAGS = new Set(['headed']);
const queries = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const flagName = args[i].slice(2);
    if (!BOOLEAN_FLAGS.has(flagName)) i++; // skip value for non-boolean flags
    continue;
  }
  queries.push(args[i]);
}

function getFlag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}
const LANG        = getFlag('lang', 'ka');
const MAX         = parseInt(getFlag('max', '120'), 10);
const HEADED      = args.includes('--headed');
const OUT_DIR     = getFlag('out', './output');
const DELAY       = parseInt(getFlag('delay', '500'), 10);
const CONCURRENCY = parseInt(getFlag('concurrency', '3'), 10);

// Load queries from file if --queries is specified
const queriesFile = getFlag('queries', '');
if (queriesFile && fs.existsSync(queriesFile)) {
  const fileQueries = fs.readFileSync(queriesFile, 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  queries.push(...fileQueries);
  log(`Loaded ${fileQueries.length} queries from ${queriesFile}`);
}

if (queries.length === 0) {
  console.error('Usage: node gmaps-scraper.js "query1" "query2" [options]');
  console.error('       node gmaps-scraper.js --queries queries.txt [options]');
  console.error('  --lang ka|en|ru  --max 120  --headed  --out ./output  --concurrency 3');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sanitize = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
const timestamp = () => new Date().toISOString();

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

// ── Concurrency limiter ──────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

// ── Scrape one query in its own browser context ──────────────────────────────
async function scrapeOneQuery(browser, query, queryIndex, totalQueries) {
  const tag = totalQueries > 1 ? `[Q${queryIndex + 1}/${totalQueries}] ` : '';

  const context = await browser.newContext({
    locale: LANG === 'ka' ? 'ka-GE' : LANG === 'ru' ? 'ru-RU' : 'en-US',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    geolocation: { latitude: 41.7151, longitude: 44.8271 },
    permissions: ['geolocation'],
  });

  const page = await context.newPage();

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=${LANG}`;
  log(`${tag}Navigating: "${query}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Handle consent dialog
  try {
    const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("მიღება"), button:has-text("Принять")');
    if (await consentBtn.count() > 0) {
      await consentBtn.first().click();
      log(`${tag}Dismissed consent dialog`);
      await sleep(1500);
    }
  } catch { /* no consent dialog */ }

  // Scroll and collect listings
  log(`${tag}Scrolling results for "${query}"...`);
  const listingLinks = await scrollAndCollectListings(page, MAX);
  log(`${tag}Found ${listingLinks.length} listings for "${query}"`);

  // Visit each listing and extract data
  const businesses = [];
  for (let i = 0; i < listingLinks.length; i++) {
    log(`${tag}Scraping ${i + 1}/${listingLinks.length}: ${listingLinks[i].name}`);
    try {
      const biz = await scrapeListing(page, listingLinks[i], context);
      biz._sourceQuery = query;
      businesses.push(biz);
      log(`${tag}  ✓ ${biz.name} | ${biz.rating}★ (${biz.reviewsCount}) | ${biz.phone || 'no phone'} | ${biz.emails?.length ? biz.emails.join(', ') : 'no email'}`);
    } catch (err) {
      log(`${tag}  ✗ Error scraping: ${err.message}`);
    }
    await sleep(DELAY);
  }

  await context.close();
  log(`${tag}Done — ${businesses.length} businesses from "${query}"`);
  return businesses;
}

// ── Deduplicate across all queries ───────────────────────────────────────────
function deduplicateBusinesses(allBusinesses) {
  const byPlaceId = new Map();
  const byNameAddr = new Map();

  for (const biz of allBusinesses) {
    // Primary key: placeId
    if (biz.placeId) {
      if (byPlaceId.has(biz.placeId)) {
        // Merge: keep the one with more data (more emails, reviews, etc.)
        const existing = byPlaceId.get(biz.placeId);
        byPlaceId.set(biz.placeId, mergeBusinesses(existing, biz));
        continue;
      }
      byPlaceId.set(biz.placeId, biz);
      continue;
    }

    // Fallback key: normalized name + address
    const key = `${(biz.name || '').toLowerCase().trim()}||${(biz.address || '').toLowerCase().trim()}`;
    if (key !== '||' && byNameAddr.has(key)) {
      const existing = byNameAddr.get(key);
      byNameAddr.set(key, mergeBusinesses(existing, biz));
      continue;
    }
    if (key !== '||') {
      byNameAddr.set(key, biz);
    }
  }

  // Merge the two maps, avoiding double-counting
  const placeIdResults = [...byPlaceId.values()];
  const placeIds = new Set(placeIdResults.map(b => b.placeId));
  const nameAddrResults = [...byNameAddr.values()].filter(b => !placeIds.has(b.placeId));

  return [...placeIdResults, ...nameAddrResults];
}

function mergeBusinesses(a, b) {
  // Keep whichever has more reviews as the base, merge missing fields from the other
  const base = (a.reviewsCount || 0) >= (b.reviewsCount || 0) ? { ...a } : { ...b };
  const other = base === a ? b : a;

  // Merge emails
  base.emails = [...new Set([...(a.emails || []), ...(b.emails || [])])];
  // Merge source queries
  base._sourceQueries = [...new Set([
    ...(a._sourceQueries || [a._sourceQuery]),
    ...(b._sourceQueries || [b._sourceQuery]),
  ])].filter(Boolean);
  // Fill missing fields from the other
  for (const key of ['phone', 'website', 'address', 'description', 'aboutSummary']) {
    if (!base[key] && other[key]) base[key] = other[key];
  }
  // Merge images
  base.imageUrls = [...new Set([...(base.imageUrls || []), ...(other.imageUrls || [])])];
  // Merge social links
  base.socialLinks = [...new Set([...(base.socialLinks || []), ...(other.socialLinks || [])])];

  return base;
}

// ── Main Scraper ─────────────────────────────────────────────────────────────
async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const isMulti = queries.length > 1;
  log(`Starting scrape: ${queries.length} quer${isMulti ? 'ies' : 'y'} | lang=${LANG} max=${MAX}/query | concurrency=${CONCURRENCY}`);
  if (isMulti) queries.forEach((q, i) => log(`  Q${i + 1}: "${q}"`));

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Run all queries in parallel with concurrency limit
  const tasks = queries.map((q, i) => () => scrapeOneQuery(browser, q, i, queries.length));
  const allResults = await runWithConcurrency(tasks, CONCURRENCY);
  const allBusinesses = allResults.flat();

  await browser.close();

  // Deduplicate across all queries
  const unique = deduplicateBusinesses(allBusinesses);
  log(`\nMerged: ${allBusinesses.length} total → ${unique.length} unique businesses (${allBusinesses.length - unique.length} duplicates removed)`);

  // Save results
  const safeQuery = queries.length === 1
    ? sanitize(queries[0])
    : sanitize(queries[0]) + `_+${queries.length - 1}more`;
  const ts = Date.now();
  const jsonPath = path.join(OUT_DIR, `${safeQuery}_${ts}.json`);
  const csvPath  = path.join(OUT_DIR, `${safeQuery}_${ts}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(unique, null, 2), 'utf-8');
  log(`JSON saved: ${jsonPath}`);

  fs.writeFileSync(csvPath, toCSV(unique), 'utf-8');
  log(`CSV saved: ${csvPath}`);

  // Summary
  printSummary(unique);

  return unique;
}

// ── Scroll the results panel and collect listing links ───────────────────────
async function scrollAndCollectListings(page, max) {
  const resultsSelector = 'div[role="feed"]';
  
  // Wait for the results feed to appear
  try {
    await page.waitForSelector(resultsSelector, { timeout: 10000 });
  } catch {
    log('Could not find results feed — trying alternative selector');
    await sleep(2000);
  }

  const collected = new Map();
  let noNewCount = 0;
  const maxScrollAttempts = Math.max(80, max * 2);

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // Gather all visible listing links
    const items = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/maps/place/"]');
      return Array.from(links).map(a => {
        const name = a.getAttribute('aria-label') || a.textContent?.trim()?.slice(0, 60) || '';
        const href = a.href;
        return { name, href };
      }).filter(x => x.href && x.name);
    });

    const prevSize = collected.size;
    for (const item of items) {
      if (!collected.has(item.href)) {
        collected.set(item.href, item);
      }
    }

    if (collected.size >= max) break;

    if (collected.size === prevSize) {
      noNewCount++;
      if (noNewCount >= 5) {
        log(`No new listings after ${noNewCount} scrolls — reached end of results`);
        break;
      }
    } else {
      noNewCount = 0;
    }

    // Scroll the results panel
    await page.evaluate((sel) => {
      const feed = document.querySelector(sel);
      if (feed) feed.scrollTop += 600;
    }, resultsSelector);
    await sleep(800 + Math.random() * 400);

    if (attempt % 10 === 0 && attempt > 0) {
      log(`  ...scrolled ${attempt}x, found ${collected.size} listings so far`);
    }
  }

  return Array.from(collected.values()).slice(0, max);
}

// ── Scrape a single listing ──────────────────────────────────────────────────
async function scrapeListing(page, listing, context) {
  // Click the listing link to open the detail panel
  await page.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2000);

  // Extract all the data from the listing detail panel
  const data = await page.evaluate(() => {
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    // Name
    const name = $('h1')?.textContent?.trim() || '';

    // Category
    const categoryBtn = $('button[jsaction*="category"]') || $('button.DkEaL');
    const category = categoryBtn?.textContent?.trim() || '';

    // All categories 
    const allCategories = $$('button[jsaction*="category"], button.DkEaL')
      .map(b => b.textContent?.trim()).filter(Boolean);

    // Address
    const addressEl = $('button[data-item-id="address"] .Io6YTe, button[data-item-id="address"]');
    const address = addressEl?.textContent?.trim()?.replace(/^[\s\S]*?📍\s*/, '') || '';

    // Phone  
    const phoneEl = $('button[data-item-id*="phone"] .Io6YTe, button[data-item-id*="phone"]');
    const phone = phoneEl?.textContent?.trim() || '';

    // Website
    const websiteEl = $('a[data-item-id="authority"] .Io6YTe, a[data-item-id="authority"]');
    const website = websiteEl?.closest('a')?.href || '';

    // Rating  
    const ratingEl = $('div.F7nice span[aria-hidden]');
    const rating = parseFloat(ratingEl?.textContent?.replace(',', '.') || '0');

    // Review count
    const reviewCountEl = $('div.F7nice span[aria-label*="review"], div.F7nice span[aria-label*="მიმოხილვა"], div.F7nice span[aria-label]');
    const reviewsText = reviewCountEl?.getAttribute('aria-label') || reviewCountEl?.textContent || '';
    const reviewsCount = parseInt(reviewsText.replace(/[^\d]/g, '') || '0', 10);

    // Price level
    const priceEl = $('span[aria-label*="Price"], span[aria-label*="ფასი"]');
    const priceLevel = priceEl?.textContent?.trim() || '';

    // Description / editorial summary
    const descEl = $('div.PYvSYb span, div[class*="editorial"]');
    const description = descEl?.textContent?.trim() || '';

    // About summary
    const aboutEl = $('div[aria-label*="About"] p, div.WeS02d');
    const aboutSummary = aboutEl?.textContent?.trim() || '';

    // Working hours
    const hoursEls = $$('table.eK4R0e tr, table[class*="hour"] tr, div.OqCZI div[aria-label]');
    const workingHours = hoursEls.map(el => el.textContent?.trim()).filter(Boolean);
    // Fallback: try the hours aria-label
    if (!workingHours.length) {
      const hoursBtn = $('div[data-hide-tooltip-on-mouse-move] button[aria-label], button[aria-label*="hour"], button[data-item-id*="hour"]');
      if (hoursBtn) {
        const aria = hoursBtn.getAttribute('aria-label') || '';
        if (aria) workingHours.push(...aria.split(/[;.]\s*/));
      }
    }

    // Plus code
    const plusEl = $('button[data-item-id="oloc"] .Io6YTe');
    const plusCode = plusEl?.textContent?.trim() || '';

    // Place ID from URL
    const urlMatch = window.location.href.match(/0x[\da-f]+:0x[\da-f]+/i);
    const placeId = urlMatch ? urlMatch[0] : '';

    // Coordinates from URL
    let lat = '', lng = '';
    const coordMatch = window.location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (coordMatch) {
      lat = coordMatch[1];
      lng = coordMatch[2];
    }
    // Also try data-coordinates
    const dataCoord = window.location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (dataCoord && !lat) {
      lat = dataCoord[1];
      lng = dataCoord[2];
    }

    // Images
    const imageUrls = $$('button[jsaction*="photo"] img, div[jsaction*="photo"] img, img.gallery-cell, img[decoding]')
      .map(img => img.src || img.dataset?.src || '')
      .filter(u => u.startsWith('https://'));

    // Also grab from the main photo and carousel
    const heroImg = $('img.RZ66Rb, img[decoding="async"][src*="googleusercontent"]');
    if (heroImg?.src && heroImg.src.startsWith('https://')) {
      imageUrls.unshift(heroImg.src);
    }

    // Google Maps URL
    const googleMapsUrl = window.location.href;

    // Extract attribute sections (services, amenities, etc.)
    function getAttributeSection(label) {
      const sections = $$('div[aria-label]');
      for (const sec of sections) {
        const ariaLabel = sec.getAttribute('aria-label') || '';
        if (ariaLabel.toLowerCase().includes(label.toLowerCase())) {
          return $$('li', sec).map(li => li.textContent?.trim()).filter(Boolean);
        }
      }
      return [];
    }

    // Social links
    const socialLinks = $$('a[data-tooltip*="facebook"], a[data-tooltip*="instagram"], a[data-tooltip*="twitter"], a[href*="facebook.com"], a[href*="instagram.com"]')
      .map(a => a.href).filter(Boolean);

    // Menu link / booking link
    const menuEl = $('a[data-item-id="menu"], a[aria-label*="Menu"], a[aria-label*="მენიუ"]');
    const menuLink = menuEl?.href || '';
    const bookingEl = $('a[data-item-id*="reserve"], a[data-item-id*="book"], a[aria-label*="appointment"]');
    const bookingLink = bookingEl?.href || '';

    return {
      name,
      category: category || allCategories[0] || '',
      allCategories: [...new Set(allCategories)],
      address,
      phone,
      website,
      rating,
      reviewsCount,
      priceLevel,
      description,
      aboutSummary,
      services: getAttributeSection('service'),
      amenities: getAttributeSection('amenities'),
      accessibility: getAttributeSection('accessibility'),
      highlights: getAttributeSection('highlights'),
      offerings: getAttributeSection('offerings'),
      diningOptions: getAttributeSection('dining'),
      payments: getAttributeSection('payment'),
      workingHours,
      plusCode,
      coordinates: { lat, lng },
      placeId,
      imageUrls: [...new Set(imageUrls)],
      logoUrl: '',
      socialLinks,
      menuLink,
      bookingLink,
      ownerName: '',
      googleMapsUrl,
    };
  });

  // ── Collect emails from ALL sources ──
  const allEmails = new Set();

  // Source 1: Google Maps listing page itself (already loaded)
  const gmapEmails = await scrapeEmailsFromGMapsPage(page);
  gmapEmails.forEach(e => allEmails.add(e));

  // Source 2: Business website (homepage + /contact page)
  const websiteEmails = await scrapeEmailsFromWebsite(context, data.website);
  websiteEmails.forEach(e => allEmails.add(e));

  // Source 3: Facebook page (if in socialLinks)
  const fbUrl = (data.socialLinks || []).find(u => u.includes('facebook.com'));
  if (fbUrl) {
    const fbEmails = await scrapeEmailsFromFacebook(context, fbUrl);
    fbEmails.forEach(e => allEmails.add(e));
  }

  // Source 4: Google Search fallback (only if still no emails)
  if (allEmails.size === 0 && data.name) {
    const searchEmails = await scrapeEmailsFromGoogleSearch(context, data.name);
    searchEmails.forEach(e => allEmails.add(e));
  }

  const emails = [...allEmails];
  if (emails.length > 0) {
    log(`  📧 Total: ${emails.length} email(s) from ${gmapEmails.length ? 'GMaps ' : ''}${websiteEmails.length ? 'Website ' : ''}${fbUrl && allEmails.size > websiteEmails.length + gmapEmails.length ? 'Facebook ' : ''}${allEmails.size > websiteEmails.length + gmapEmails.length && !fbUrl ? 'Search' : ''}`);
  }

  // Now scrape reviews — click the reviews tab
  const reviews = await scrapeReviews(page);

  // Analysis
  const analysis = analyzeWebPresence(data);

  return {
    ...data,
    emails,
    reviews,
    reviewSnippets: reviews.slice(0, 5).map(r => r.text?.slice(0, 200) || ''),
    scrapedAt: timestamp(),
    analysis,
  };
}

// ── Email regex + filter (shared) ────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
function filterEmails(raw) {
  return raw.filter(e =>
    !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.svg') &&
    !e.endsWith('.gif') && !e.endsWith('.webp') && !e.endsWith('.css') &&
    !e.endsWith('.js') && !e.endsWith('.woff') && !e.endsWith('.woff2') &&
    !e.includes('example.com') && !e.includes('sentry') &&
    !e.includes('webpack') && !e.includes('wixpress') &&
    !e.includes('googleusercontent') && !e.includes('gstatic') &&
    !e.includes('schema.org') && !e.includes('w3.org') &&
    !e.includes('noreply') && !e.includes('no-reply') &&
    e.length < 80 && e.length > 5
  );
}

// ── Source 1: Scrape emails from Google Maps listing page ────────────────────
async function scrapeEmailsFromGMapsPage(page) {
  try {
    const emails = await page.evaluate((reStr) => {
      const re = new RegExp(reStr, 'g');
      const found = new Set();
      // Check all text content on page
      const bodyText = document.body?.innerText || '';
      (bodyText.match(re) || []).forEach(m => found.add(m.toLowerCase()));
      // Check mailto links
      document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        const addr = a.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
        if (addr) found.add(addr);
      });
      // Check aria-labels (GMaps hides some info in aria)
      document.querySelectorAll('[aria-label]').forEach(el => {
        const label = el.getAttribute('aria-label') || '';
        (label.match(re) || []).forEach(m => found.add(m.toLowerCase()));
      });
      // Check data-tooltip attributes
      document.querySelectorAll('[data-tooltip]').forEach(el => {
        const tip = el.getAttribute('data-tooltip') || '';
        (tip.match(re) || []).forEach(m => found.add(m.toLowerCase()));
      });
      return [...found];
    }, EMAIL_RE.source);
    const filtered = filterEmails(emails);
    if (filtered.length) log(`  📧 GMaps page: ${filtered.length} email(s)`);
    return filtered;
  } catch (err) {
    log(`  📧 GMaps page scan failed: ${err.message}`);
    return [];
  }
}

// ── Source 2: Scrape emails from business website ────────────────────────────
async function scrapeEmailsFromWebsite(context, websiteUrl) {
  if (!websiteUrl || websiteUrl.includes('facebook.com') || websiteUrl.includes('instagram.com')) {
    return [];
  }
  let page2;
  try {
    page2 = await context.newPage();
    await page2.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);

    const emails = await extractEmailsFromPage(page2);

    // Also check /contact page if no emails found on homepage
    if (emails.length === 0) {
      try {
        const contactLink = await page2.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          const match = links.find(a =>
            /contact|კონტაქტ|связ|about|ჩვენს?\s*შესახებ/i.test(a.href + ' ' + a.textContent)
          );
          return match?.href || '';
        });
        if (contactLink) {
          await page2.goto(contactLink, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await sleep(1500);
          const contactEmails = await extractEmailsFromPage(page2);
          emails.push(...contactEmails);
        }
      } catch { /* contact page not found or failed */ }
    }

    await page2.close();
    if (emails.length) log(`  📧 Website: ${emails.length} email(s) from ${websiteUrl}`);
    return [...new Set(emails)];
  } catch (err) {
    if (page2) await page2.close().catch(() => {});
    log(`  📧 Could not scrape website for emails: ${err.message}`);
    return [];
  }
}

// ── Source 3: Scrape emails from Facebook page ───────────────────────────────
async function scrapeEmailsFromFacebook(context, fbUrl) {
  let page2;
  try {
    // Visit the Facebook About page (most likely contains contact info)
    let aboutUrl = fbUrl.replace(/\/$/, '');
    if (!aboutUrl.includes('/about')) aboutUrl += '/about';
    
    page2 = await context.newPage();
    // Set a realistic user agent to avoid FB blocking
    await page2.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page2.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(3000);

    const emails = await page2.evaluate((reStr) => {
      const re = new RegExp(reStr, 'g');
      const found = new Set();
      
      // Scan full page text
      const bodyText = document.body?.innerText || '';
      (bodyText.match(re) || []).forEach(m => found.add(m.toLowerCase()));
      
      // Check mailto links
      document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        const addr = a.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
        if (addr) found.add(addr);
      });

      // Scan all span/div text nodes that might contain email
      document.querySelectorAll('span, div').forEach(el => {
        const t = el.textContent || '';
        if (t.includes('@') && t.length < 100) {
          (t.match(re) || []).forEach(m => found.add(m.toLowerCase()));
        }
      });

      return [...found];
    }, EMAIL_RE.source);

    await page2.close();
    const filtered = filterEmails(emails).filter(e => !e.includes('facebook.com'));
    if (filtered.length) log(`  📧 Facebook: ${filtered.length} email(s) from ${fbUrl}`);
    return filtered;
  } catch (err) {
    if (page2) await page2.close().catch(() => {});
    log(`  📧 Facebook scrape failed: ${err.message}`);
    return [];
  }
}

// ── Source 4: Google Search for clinic email ─────────────────────────────────
async function scrapeEmailsFromGoogleSearch(context, clinicName) {
  let page2;
  try {
    page2 = await context.newPage();
    // Search for "clinic name" email / contact
    const query = encodeURIComponent(`"${clinicName}" email`);
    await page2.goto(`https://www.google.com/search?q=${query}&hl=en`, {
      waitUntil: 'domcontentloaded', timeout: 15000
    });
    await sleep(2000);

    const emails = await page2.evaluate((reStr) => {
      const re = new RegExp(reStr, 'g');
      const found = new Set();
      // Scan all search result text
      const bodyText = document.body?.innerText || '';
      (bodyText.match(re) || []).forEach(m => found.add(m.toLowerCase()));
      return [...found];
    }, EMAIL_RE.source);

    await page2.close();
    const filtered = filterEmails(emails);
    if (filtered.length) log(`  📧 Google Search: ${filtered.length} email(s) for "${clinicName}"`);
    return filtered;
  } catch (err) {
    if (page2) await page2.close().catch(() => {});
    log(`  📧 Google search failed: ${err.message}`);
    return [];
  }
}

// ── Helper: extract emails from any open page ────────────────────────────────
async function extractEmailsFromPage(page) {
  const emails = await page.evaluate((reStr) => {
    const re = new RegExp(reStr, 'g');
    const found = new Set();
    // mailto links
    document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
      const addr = a.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
      if (addr) found.add(addr);
    });
    // Visible page text
    const bodyText = document.body?.innerText || '';
    (bodyText.match(re) || []).forEach(m => found.add(m.toLowerCase()));
    return [...found];
  }, EMAIL_RE.source);
  return filterEmails(emails);
}

// ── Scrape reviews ───────────────────────────────────────────────────────────
async function scrapeReviews(page) {
  try {
    // Try clicking the reviews tab/button
    const reviewTab = page.locator('button[aria-label*="review"], button[aria-label*="მიმოხილვ"], button[role="tab"]:has-text("review"), button[role="tab"]:has-text("მიმოხილვ")');
    if (await reviewTab.count() > 0) {
      await reviewTab.first().click();
      await sleep(2000);
    }

    // Scroll through reviews to load more
    const reviewsPanel = page.locator('div.m6QErb[aria-label]');
    if (await reviewsPanel.count() > 0) {
      for (let i = 0; i < 5; i++) {
        await reviewsPanel.first().evaluate(el => el.scrollTop += 500);
        await sleep(600);
      }
    }

    // Expand "More" buttons on reviews
    const moreButtons = page.locator('button.w8nwRe, button[aria-label*="More"], button[jsaction*="review.expand"]');
    const moreCount = await moreButtons.count();
    for (let i = 0; i < Math.min(moreCount, 10); i++) {
      try { await moreButtons.nth(i).click(); } catch { }
    }
    await sleep(500);

    // Extract review data
    const reviews = await page.evaluate(() => {
      const reviewEls = document.querySelectorAll('div[data-review-id], div.jftiEf');
      return Array.from(reviewEls).slice(0, 20).map(el => {
        const authorEl = el.querySelector('div.d4r55, button[class*="name"], a[class*="name"]');
        const author = authorEl?.textContent?.trim() || '';

        const starsEl = el.querySelector('span[role="img"], span[aria-label*="star"], span[aria-label*="ვარსკვლა"]');
        const starsText = starsEl?.getAttribute('aria-label') || '';
        const rating = parseInt(starsText.match(/\d/)?.[0] || '0', 10);

        const dateEl = el.querySelector('span.rsqaWe, span[class*="date"]');
        const date = dateEl?.textContent?.trim() || '';

        const textEl = el.querySelector('span.wiI7pd, div.MyEned span');
        const text = textEl?.textContent?.trim() || '';

        const responseEl = el.querySelector('div.CDe7pd span');
        const ownerResponse = responseEl?.textContent?.trim() || '';

        return { author, rating, date, text, ownerResponse };
      }).filter(r => r.author || r.text);
    });

    return reviews;
  } catch {
    return [];
  }
}

// ── Analyze web presence (matches existing format) ───────────────────────────
function analyzeWebPresence(data) {
  const w = data.website || '';
  return {
    hasWebsite: !!w,
    hasHttps: w.startsWith('https://'),
    isMobileResponsive: false, // would need to actually test
    needsNewWebsite: !w || w.includes('facebook.com'),
    needsReputationManagement: data.rating < 4.0 || data.reviewsCount < 5,
    websiteIsFacebookOnly: w.includes('facebook.com'),
  };
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function toCSV(businesses) {
  const headers = [
    'name', 'category', 'address', 'phone', 'email', 'website', 'rating',
    'reviewsCount', 'priceLevel', 'workingHours', 'placeId',
    'lat', 'lng', 'googleMapsUrl', 'hasWebsite', 'needsNewWebsite', 'scrapedAt',
  ];

  const escCSV = (val) => {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = businesses.map(b => headers.map(h => {
    if (h === 'email') return escCSV((b.emails || []).join('; '));
    if (h === 'lat') return escCSV(b.coordinates?.lat);
    if (h === 'lng') return escCSV(b.coordinates?.lng);
    if (h === 'workingHours') return escCSV((b.workingHours || []).join(' | '));
    if (h === 'hasWebsite') return escCSV(b.analysis?.hasWebsite);
    if (h === 'needsNewWebsite') return escCSV(b.analysis?.needsNewWebsite);
    return escCSV(b[h]);
  }).join(','));

  return [headers.join(','), ...rows].join('\n');
}

// ── Summary ──────────────────────────────────────────────────────────────────
function printSummary(businesses) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  SCRAPE COMPLETE — ${businesses.length} businesses`);
  console.log('═'.repeat(60));
  
  const withEmail = businesses.filter(b => b.emails?.length > 0).length;
  const withWebsite = businesses.filter(b => b.analysis?.hasWebsite).length;
  const needsWebsite = businesses.filter(b => b.analysis?.needsNewWebsite).length;
  const avgRating = businesses.length
    ? (businesses.reduce((s, b) => s + (b.rating || 0), 0) / businesses.length).toFixed(1)
    : 0;
  const totalReviews = businesses.reduce((s, b) => s + (b.reviewsCount || 0), 0);

  console.log(`  With email:      ${withEmail} / ${businesses.length}`);
  console.log(`  With website:    ${withWebsite} / ${businesses.length}`);
  console.log(`  Need website:    ${needsWebsite} / ${businesses.length}`);
  console.log(`  Avg rating:      ${avgRating}★`);
  console.log(`  Total reviews:   ${totalReviews}`);
  console.log('═'.repeat(60));

  // Top prospects (no website, decent reviews)
  const prospects = businesses
    .filter(b => b.analysis?.needsNewWebsite && b.rating >= 4.0)
    .sort((a, b) => b.reviewsCount - a.reviewsCount)
    .slice(0, 10);

  if (prospects.length > 0) {
    console.log('\n  🎯 TOP PROSPECTS (no website, 4.0+ rating):');
    prospects.forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.name} — ${b.rating}★ (${b.reviewsCount} reviews) ${b.phone || ''}`);
    });
    console.log('');
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
