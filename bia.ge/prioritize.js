#!/usr/bin/env node
/**
 * Prioritize bia.ge scraped companies for web-dev outreach.
 * Adapts the yell.ge scoring model for bia.ge data schema.
 *
 * Usage:
 *   node prioritize.js output/biage_all_*.json
 *   node prioritize.js output/biage_all_*.json --category "მედიცინა"
 *   node prioritize.js output/biage_all_*.json --min-score 40
 */

const fs = require('fs');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputFile = args.find((a) => !a.startsWith('--'));
if (!inputFile) {
  console.error('Usage: node prioritize.js <biage_all.json> [--category "..."] [--min-score N]');
  process.exit(1);
}

const catFlag = args.indexOf('--category');
const filterCategory = catFlag !== -1 ? args[catFlag + 1] : null;

const scoreFlag = args.indexOf('--min-score');
const minScore = scoreFlag !== -1 ? parseInt(args[scoreFlag + 1], 10) : 0;

let data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
console.log(`Loaded ${data.length} companies`);

if (filterCategory) {
  const cat = filterCategory.toLowerCase();
  data = data.filter(
    (d) =>
      (d.sourceCategory || '').toLowerCase().includes(cat) ||
      (d.sourceSubcategory || '').toLowerCase().includes(cat) ||
      (d.categories || '').toLowerCase().includes(cat)
  );
  console.log(`Filtered to "${filterCategory}": ${data.length} companies`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const hasStr = (v) => v && typeof v === 'string' && v.trim().length > 0;

function parseEmails(raw) {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[;,]/)
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
}

function hasRealFacebook(fb) {
  if (!fb || !fb.trim()) return false;
  return !fb.includes('share.php') && !fb.includes('plugins') && !fb.includes('sharer');
}

function websiteLooksBasic(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.includes('facebook.com') ||
    u.includes('instagram.com') ||
    u.includes('blogspot.com') ||
    u.includes('wix.com') ||
    u.includes('weebly.com') ||
    u.includes('sites.google.com')
  );
}

// ── Scoring ──────────────────────────────────────────────────────────────────
// Higher = approach first. Max theoretical ≈ 100
function score(b) {
  let s = 0;
  const emails = parseEmails(b.emails);
  const hasEmail = emails.length > 0;
  const hasPhone = hasStr(b.phones);
  const hasSite = hasStr(b.website);
  const basicSite = websiteLooksBasic(b.website);

  // ── 1) Contactability (max 40)
  if (hasEmail) s += 30;
  if (hasPhone) s += 8;

  // ── 2) Need for a website (max 30)
  if (!hasSite) s += 30;
  else if (basicSite) s += 22;
  // else has proper website → 0

  // ── 3) Business substance (max 15)
  if (hasStr(b.identificationNumber)) s += 5; // registered business
  if (hasStr(b.yearFounded)) s += 3;
  if (hasStr(b.employees)) s += 2;
  if (hasStr(b.companySize)) s += 2;
  if (hasStr(b.brands)) s += 3;

  // ── 4) Data richness / presence signals (max 15)
  if (hasRealFacebook(b.facebook)) s += 3;
  if (hasStr(b.instagram)) s += 2;
  if (hasStr(b.linkedin)) s += 2;
  if (hasStr(b.address)) s += 2;
  if (b.lat && b.lng) s += 1;
  if (hasStr(b.workingHours)) s += 2;
  if (hasStr(b.description)) s += 1;
  if (hasStr(b.logoUrl)) s += 2;

  return s;
}

// ── Tier assignment ──────────────────────────────────────────────────────────
function assignTier(b) {
  const emails = parseEmails(b.emails);
  const hasEmail = emails.length > 0;
  const hasPhone = hasStr(b.phones);
  const hasSite = hasStr(b.website);
  const basicSite = websiteLooksBasic(b.website);
  const noSite = !hasSite || basicSite;

  // Tier 1 — HOT: email + no website
  if (hasEmail && noSite) return { tier: 1, label: 'HOT — Email + No Website' };

  // Tier 2 — WARM: email + has website (upgrade/redesign pitch)
  if (hasEmail) return { tier: 2, label: 'WARM — Email + Website (redesign pitch)' };

  // Tier 3 — CALL: no email but phone + no website
  if (noSite && hasPhone) return { tier: 3, label: 'CALL — No Website + Phone only' };

  // Tier 4 — LATER: phone + has website
  if (hasPhone) return { tier: 4, label: 'LATER — Website + Phone (upgrade pitch)' };

  // Tier 5 — COLD: no useful contact info
  return { tier: 5, label: 'COLD — No contact info' };
}

// ── Score & tier everyone ────────────────────────────────────────────────────
let results = data.map((b) => {
  const s = score(b);
  const t = assignTier(b);
  return { ...b, _score: s, _tier: t.tier, _tierLabel: t.label };
});

results.sort((a, b) => a._tier - b._tier || b._score - a._score);

