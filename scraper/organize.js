#!/usr/bin/env node
/**
 * Google Maps Data Organizer
 * 
 * Works on JSON files produced by gmaps-scraper.js
 * Filters, sorts, deduplicates, and generates reports.
 * 
 * Usage:
 *   node organize.js input.json                          # Organize and deduplicate
 *   node organize.js input.json --filter "no-website"    # Only businesses without websites
 *   node organize.js input.json --filter "high-rated"    # Rating >= 4.5
 *   node organize.js input.json --filter "low-reviews"   # < 10 reviews (opportunity)
 *   node organize.js input.json --sort rating            # Sort by rating desc
 *   node organize.js input.json --sort reviews           # Sort by review count desc
 *   node organize.js input.json --sort name              # Sort alphabetically
 *   node organize.js input.json --merge other.json       # Merge two datasets 
 *   node organize.js input.json --report                 # Generate HTML report
 */

const fs = require('fs');
const path = require('path');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputFiles = args.filter(a => a.endsWith('.json') && !a.startsWith('--'));

if (inputFiles.length === 0) {
  console.error('Usage: node organize.js <input.json> [options]');
  console.error('  --filter no-website|high-rated|low-reviews|has-phone|needs-help');
  console.error('  --sort rating|reviews|name');
  console.error('  --merge <other.json>');
  console.error('  --report');
  console.error('  --csv');
  console.error('  --out <directory>');
  process.exit(1);
}

function getFlag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

const FILTER   = getFlag('filter', null);
const SORT     = getFlag('sort', null);
const MERGE    = getFlag('merge', null);
const REPORT   = args.includes('--report');
const CSV      = args.includes('--csv');
const OUT_DIR  = getFlag('out', './output');

// ── Load & Merge ─────────────────────────────────────────────────────────────
let allBiz = [];

for (const file of inputFiles) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : [raw];
  console.log(`Loaded ${arr.length} businesses from ${path.basename(file)}`);
  allBiz.push(...arr);
}

if (MERGE) {
  const mergeFiles = [MERGE, ...args.filter((a, i) => i > args.indexOf('--merge') + 1 && a.endsWith('.json'))];
  for (const mf of mergeFiles) {
    if (fs.existsSync(mf)) {
      const extra = JSON.parse(fs.readFileSync(mf, 'utf-8'));
      const arr = Array.isArray(extra) ? extra : [extra];
      console.log(`Merged ${arr.length} businesses from ${path.basename(mf)}`);
      allBiz.push(...arr);
    }
  }
}

// ── Deduplicate by placeId then by name+address ──────────────────────────────
function deduplicate(businesses) {
  const byPlaceId = new Map();
  const byNameAddr = new Map();
  const result = [];

  for (const b of businesses) {
    if (b.placeId && byPlaceId.has(b.placeId)) continue;
    const nameKey = `${(b.name || '').toLowerCase().trim()}|${(b.address || '').toLowerCase().trim()}`;
    if (byNameAddr.has(nameKey)) continue;

    if (b.placeId) byPlaceId.set(b.placeId, true);
    byNameAddr.set(nameKey, true);
    result.push(b);
  }

  return result;
}

allBiz = deduplicate(allBiz);
console.log(`After deduplication: ${allBiz.length} unique businesses\n`);

// ── Filter ───────────────────────────────────────────────────────────────────
if (FILTER) {
  const before = allBiz.length;
  switch (FILTER) {
    case 'no-website':
      allBiz = allBiz.filter(b => !b.website || b.analysis?.needsNewWebsite);
      break;
    case 'has-website':
      allBiz = allBiz.filter(b => b.website && !b.analysis?.needsNewWebsite);
      break;
    case 'high-rated':
      allBiz = allBiz.filter(b => b.rating >= 4.5);
      break;
    case 'low-reviews':
      allBiz = allBiz.filter(b => b.reviewsCount < 10);
      break;
    case 'has-phone':
      allBiz = allBiz.filter(b => b.phone);
      break;
    case 'needs-help':
      // High potential but poor web presence
      allBiz = allBiz.filter(b => b.rating >= 4.0 && b.analysis?.needsNewWebsite);
      break;
    default:
      console.warn(`Unknown filter: ${FILTER}`);
  }
  console.log(`Filter "${FILTER}": ${before} → ${allBiz.length} businesses`);
}

