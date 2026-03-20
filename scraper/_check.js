const d = require('./output/prioritized_1774042504306.json');

// Check what websites look like for email contacts
const withEmail = d.filter(b => b.emails && b.emails.length > 0);
console.log('Total with email:', withEmail.length);
console.log('\nWebsite values for email contacts:');
const webTypes = {};
withEmail.forEach(b => {
  const w = b.website || 'NONE';
  const isFb = w.includes('facebook.com');
  const isInsta = w.includes('instagram.com');
  const isSocial = isFb || isInsta;
  const key = w === 'NONE' ? 'NO WEBSITE' : isSocial ? 'SOCIAL ONLY (' + (isFb ? 'FB' : 'IG') + ')' : 'HAS REAL WEBSITE';
  webTypes[key] = (webTypes[key] || 0) + 1;
});
console.log(webTypes);

// Show those with social-only or no website
const hot = withEmail.filter(b => {
  if (!b.website || b.website === '') return true;
  if (b.website.includes('facebook.com') || b.website.includes('instagram.com')) return true;
  return false;
});
console.log('\nEmail + No Real Website (FB/IG/None):', hot.length);
hot.forEach((b, i) => {
  console.log((i+1) + '. ' + b.name);
  console.log('   Email: ' + b.emails.join(', '));
  console.log('   Phone: ' + (b.phone || 'N/A') + '  Rating: ' + b.rating + ' (' + b.reviewsCount + ' reviews)');
  console.log('   Website: ' + (b.website || 'NONE'));
});
