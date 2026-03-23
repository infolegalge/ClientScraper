#!/usr/bin/env node
/**
 * Prioritize enriched yell.ge companies for web-dev outreach.
 *
 * Usage:
 *   node prioritize.js output/yellge_enriched_*.json
 *   node prioritize.js output/yellge_enriched_*.json --category "DENTAL CLINICS"
 *   node prioritize.js output/yellge_enriched_*.json --min-score 50
 */

const fs = require('fs');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
if (!inputFile) {
  console.error('Usage: node prioritize.js <enriched.json> [--category "..."] [--min-score N]');
  process.exit(1);
}

const catFlag = args.indexOf('--category');
const filterCategory = catFlag !== -1 ? args[catFlag + 1] : null;

const scoreFlag = args.indexOf('--min-score');
const minScore = scoreFlag !== -1 ? parseInt(args[scoreFlag + 1], 10) : 0;

let data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
console.log(`Loaded ${data.length} companies`);

if (filterCategory) {
  const cat = filterCategory.toUpperCase();
  data = data.filter(d =>
    (d.sourceCategory || '').toUpperCase().includes(cat) ||
    (d.categories || '').toUpperCase().includes(cat)
  );
  console.log(`Filtered to "${filterCategory}": ${data.length} companies`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const hasStr = (v) => v && typeof v === 'string' && v.trim().length > 0;

function parseEmails(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(/[;,]/).map(e => e.trim()).filter(e => e.includes('@'));
}

function hasRealFacebook(fb) {
  if (!fb || !fb.trim()) return false;
  // yell.ge share links are not real FB pages
  return !fb.includes('share.php');
}

function websiteLooksBasic(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  // freebie / social-only
  return u.includes('facebook.com') || u.includes('instagram.com') ||
         u.includes('blogspot.com') || u.includes('wix.com') ||
         u.includes('weebly.com') || u.includes('sites.google.com');
}

// ── Scoring ──────────────────────────────────────────────────────────────────
// Higher = approach first.  Max theoretical ≈ 130
function score(b) {
  let s = 0;
  const emails = parseEmails(b.emails);
  const hasEmail = emails.length > 0;
  const hasPhone = hasStr(b.phones);
  const yellWebsite = hasStr(b.website);
  const gmWebsite  = hasStr(b.gm_website);
  const hasAnySite = yellWebsite || gmWebsite;
  const basicSite = websiteLooksBasic(b.website) || websiteLooksBasic(b.gm_website);

  // ── 1) Contactability  (max 40) ──
  if (hasEmail)                     s += 30;
  if (hasPhone)                     s += 8;
  if (hasStr(b.whatsapp))           s += 2;

  // ── 2) Need for a website  (max 30) ──
  if (!hasAnySite)                  s += 30;   // no website at all
  else if (basicSite)               s += 22;   // Facebook-only / free builder
  else if (!yellWebsite && gmWebsite) s += 5;  // has GMaps site but not on yell
  // else already has a proper website → 0

  // ── 3) Business quality — GMaps signals  (max 20) ──
  const rating = b.gm_rating || 0;
  const reviews = b.gm_reviewsCount || 0;

  if (rating >= 4.5)                s += 10;
  else if (rating >= 4.0)          s += 7;
  else if (rating >= 3.5)          s += 4;
  else if (rating >= 3.0)          s += 2;

  if (reviews >= 100)               s += 8;
  else if (reviews >= 50)          s += 6;
  else if (reviews >= 20)          s += 4;
  else if (reviews >= 10)          s += 3;
  else if (reviews >= 5)           s += 2;
  else if (reviews >= 1)           s += 1;

  // ── 4) GMaps data richness  (max 30) — richer data = better pitch material ──
  const imgCount = (b.gm_imageUrls || []).length;
  const revArr   = (b.gm_reviews || []);
  const services = (b.gm_services || []);
  const amenities = (b.gm_amenities || []);

  if (b.gm_matched)                s += 5;    // verified on GMaps at all

  // Images — we can use these to build their site
  if (imgCount >= 10)               s += 8;
  else if (imgCount >= 5)          s += 6;
  else if (imgCount >= 2)          s += 3;
  else if (imgCount >= 1)          s += 1;

  // Scraped reviews with text — social proof for their future site
  const reviewsWithText = revArr.filter(r => r.text && r.text.trim()).length;
  if (reviewsWithText >= 10)        s += 6;
  else if (reviewsWithText >= 5)   s += 4;
  else if (reviewsWithText >= 2)   s += 2;
  else if (reviewsWithText >= 1)   s += 1;

  // Services / amenities / description — content for site pages
  if (services.length >= 5)         s += 4;
  else if (services.length >= 1)   s += 2;
  if (amenities.length >= 1)       s += 2;
  if (hasStr(b.gm_description))    s += 2;

  // GMaps coords + address — map embed ready
  if (b.gm_lat && b.gm_lng)        s += 1;
  // Has a GMaps phone we can cross-ref
  if (hasStr(b.gm_phone))          s += 1;

  // ── 5) Other presence signals  (max 10) ──
  if (hasRealFacebook(b.facebook))  s += 2;    // actively uses social
  if (hasStr(b.instagram))          s += 1;
  if (hasStr(b.workingHours))       s += 1;
  if (hasStr(b.identificationNumber)) s += 1;  // registered business

  return s;
}

// ── Tier assignment ──────────────────────────────────────────────────────────
function assignTier(b) {
  const emails = parseEmails(b.emails);
  const hasEmail = emails.length > 0;
  const hasPhone = hasStr(b.phones);
  const yellWebsite = hasStr(b.website);
  const gmWebsite  = hasStr(b.gm_website);
  const hasAnySite = yellWebsite || gmWebsite;
  const basicSite  = websiteLooksBasic(b.website) || websiteLooksBasic(b.gm_website);
  const noSite     = !hasAnySite || basicSite;
  const rating     = b.gm_rating || 0;

  // Tier 1 — HOT:  email + no website + decent quality
  if (hasEmail && noSite && rating >= 4.0)
    return { tier: 1, label: 'HOT — Email + No Website + Good Rating' };
  if (hasEmail && noSite)
    return { tier: 1, label: 'HOT — Email + No Website' };

  // Tier 2 — WARM:  email + has website (upgrade / redesign pitch)
  if (hasEmail && rating >= 4.0)
    return { tier: 2, label: 'WARM — Email + Website (redesign pitch) + Good Rating' };
  if (hasEmail)
    return { tier: 2, label: 'WARM — Email available' };

  // Tier 3 — CALL:  no email but phone + no website
  if (noSite && hasPhone && rating >= 4.0)
    return { tier: 3, label: 'CALL — No Website + Phone + Good Rating' };
  if (noSite && hasPhone)
    return { tier: 3, label: 'CALL — No Website + Phone only' };

  // Tier 4 — LATER:  phone + has website
  if (hasPhone && rating >= 4.0)
    return { tier: 4, label: 'LATER — Website + Phone (upgrade pitch)' };
  if (hasPhone)
    return { tier: 4, label: 'LATER — Phone only' };

  // Tier 5 — COLD:  no useful contact info
  return { tier: 5, label: 'COLD — No contact info' };
}

// ── Score & tier everyone ────────────────────────────────────────────────────
let results = data.map(b => {
  const s = score(b);
  const t = assignTier(b);
  return { ...b, _score: s, _tier: t.tier, _tierLabel: t.label };
});

results.sort((a, b) => a._tier - b._tier || b._score - a._score);

if (minScore > 0) {
  results = results.filter(r => r._score >= minScore);
  console.log(`After min-score filter (>= ${minScore}): ${results.length} companies`);
}

// ── Print Report ─────────────────────────────────────────────────────────────
const tierNames = {
  1: '🔥 TIER 1 — HOT  (Email + No Website)',
  2: '⚡ TIER 2 — WARM (Email + Has Website)',
  3: '📞 TIER 3 — CALL (No Website + Phone)',
  4: '📋 TIER 4 — LATER (Website + Phone)',
  5: '❄️  TIER 5 — COLD (No Contact)',
};

console.log('\n' + '═'.repeat(80));
console.log('  OUTREACH PRIORITY REPORT');
console.log('═'.repeat(80));

for (const t of [1, 2, 3, 4, 5]) {
  const group = results.filter(r => r._tier === t);
  if (!group.length) continue;
  console.log(`\n${tierNames[t]} — ${group.length} companies`);
  console.log('─'.repeat(80));
  group.slice(0, 10).forEach((b, i) => {
    const email = parseEmails(b.emails).join(', ') || '—';
    const site = hasStr(b.website) || hasStr(b.gm_website) ? '✓' : '✗';
    const gmTag = b.gm_matched ? `${b.gm_rating || '?'}★(${b.gm_reviewsCount || 0})` : 'no GM';
    const src = b._source === 'yellge+gmaps' ? 'Y+G' : b._source === 'yellge' ? 'Y' : b._source === 'gmaps_only' ? 'G' : '?';
    console.log(
      `  ${String(i + 1).padStart(3)}. ${(b.name || '').slice(0, 35).padEnd(35)} ` +
      `Web:${site}  ${gmTag.padEnd(12)} Score:${b._score}  [${src}] [${b.sourceCategory}]`
    );
    if (parseEmails(b.emails).length) console.log(`       📧 ${email}`);
  });
  if (group.length > 10) console.log(`  ... and ${group.length - 10} more`);
}

// ── Totals ───────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(80));
console.log('  SUMMARY');
console.log('═'.repeat(80));
let totalShown = 0;
for (const t of [1, 2, 3, 4, 5]) {
  const count = results.filter(r => r._tier === t).length;
  if (count) {
    console.log(`  ${tierNames[t]}: ${count}`);
    totalShown += count;
  }
}
console.log('─'.repeat(80));
console.log(`  Total: ${totalShown}   |   GMaps matched: ${results.filter(r => r.gm_matched).length}   |   With email: ${results.filter(r => parseEmails(r.emails).length).length}`);
const srcYG = results.filter(r => r._source === 'yellge+gmaps').length;
const srcY = results.filter(r => r._source === 'yellge').length;
const srcG = results.filter(r => r._source === 'gmaps_only').length;
if (srcYG + srcG > 0) {
  console.log(`  Sources: yellge+gmaps: ${srcYG}  |  yellge-only: ${srcY}  |  gmaps-only: ${srcG}`);
}
console.log('═'.repeat(80));

// ── Category breakdown ───────────────────────────────────────────────────────
if (!filterCategory) {
  console.log('\n  TOP 20 CATEGORIES BY TIER-1 COUNT:');
  console.log('─'.repeat(80));
  const catMap = {};
  for (const r of results) {
    const cat = r.sourceCategory || 'UNKNOWN';
    if (!catMap[cat]) catMap[cat] = { t1: 0, t2: 0, total: 0 };
    catMap[cat].total++;
    if (r._tier === 1) catMap[cat].t1++;
    if (r._tier === 2) catMap[cat].t2++;
  }
  const cats = Object.entries(catMap)
    .sort((a, b) => b[1].t1 - a[1].t1 || b[1].t2 - a[1].t2)
    .slice(0, 20);
  for (const [cat, c] of cats) {
    console.log(`  ${cat.slice(0, 45).padEnd(45)} T1:${String(c.t1).padStart(4)}  T2:${String(c.t2).padStart(4)}  Total:${String(c.total).padStart(5)}`);
  }
}

// ── Save outputs ─────────────────────────────────────────────────────────────
const outDir = path.dirname(inputFile);
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix = filterCategory ? `_${filterCategory.replace(/\s+/g, '_').slice(0, 30)}` : '';

// 1) Full prioritized JSON
const jsonOut = path.join(outDir, `prioritized${suffix}_${ts}.json`);
// strip internal fields from output
const clean = results.map(({ _score, _tier, _tierLabel, ...rest }) => ({
  _tier,
  _tierLabel,
  _score,
  ...rest,
}));
fs.writeFileSync(jsonOut, JSON.stringify(clean, null, 2), 'utf-8');
console.log(`\n✓ JSON: ${jsonOut}`);

// 2) CSV — sorted by tier, score
const escCSV = (val) => {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvHeaders = [
  'tier', 'tierLabel', 'score', 'name', 'sourceCategory',
  'email', 'phones', 'website', 'gm_website',
  'gm_rating', 'gm_reviewsCount', 'gm_matched',
  'address', 'facebook', 'instagram', 'whatsapp',
  'identificationNumber', 'yellUrl', 'gm_url',
];

const csvRows = results.map(b => csvHeaders.map(h => {
  if (h === 'tier') return b._tier;
  if (h === 'tierLabel') return escCSV(b._tierLabel);
  if (h === 'score') return b._score;
  if (h === 'email') return escCSV(parseEmails(b.emails).join('; '));
  return escCSV(b[h]);
}).join(','));

const csvOut = path.join(outDir, `prioritized${suffix}_${ts}.csv`);
fs.writeFileSync(csvOut, [csvHeaders.join(','), ...csvRows].join('\n'), 'utf-8');
console.log(`✓ CSV:  ${csvOut}`);

// 3) Tier 1 email outreach list
const tier1 = results
  .filter(r => r._tier === 1)
  .map(r => ({
    name: r.name,
    email: parseEmails(r.emails).join('; '),
    phones: r.phones || '',
    website: r.website || r.gm_website || '',
    gm_rating: r.gm_rating || '',
    gm_reviewsCount: r.gm_reviewsCount || '',
    sourceCategory: r.sourceCategory,
    address: r.address,
    yellUrl: r.yellUrl,
    gm_url: r.gm_url || '',
    score: r._score,
  }));

const t1Out = path.join(outDir, `tier1_outreach${suffix}_${ts}.json`);
fs.writeFileSync(t1Out, JSON.stringify(tier1, null, 2), 'utf-8');
console.log(`✓ Tier 1 outreach: ${t1Out} (${tier1.length} contacts)`);

// 4) Tier 1 CSV
const t1Headers = Object.keys(tier1[0] || {});
const t1Rows = tier1.map(r => t1Headers.map(h => escCSV(r[h])).join(','));
const t1CsvOut = path.join(outDir, `tier1_outreach${suffix}_${ts}.csv`);
fs.writeFileSync(t1CsvOut, [t1Headers.join(','), ...t1Rows].join('\n'), 'utf-8');
console.log(`✓ Tier 1 CSV: ${t1CsvOut} (${tier1.length} contacts)`);