// ── Sort ─────────────────────────────────────────────────────────────────────
if (SORT) {
  switch (SORT) {
    case 'rating':
      allBiz.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      break;
    case 'reviews':
      allBiz.sort((a, b) => (b.reviewsCount || 0) - (a.reviewsCount || 0));
      break;
    case 'name':
      allBiz.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      break;
    default:
      console.warn(`Unknown sort: ${SORT}`);
  }
  console.log(`Sorted by: ${SORT}`);
}

// ── Output ───────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

// Always save organized JSON
const baseName = path.basename(inputFiles[0], '.json');
const organizedPath = path.join(OUT_DIR, `${baseName}_organized.json`);
fs.writeFileSync(organizedPath, JSON.stringify(allBiz, null, 2), 'utf-8');
console.log(`\nSaved: ${organizedPath}`);

// CSV export
if (CSV) {
  const csvPath = path.join(OUT_DIR, `${baseName}_organized.csv`);
  fs.writeFileSync(csvPath, toCSV(allBiz), 'utf-8');
  console.log(`Saved: ${csvPath}`);
}

// HTML Report
if (REPORT) {
  const htmlPath = path.join(OUT_DIR, `${baseName}_report.html`);
  fs.writeFileSync(htmlPath, generateReport(allBiz), 'utf-8');
  console.log(`Saved: ${htmlPath}`);
}

// Print table
printTable(allBiz);

// ── Helpers ──────────────────────────────────────────────────────────────────

