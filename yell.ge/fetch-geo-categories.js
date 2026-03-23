/**
 * Fetch Georgian category names from yell.ge for all category IDs.
 * Saves mapping to output/category_geo_map.json
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'output');
const MAP_FILE = path.join(OUT_DIR, 'category_geo_map.json');

function fetch(url) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let d = '';
      r.setEncoding('utf-8');
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Load existing data to get unique category IDs
  const files = fs.readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('yellge_enriched_') && f.endsWith('.json'));
  files.sort();
  const inputPath = path.join(OUT_DIR, files[files.length - 1]);
  console.log('Loading:', inputPath);
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  // Build EN map: categoryId -> EN name
  const enMap = {};
  data.forEach((c) => {
    if (c.sourceCategoryId && c.sourceCategory) {
      enMap[c.sourceCategoryId] = c.sourceCategory;
    }
  });
  const ids = Object.keys(enMap).sort((a, b) => Number(a) - Number(b));
  console.log(`Found ${ids.length} category IDs to translate\n`);

  // Resume support
  let geoMap = {};
  if (fs.existsSync(MAP_FILE)) {
    geoMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
    console.log(`Resuming: ${Object.keys(geoMap).length} already fetched`);
  }

  let fetched = 0;
  let errors = 0;

  for (const id of ids) {
    if (geoMap[id]) continue; // already done

    const url = `https://www.yell.ge/companies.php?lan=geo&rub=${id}`;
    try {
      const html = await fetch(url);

      // Use <title> tag — it's cleanest (no city suffix, no HTML spans)
      let geoName = '';
      const title = html.match(/<title>([\s\S]*?)<\/title>/);
      if (title) {
        geoName = title[1].replace(/<[^>]+>/g, '').trim();
      }
      // Fallback: <h1> tag (strip HTML tags + trailing ",\nთბილისი")
      if (!geoName) {
        const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
        if (h1) {
          geoName = h1[1].replace(/<[^>]+>/g, '').replace(/,\s*თბილისი/g, '').trim();
        }
      }

      if (geoName) {
        geoMap[id] = { en: enMap[id], ge: geoName };
        fetched++;
        if (fetched % 50 === 0 || fetched <= 5) {
          console.log(`  [${fetched}/${ids.length}] ${id}: ${enMap[id]} → ${geoName}`);
        }
      } else {
        geoMap[id] = { en: enMap[id], ge: enMap[id] }; // fallback to EN
        console.log(`  ⚠ ${id}: No Georgian name found, using EN: ${enMap[id]}`);
      }
    } catch (err) {
      errors++;
      console.log(`  ✗ ${id}: ${err.message}`);
      geoMap[id] = { en: enMap[id], ge: enMap[id] }; // fallback
    }

    // Save every 25
    if (fetched % 25 === 0) {
      fs.writeFileSync(MAP_FILE, JSON.stringify(geoMap, null, 2), 'utf-8');
    }

    await sleep(200); // polite delay
  }

  // Final save
  fs.writeFileSync(MAP_FILE, JSON.stringify(geoMap, null, 2), 'utf-8');

  console.log(`\nDone! ${Object.keys(geoMap).length} categories mapped`);
  console.log(`Fetched: ${fetched}, Errors: ${errors}`);
  console.log(`Saved to: ${MAP_FILE}`);

  // Print some samples
  console.log('\nSamples:');
  Object.entries(geoMap).slice(0, 15).forEach(([id, v]) => {
    console.log(`  ${id}: ${v.en} → ${v.ge}`);
  });
}

main().catch(console.error);