if (minScore > 0) {
  results = results.filter((r) => r._score >= minScore);
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
console.log('  bia.ge OUTREACH PRIORITY REPORT');
console.log('═'.repeat(80));

for (const t of [1, 2, 3, 4, 5]) {
  const group = results.filter((r) => r._tier === t);
  if (!group.length) continue;
  console.log(`\n${tierNames[t]} — ${group.length} companies`);
  console.log('─'.repeat(80));
  group.slice(0, 10).forEach((b, i) => {
    const email = parseEmails(b.emails).join(', ') || '—';
    const site = hasStr(b.website) ? '✓' : '✗';
    const cat = (b.sourceSubcategory || b.sourceCategory || '').slice(0, 25);
    console.log(
      `  ${String(i + 1).padStart(3)}. ${(b.name || '').slice(0, 35).padEnd(35)} ` +
        `Web:${site}  Score:${String(b._score).padStart(3)}  [${cat}]`
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
  const count = results.filter((r) => r._tier === t).length;
  if (count) {
    console.log(`  ${tierNames[t]}: ${count}`);
    totalShown += count;
  }
}
console.log('─'.repeat(80));
console.log(
  `  Total: ${totalShown}   |   With email: ${results.filter((r) => parseEmails(r.emails).length).length}   |   With website: ${results.filter((r) => hasStr(r.website)).length}`
);
console.log('═'.repeat(80));

// ── Category breakdown ───────────────────────────────────────────────────────
if (!filterCategory) {
  console.log('\n  TOP 20 SUBCATEGORIES BY TIER-1 COUNT:');
  console.log('─'.repeat(80));
  const catMap = {};
  for (const r of results) {
    const cat = r.sourceSubcategory || r.sourceCategory || 'UNKNOWN';
    if (!catMap[cat]) catMap[cat] = { t1: 0, t2: 0, total: 0 };
    catMap[cat].total++;
    if (r._tier === 1) catMap[cat].t1++;
    if (r._tier === 2) catMap[cat].t2++;
  }
  const cats = Object.entries(catMap)
    .sort((a, b) => b[1].t1 - a[1].t1 || b[1].t2 - a[1].t2)
    .slice(0, 20);
  for (const [cat, c] of cats) {
    console.log(
      `  ${cat.slice(0, 45).padEnd(45)} T1:${String(c.t1).padStart(4)}  T2:${String(c.t2).padStart(4)}  Total:${String(c.total).padStart(5)}`
    );
  }
}

// ── Save outputs ─────────────────────────────────────────────────────────────
const outDir = path.dirname(inputFile);
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix = filterCategory
  ? `_${filterCategory.replace(/\s+/g, '_').slice(0, 30)}`
  : '';

// 1) Full prioritized JSON
const jsonOut = path.join(outDir, `prioritized${suffix}_${ts}.json`);
const clean = results.map(({ _score, _tier, _tierLabel, ...rest }) => ({
  _tier,
  _tierLabel,
  _score,
  ...rest,
}));
fs.writeFileSync(jsonOut, JSON.stringify(clean, null, 2), 'utf-8');
console.log(`\n✓ JSON: ${jsonOut}`);

// 2) CSV
const escCSV = (val) => {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

const csvHeaders = [
  'tier', 'tierLabel', 'score', 'name', 'brands', 'sourceCategory', 'sourceSubcategory',
  'email', 'phones', 'website', 'address', 'city',
  'facebook', 'instagram', 'linkedin',
  'identificationNumber', 'yearFounded', 'employees', 'companySize',
  'biaUrl',
];

const csvRows = results.map((b) =>
  csvHeaders
    .map((h) => {
      if (h === 'tier') return b._tier;
      if (h === 'tierLabel') return escCSV(b._tierLabel);
      if (h === 'score') return b._score;
      if (h === 'email') return escCSV(parseEmails(b.emails).join('; '));
      return escCSV(b[h]);
    })
    .join(',')
);

const csvOut = path.join(outDir, `prioritized${suffix}_${ts}.csv`);
fs.writeFileSync(csvOut, '\uFEFF' + [csvHeaders.join(','), ...csvRows].join('\n'), 'utf-8');
console.log(`✓ CSV:  ${csvOut}`);

// 3) Tier 1 email outreach list
const tier1 = results
  .filter((r) => r._tier === 1)
  .map((r) => ({
    name: r.name,
    email: parseEmails(r.emails).join('; '),
    phones: r.phones || '',
    website: r.website || '',
    sourceCategory: r.sourceCategory,
    sourceSubcategory: r.sourceSubcategory,
    address: r.address,
    city: r.city,
    biaUrl: r.biaUrl,
    score: r._score,
  }));

const t1Out = path.join(outDir, `tier1_outreach${suffix}_${ts}.json`);
fs.writeFileSync(t1Out, JSON.stringify(tier1, null, 2), 'utf-8');
console.log(`✓ Tier 1 outreach: ${t1Out} (${tier1.length} contacts)`);

// 4) Tier 1 CSV
if (tier1.length > 0) {
  const t1Headers = Object.keys(tier1[0]);
  const t1Rows = tier1.map((r) => t1Headers.map((h) => escCSV(r[h])).join(','));
  const t1CsvOut = path.join(outDir, `tier1_outreach${suffix}_${ts}.csv`);
  fs.writeFileSync(t1CsvOut, '\uFEFF' + [t1Headers.join(','), ...t1Rows].join('\n'), 'utf-8');
  console.log(`✓ Tier 1 CSV: ${t1CsvOut} (${tier1.length} contacts)`);
}
