#!/usr/bin/env node
/**
 * Prioritize scraped dental clinics for outreach.
 *
 * Produces 5 tiers + sorted CSV/JSON ready for cold outreach.
 *
 * Usage:
 *   node prioritize.js output/სტომატოლოგიური*.json
 */

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
if (!inputFile) { console.error('Usage: node prioritize.js <input.json>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
console.log(`Loaded ${data.length} businesses\n`);

// ── Scoring ──────────────────────────────────────────────────────────────────
// Higher score = approach first
function score(b) {
  let s = 0;

  // ── Contact-ability (most important — can we actually reach them?) ──
  const hasEmail = b.emails && b.emails.length > 0;
  const hasPhone = !!b.phone;
  if (hasEmail)                s += 40;  // email = easiest outreach
  if (hasPhone)                s += 10;  // phone as backup

  // ── Need for our service (do they need a website?) ──
  const noWebsite = !b.website || b.analysis?.needsNewWebsite;
  const fbOnly = b.analysis?.websiteIsFacebookOnly;
  if (noWebsite)               s += 30;  // no website = clear need
  else if (fbOnly)             s += 25;  // Facebook-only = nearly as good
  else if (!b.analysis?.hasHttps) s += 5; // has site but no HTTPS = upgrade opportunity

  // ── Business quality (are they worth approaching?) ──
  const rating = b.rating || 0;
  const reviews = b.reviewsCount || 0;
  if (rating >= 4.5)           s += 15;
  else if (rating >= 4.0)      s += 10;
  else if (rating >= 3.5)      s += 5;

  if (reviews >= 50)           s += 10;
  else if (reviews >= 20)      s += 7;
  else if (reviews >= 10)      s += 4;

  // ── Bonus signals ──
  if (b.workingHours?.length)  s += 2;   // active business
  if (b.imageUrls?.length > 3) s += 2;   // invests in presence

  return s;
}

// Score everyone
const scored = data.map(b => ({ ...b, _score: score(b) }));
scored.sort((a, b) => b._score - a._score);

// ── Tier assignment ──────────────────────────────────────────────────────────
function tier(b) {
  const hasEmail = b.emails && b.emails.length > 0;
  const hasPhone = !!b.phone;
  const noWebsite = !b.website || b.analysis?.needsNewWebsite;
  const fbOnly = b.analysis?.websiteIsFacebookOnly;
  const rating = b.rating || 0;

  if (hasEmail && noWebsite && rating >= 4.0)
    return { tier: 1, label: '🔥 HOT — Email + No Website + Good Rating' };
  if (hasEmail && noWebsite)
    return { tier: 1, label: '🔥 HOT — Email + No Website' };
  if (hasEmail && rating >= 4.0)
    return { tier: 2, label: '⚡ WARM — Email + Has Website (upgrade pitch)' };
  if (hasEmail)
    return { tier: 2, label: '⚡ WARM — Email available' };
  if (noWebsite && hasPhone && rating >= 4.0)
    return { tier: 3, label: '📞 CALL — No Website + Phone + Good Rating' };
  if (noWebsite && hasPhone)
    return { tier: 3, label: '📞 CALL — No Website + Phone' };
  if (hasPhone && rating >= 4.0)
    return { tier: 4, label: '📋 LATER — Has Website + Phone (upgrade pitch)' };
  if (hasPhone)
    return { tier: 4, label: '📋 LATER — Phone only' };
  return { tier: 5, label: '❄️ COLD — No contact info' };
}

const tiered = scored.map(b => {
  const t = tier(b);
  return { ...b, _tier: t.tier, _tierLabel: t.label };
});

// ── Print Summary ────────────────────────────────────────────────────────────
const tiers = [1, 2, 3, 4, 5];
const tierNames = {
  1: '🔥 TIER 1 — HOT (Email + No Website)',
  2: '⚡ TIER 2 — WARM (Email + Has Website)',
  3: '📞 TIER 3 — CALL (No Website + Phone)',
  4: '📋 TIER 4 — LATER (Has Website + Phone)',
  5: '❄️ TIER 5 — COLD (No Contact)',
};

console.log('═'.repeat(70));
console.log('  OUTREACH PRIORITY REPORT');
console.log('═'.repeat(70));

for (const t of tiers) {
  const group = tiered.filter(b => b._tier === t);
  if (!group.length) continue;
  console.log(`\n${tierNames[t]} — ${group.length} businesses`);
  console.log('─'.repeat(70));
  group.slice(0, 15).forEach((b, i) => {
    const email = (b.emails || []).join(', ') || '—';
    const phone = b.phone || '—';
    const site = b.website ? '✓' : '✗';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${(b.name || '').slice(0, 45).padEnd(45)} ` +
      `${b.rating || 0}★ (${b.reviewsCount || 0}) ` +
      `Web:${site} ` +
      `Score:${b._score}`
    );
    if (b.emails?.length) console.log(`      📧 ${email}`);
    if (b.phone)          console.log(`      📞 ${phone}`);
  });
  if (group.length > 15) console.log(`  ... and ${group.length - 15} more`);
}

console.log('\n' + '═'.repeat(70));
console.log('  TOTALS');
console.log('═'.repeat(70));
for (const t of tiers) {
  const count = tiered.filter(b => b._tier === t).length;
  if (count) console.log(`  ${tierNames[t]}: ${count}`);
}
console.log('═'.repeat(70));

// ── Save prioritized outputs ─────────────────────────────────────────────────
const outDir = path.dirname(inputFile);
const ts = Date.now();

// Full prioritized JSON
const jsonOut = path.join(outDir, `prioritized_${ts}.json`);
fs.writeFileSync(jsonOut, JSON.stringify(tiered, null, 2), 'utf-8');
console.log(`\nJSON saved: ${jsonOut}`);

// CSV — sorted by tier then score
const headers = [
  'tier', 'score', 'name', 'rating', 'reviewsCount', 'phone', 'email',
  'website', 'address', 'category', 'needsWebsite', 'googleMapsUrl',
];

const escCSV = (val) => {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvRows = tiered.map(b => headers.map(h => {
  if (h === 'tier') return b._tier;
  if (h === 'score') return b._score;
  if (h === 'email') return escCSV((b.emails || []).join('; '));
  if (h === 'needsWebsite') return b.analysis?.needsNewWebsite ? 'YES' : 'no';
  return escCSV(b[h]);
}).join(','));

const csvOut = path.join(outDir, `prioritized_${ts}.csv`);
fs.writeFileSync(csvOut, [headers.join(','), ...csvRows].join('\n'), 'utf-8');
console.log(`CSV saved: ${csvOut}`);

// Tier 1+2 only (email outreach list)
const emailList = tiered
  .filter(b => b._tier <= 2 && b.emails?.length)
  .map(b => ({
    name: b.name,
    email: b.emails.join('; '),
    phone: b.phone || '',
    rating: b.rating,
    reviews: b.reviewsCount,
    website: b.website || '',
    needsWebsite: b.analysis?.needsNewWebsite,
    address: b.address,
    googleMapsUrl: b.googleMapsUrl,
    tier: b._tier,
    score: b._score,
  }));

const emailOut = path.join(outDir, `email_outreach_list_${ts}.json`);
fs.writeFileSync(emailOut, JSON.stringify(emailList, null, 2), 'utf-8');
console.log(`Email outreach list: ${emailOut} (${emailList.length} contacts)`);
