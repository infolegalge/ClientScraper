/**
 * Test direct POST to enreg.reestri.gov.ge — check if we can get data via plain HTTP
 */
const https = require('https');
const http = require('http');

const TEST_ID = '400003278';

function post(url, formData) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formData).toString();
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ka,en;q=0.5',
        'Referer': 'https://enreg.reestri.gov.ge/main.php?m=new_index&l=en',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,*/*',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function run() {
  // Test 1: POST search form
  console.log('=== TEST 1: POST search by ID code ===');
  const r1 = await post('https://enreg.reestri.gov.ge/main.php', {
    m: 'new_index',
    l: 'en',
    s: 'search_legal_persons',
    s_legal_person_idnumber: TEST_ID,
    s_legal_person_name: '',
    s_legal_person_email: '',
    s_legal_person_le_form: '',
  });
  console.log(`Status: ${r1.status}`);
  // Extract meaningful content
  const hasId = r1.body.includes(TEST_ID);
  const hasBautech = r1.body.includes('Bau-Tech') || r1.body.includes('bautech');
  console.log(`Has ID in response: ${hasId}`);
  console.log(`Has Bau-Tech: ${hasBautech}`);
  
  // Extract table rows
  const trMatches = r1.body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  console.log(`Table rows found: ${trMatches.length}`);
  const relevantRows = trMatches.filter(tr => tr.includes(TEST_ID));
  relevantRows.forEach(tr => {
    // Strip HTML tags
    const text = tr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  Row: ${text.slice(0, 300)}`);
  });

  // Find link to detail page
  const detailLinks = r1.body.match(/href="[^"]*subject[^"]*"/gi) || [];
  const viewLinks = r1.body.match(/href="[^"]*view[^"]*"/gi) || [];
  const allLinks = r1.body.match(/href="main\.php\?[^"]+"/gi) || [];
  console.log(`\nSubject links: ${detailLinks.length}`);
  detailLinks.forEach(l => console.log(`  ${l}`));
  console.log(`View links: ${viewLinks.length}`);
  viewLinks.forEach(l => console.log(`  ${l}`));
  console.log(`All main.php links: ${allLinks.length}`);
  allLinks.forEach(l => console.log(`  ${l}`));

  // Test 2: Try direct GET with various URL patterns
  console.log('\n=== TEST 2: Try GET patterns ===');
  const urls = [
    `https://enreg.reestri.gov.ge/main.php?c=app&m=find_subject&id_code=${TEST_ID}&l=en`,
    `https://enreg.reestri.gov.ge/main.php?m=search_result&id_code=${TEST_ID}&l=en`,
    `https://enreg.reestri.gov.ge/main.php?c=search&m=find_subject&s_legal_person_idnumber=${TEST_ID}&l=en`,
  ];
  for (const url of urls) {
    try {
      const r = await get(url);
      const hasData = r.body.includes(TEST_ID) || r.body.includes('Bau-Tech');
      console.log(`  ${r.status} ${url.slice(40)} — hasData: ${hasData}, bodyLen: ${r.body.length}`);
      if (hasData) {
        const text = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`    Content: ${text.slice(0, 500)}`);
      }
    } catch (e) {
      console.log(`  ERROR ${url.slice(40)}: ${e.message}`);
    }
  }

  // Test 3: Check for any JSON/XML API
  console.log('\n=== TEST 3: Try API endpoints ===');
  const apiUrls = [
    `https://enreg.reestri.gov.ge/api/search?id_code=${TEST_ID}`,
    `https://enreg.reestri.gov.ge/api/v1/subjects/${TEST_ID}`,
    `https://enreg.reestri.gov.ge/main.php?c=api&m=search&id_code=${TEST_ID}`,
  ];
  for (const url of apiUrls) {
    try {
      const r = await get(url);
      console.log(`  ${r.status} ${url.slice(40)} — bodyLen: ${r.body.length}`);
      if (r.body.length < 1000) console.log(`    Body: ${r.body}`);
    } catch (e) {
      console.log(`  ERROR ${url.slice(40)}: ${e.message}`);
    }
  }
}

run().catch(e => console.error('Fatal:', e));