function toCSV(businesses) {
  const headers = [
    'name', 'category', 'address', 'phone', 'website', 'rating',
    'reviewsCount', 'priceLevel', 'workingHours', 'placeId',
    'lat', 'lng', 'googleMapsUrl', 'hasWebsite', 'needsNewWebsite', 'scrapedAt',
  ];
  const esc = (val) => {
    const s = String(val ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = businesses.map(b => headers.map(h => {
    if (h === 'lat') return esc(b.coordinates?.lat);
    if (h === 'lng') return esc(b.coordinates?.lng);
    if (h === 'workingHours') return esc((b.workingHours || []).join(' | '));
    if (h === 'hasWebsite') return esc(b.analysis?.hasWebsite);
    if (h === 'needsNewWebsite') return esc(b.analysis?.needsNewWebsite);
    return esc(b[h]);
  }).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function printTable(businesses) {
  console.log('\n' + '─'.repeat(90));
  console.log(
    pad('Name', 30) + pad('Rating', 8) + pad('Reviews', 9) +
    pad('Phone', 18) + pad('Website?', 10) + 'Category'
  );
  console.log('─'.repeat(90));

  for (const b of businesses.slice(0, 50)) {
    console.log(
      pad(truncate(b.name, 28), 30) +
      pad(`${b.rating || '-'}★`, 8) +
      pad(String(b.reviewsCount || 0), 9) +
      pad(b.phone || '-', 18) +
      pad(b.website ? '✓' : '✗', 10) +
      truncate(b.category, 20)
    );
  }

  if (businesses.length > 50) {
    console.log(`  ... and ${businesses.length - 50} more`);
  }
  console.log('─'.repeat(90));
}

function pad(s, len) {
  const str = String(s || '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function truncate(s, len) {
  return (s || '').length > len ? (s || '').slice(0, len - 1) + '…' : (s || '');
}

function generateReport(businesses) {
  const withWebsite = businesses.filter(b => b.analysis?.hasWebsite).length;
  const needsWebsite = businesses.filter(b => b.analysis?.needsNewWebsite).length;
  const avgRating = businesses.length
    ? (businesses.reduce((s, b) => s + (b.rating || 0), 0) / businesses.length).toFixed(1) : 0;
  const totalReviews = businesses.reduce((s, b) => s + (b.reviewsCount || 0), 0);

  // Category breakdown
  const cats = {};
  businesses.forEach(b => {
    const c = b.category || 'Unknown';
    cats[c] = (cats[c] || 0) + 1;
  });

  const prospects = businesses
    .filter(b => b.analysis?.needsNewWebsite && b.rating >= 4.0)
    .sort((a, b) => b.reviewsCount - a.reviewsCount)
    .slice(0, 20);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scrape Report — ${businesses.length} Businesses</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;padding:2rem}
h1{font-size:1.8rem;margin-bottom:.5rem;color:#fff}
h2{font-size:1.2rem;margin:2rem 0 1rem;color:#38bdf8;border-bottom:1px solid #1e293b;padding-bottom:.5rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:1.5rem 0}
.stat{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:1.2rem;text-align:center}
.stat .n{font-size:2rem;font-weight:700;color:#38bdf8}
.stat .l{font-size:.85rem;color:#64748b;margin-top:.3rem}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.9rem}
th{text-align:left;padding:.6rem .8rem;background:#111827;border-bottom:2px solid #1e293b;color:#94a3b8;font-weight:600;position:sticky;top:0}
td{padding:.5rem .8rem;border-bottom:1px solid #1e293b}
tr:hover td{background:#111827}
.yes{color:#22c55e}.no{color:#ef4444}
.tag{display:inline-block;background:#1e293b;padding:.15rem .5rem;border-radius:6px;font-size:.75rem;margin:.1rem}
.prospect{border-left:3px solid #22c55e}
a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>Google Maps Scrape Report</h1>
<p style="color:#64748b">${new Date().toLocaleString()} — ${businesses.length} businesses</p>

<div class="stats">
  <div class="stat"><div class="n">${businesses.length}</div><div class="l">Total Businesses</div></div>
  <div class="stat"><div class="n">${avgRating}★</div><div class="l">Avg Rating</div></div>
  <div class="stat"><div class="n">${totalReviews.toLocaleString()}</div><div class="l">Total Reviews</div></div>
  <div class="stat"><div class="n">${withWebsite}</div><div class="l">Have Website</div></div>
  <div class="stat"><div class="n">${needsWebsite}</div><div class="l">Need Website</div></div>
  <div class="stat"><div class="n">${prospects.length}</div><div class="l">Hot Prospects</div></div>
</div>

<h2>Category Breakdown</h2>
<div style="display:flex;flex-wrap:wrap;gap:.5rem">
${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
  `<span class="tag">${c} (${n})</span>`
).join('\n')}
</div>

${prospects.length > 0 ? `
<h2>🎯 Top Prospects (No Website, 4.0+ Rating)</h2>
<table>
<tr><th>#</th><th>Name</th><th>Rating</th><th>Reviews</th><th>Phone</th><th>Category</th><th>Maps</th></tr>
${prospects.map((b, i) => `<tr class="prospect">
  <td>${i + 1}</td>
  <td><strong>${esc(b.name)}</strong><br><small style="color:#64748b">${esc(b.address)}</small></td>
  <td>${b.rating}★</td>
  <td>${b.reviewsCount}</td>
  <td>${esc(b.phone)}</td>
  <td><span class="tag">${esc(b.category)}</span></td>
  <td><a href="${esc(b.googleMapsUrl)}" target="_blank">View</a></td>
</tr>`).join('\n')}
</table>` : ''}

<h2>All Businesses</h2>
<table>
<tr><th>#</th><th>Name</th><th>Rating</th><th>Reviews</th><th>Phone</th><th>Website</th><th>Category</th><th>Maps</th></tr>
${businesses.map((b, i) => `<tr>
  <td>${i + 1}</td>
  <td><strong>${esc(b.name)}</strong><br><small style="color:#64748b">${esc(b.address)}</small></td>
  <td>${b.rating || '-'}★</td>
  <td>${b.reviewsCount || 0}</td>
  <td>${esc(b.phone || '-')}</td>
  <td class="${b.website ? 'yes' : 'no'}">${b.website ? '✓' : '✗'}</td>
  <td><span class="tag">${esc(b.category)}</span></td>
  <td><a href="${esc(b.googleMapsUrl)}" target="_blank">View</a></td>
</tr>`).join('\n')}
</table>
</body></html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
