/**
 * Scrape categories that were missed in the full run.
 * Finds missing category IDs by comparing categories.json with cat_*.json files,
 * then invokes scraper.js for each batch.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'output');
const cats = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'categories.json'), 'utf-8'));
const files = fs.readdirSync(OUT_DIR).filter(f => f.startsWith('cat_'));
const scrapedIds = new Set(files.map(f => {
  const m = f.match(/cat_(\d+)_/);
  return m ? m[1] : null;
}).filter(Boolean));

const missing = cats.filter(c => !scrapedIds.has(String(c.id)));
console.log(`Found ${missing.length} missing categories out of ${cats.length} total.`);

if (missing.length === 0) {
  console.log('All categories scraped!');
  process.exit(0);
}

// Process in batches of 10
const BATCH_SIZE = 10;
for (let i = 0; i < missing.length; i += BATCH_SIZE) {
  const batch = missing.slice(i, i + BATCH_SIZE);
  const ids = batch.map(c => c.id).join(',');
  console.log(`\n=== Batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(missing.length/BATCH_SIZE)}: ${ids} ===`);
  try {
    execSync(`node scraper.js --category ${ids} --delay 350 --concurrency 3`, {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 300000, // 5 min per batch
    });
  } catch (e) {
    console.error(`Batch failed: ${e.message}`);
  }
}

// Now merge all results
console.log('\n=== Merging all results ===');
const allFiles = fs.readdirSync(OUT_DIR).filter(f => f.startsWith('cat_') && f.endsWith('.json'));
const seen = new Set();
const allCompanies = [];
for (const f of allFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf-8'));
  for (const company of data) {
    if (!seen.has(company.yellId)) {
      seen.add(company.yellId);
      allCompanies.push(company);
    }
  }
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonPath = path.join(OUT_DIR, `yellge_COMPLETE_${ts}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(allCompanies, null, 2), 'utf-8');
console.log(`\nSaved ${allCompanies.length} unique companies to ${jsonPath}`);

// CSV
const headers = ['yellId','name','address','phones','emails','website','facebook','instagram','whatsapp','viber','youtube','rating','reviews','identificationNumber','legalName','categories','description','workingHours','lat','lng','sourceCategory','sourceCategoryId'];
const csvRows = [headers.join(',')];
for (const c of allCompanies) {
  const row = headers.map(h => {
    let val = c[h];
    if (Array.isArray(val)) val = val.join('; ');
    if (val == null) val = '';
    val = String(val).replace(/"/g, '""');
    return `"${val}"`;
  });
  csvRows.push(row.join(','));
}
const BOM = '\uFEFF';
const csvPath = path.join(OUT_DIR, `yellge_COMPLETE_${ts}.csv`);
fs.writeFileSync(csvPath, BOM + csvRows.join('\n'), 'utf-8');
console.log(`Saved CSV to ${csvPath}`);
console.log(`\nTotal unique companies: ${allCompanies.length}`);
