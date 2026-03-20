# Single-Page Dental Clinic HTML Generator — Master Prompt

> **Purpose**: Generate a unique, self-contained single HTML landing page for each dental clinic scraped from Google Maps in Tbilisi, Georgia. Every page must look **visually distinct** — different colors, different visual mode — while maintaining conversion-quality design.

---

## 1. PROJECT CONTEXT

You are creating **client demo pages** for a web agency selling website services to dental clinics. Each page is a **single `.html` file** — no external dependencies except Google Fonts and optionally GSAP CDN. The page must:

- Look like a production-grade, custom-designed dental clinic website
- Be **trilingual** (Georgian 🇬🇪, English 🇬🇧, Russian 🇷🇺) with a language switcher
- Be fully responsive (mobile-first)
- Contain real data from the clinic's Google Maps profile
- Serve as a "look what we built for you" cold-outreach demo

---

## 2. DATA CONTRACT

Each clinic object from the scraped JSON contains:

```
name              — Full clinic name (often bilingual: "Name | ქართული სახელი")
category          — "სტომატოლოგიური კლინიკა" (dental clinic)
address           — Street address in Tbilisi
phone             — Phone number (format: "032 XXX XX XX" or "5XX XX XX XX")
website           — Existing website URL (may be null)
rating            — Google rating (0-5, one decimal)
reviewsCount      — Number of Google reviews
emails[]          — Array of email addresses (may be empty)
workingHours[]    — Array of strings: "ორშაბათი10AM–8PM" etc.
imageUrls[]       — Google Maps photos (use w800 variants for quality)
reviews[]         — { author, rating, date, text, ownerResponse }
payments[]        — Payment methods accepted
googleMapsUrl     — Direct link to Google Maps listing
socialLinks[]     — Facebook, Instagram, etc.
coordinates       — { lat, lng }
_tier             — Priority tier (1-5)
_score            — Outreach priority score (0-100)
_tierLabel        — Human-readable tier description
```

### Data Handling Rules

- **Name**: If contains `|`, split — left side is Latin/English, right side is Georgian. Use appropriately per language.
- **Images**: Filter to URLs containing `w800` for high quality. Fallback: use gradient/pattern hero if no images.
- **Reviews**: Deduplicate by `author + text[:40]`. Only show 4★+ reviews. Max 6 displayed.
- **Working Hours**: Parse Georgian day names (ორშაბათი=Mon, სამშაბათი=Tue, ოთხშაბათი=Wed, ხუთშაბათი=Thu, პარასკევი=Fri, შაბათი=Sat, კვირა=Sun). Time follows directly after day name with no separator: `"ორშაბათი10AM–8PM"`.
- **Phone**: Prefix with `+995` for `tel:` links. Format: `032` = Tbilisi landline, `5XX` = mobile.
- **Rating**: Display as stars (filled/empty SVGs) plus numeric badge.
- **Missing data**: Gracefully hide sections that have no data. Never show empty grids or placeholder text.

---

## 3. VISUAL MODES (3 Archetypes)

Each clinic gets assigned ONE of three visual modes. These define the overall design language:

### Mode G — GLASS (Inspired by Concept A: Luxe Glass)

**Vibe**: Dark, premium, atmospheric. Glassmorphism everywhere.

- **Background**: Deep dark solid color (from palette)
- **Cards/Surfaces**: `backdrop-filter: blur(24px); background: rgba(255,255,255,.04-.07); border: 1px solid rgba(255,255,255,.08-.12)`
- **Navigation**: Floating pill nav with glass blur, sticks on scroll
- **Hero**: 2-column grid (text left, image right in glass frame)
- **Aurora blobs**: 2-3 large blurred orbs animating slowly (`filter: blur(120px); opacity: .06-.1`)
- **Cursor effect**: Radial gradient glow follows mouse (`mix-blend-mode: screen`)
- **Scroll progress bar**: Gradient bar fixed at top
- **Service cards**: Glass cards in 3-column grid with hover lift + glow border
- **Gallery**: Bento grid layout (some cards span 2 cols)
- **Reviews**: Horizontal scroll cards with glass effect
- **Noise texture overlay**: SVG feTurbulence on `body::before` at `.015-.02` opacity
- **Reveal animations**: CSS-only (`opacity:0; transform:translateY(40px)` → visible on scroll via IntersectionObserver)
- **Scroll reveal classes**: `.rv` (up), `.rv-l` (left), `.rv-r` (right), `.rv-s` (scale)

### Mode C — CINEMATIC (Inspired by Concept C: Cinematic)

**Vibe**: Dramatic, immersive, editorial. GSAP-powered motion.

- **Background**: Near-black with subtle radial gradients
- **Loading screen**: Animated clinic name reveal + progress bar (GSAP timeline)
- **Hero**: Full-viewport cinematic with word-by-word stagger reveal
- **Marquee**: Dual-row scrolling text with clinic name/category repeating
- **Service cards**: Cards with top-border scale animation on hover + 3D tilt (mousemove)
- **Gallery**: Horizontal scroll pinned section (GSAP ScrollTrigger)
- **Counter animation**: Numbers count up on scroll into view
- **Typography**: Large display serif for headlines, clean sans for body
- **Scroll animations**: GSAP ScrollTrigger for section reveals, stagger for card grids
- **External dependency**: `<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>` + ScrollTrigger plugin

### Mode K — KINETIC (Inspired by Concept C: Kinetic/Brutalist)

**Vibe**: Light, bold, typographic. Movement through contrasts.

- **Background**: Off-white / cream / light paper tones
- **Text**: Near-black, high contrast
- **Custom cursor**: Circle with `mix-blend-mode: difference`, grows on hover over interactive elements
- **Hero**: Full-screen with clip-path mask reveal animation
- **Hero text**: Massive display type with line-by-line clip reveal
- **Marquee**: Dual rows, one forward one reverse, with accent-colored clinic name
- **Service items**: Full-width accordion (not cards) with numbered rows, expand on click to reveal details
- **Gallery**: Stacked absolute cards with scroll-triggered transitions
- **FAQ**: Expand/collapse with rotating plus icon (CSS `::before`/`::after`)
- **Red dot motif**: Small accent-colored circles as decorative elements inline with text
- **Scroll animations**: CSS + vanilla JS (IntersectionObserver + custom event listeners)
- **Dark footer/CTA section**: Inverts to dark background for final call-to-action

---

## 4. COLOR PALETTES (24 Distinct Schemes)

Each palette defines: `bg`, `bg2`, `bg3`, `surface`, `text`, `text2`, `text3`, `accent`, `accent2`, `warm`, `border`

### Dark Palettes (for Mode G + Mode C)

```
P01  "Amethyst Night"
     bg:#0C0A14  bg2:#110F1C  bg3:#16132A
     text:#F4F2FF  text2:#9B95B0  text3:#6B6580
     accent:#A78BFA  accent2:#C4B5FD  warm:#F59E0B
     
P02  "Obsidian Teal"
     bg:#07100F  bg2:#0B1716  bg3:#0F1E1D
     text:#E8F5F3  text2:#7FABA5  text3:#4D7A75
     accent:#2DD4BF  accent2:#5EEAD4  warm:#F97316

P03  "Midnight Sapphire"
     bg:#060A18  bg2:#0A1028  bg3:#0E1638
     text:#E8ECFF  text2:#8B96C9  text3:#5B6799
     accent:#3B82F6  accent2:#60A5FA  warm:#FBBF24

P04  "Noir Emerald"
     bg:#060D08  bg2:#0A150C  bg3:#0F1E12
     text:#EDF5EF  text2:#7EAA85  text3:#507A57
     accent:#10B981  accent2:#34D399  warm:#FB923C

P05  "Carbon Rose"
     bg:#100A0C  bg2:#180F12  bg3:#201418
     text:#FFF0F3  text2:#B88B94  text3:#8A5F6A
     accent:#F43F5E  accent2:#FB7185  warm:#F59E0B

P06  "Deep Indigo"
     bg:#050508  bg2:#0A0A0F  bg3:#0F1015
     text:#EDEDEF  text2:#8A8F98  text3:#5A5E66
     accent:#6366F1  accent2:#818CF8  warm:#F97316

P07  "Volcanic"
     bg:#120808  bg2:#1A0C0C  bg3:#221010
     text:#FFF0ED  text2:#C08A82  text3:#8A5E56
     accent:#DC2626  accent2:#EF4444  warm:#FBBF24

P08  "Arctic Depth"
     bg:#080C10  bg2:#0C1218  bg3:#101820
     text:#ECF2F8  text2:#88A0B8  text3:#587590
     accent:#0EA5E9  accent2:#38BDF8  warm:#F59E0B

P09  "Forest Noir"
     bg:#080C08  bg2:#0C120C  bg3:#121A12
     text:#EFF5EF  text2:#88AB88  text3:#5E7A5E
     accent:#22C55E  accent2:#4ADE80  warm:#D97706

P10  "Plum Dark"
     bg:#100810  bg2:#180C18  bg3:#201020
     text:#F8F0F8  text2:#B088B0  text3:#805E80
     accent:#C026D3  accent2:#D946EF  warm:#F59E0B

P11  "Charcoal Cyan"
     bg:#0A0C0E  bg2:#0F1214  bg3:#14181C
     text:#EDF2F5  text2:#8AA0AC  text3:#5E7580
     accent:#06B6D4  accent2:#22D3EE  warm:#FB923C

P12  "Onyx Amber"
     bg:#0A0804  bg2:#100C06  bg3:#161008
     text:#FFF8ED  text2:#BFA882  text3:#8A7A5A
     accent:#F59E0B  accent2:#FBBF24  warm:#EF4444
```

### Light Palettes (for Mode K)

```
P13  "Polar Red"
     bg:#FEFEFE  bg2:#F4F4F2  bg3:#EAEAE6
     text:#0D0D0D  text2:#5A5A5A  text3:#9A9A9A
     accent:#FF3B30  accent2:#FF6259  warm:#0D0D0D

P14  "Alpine Blue"
     bg:#FAFBFE  bg2:#F0F2F8  bg3:#E4E8F2
     text:#101828  text2:#4A5568  text3:#8896AA
     accent:#2563EB  accent2:#3B82F6  warm:#101828

P15  "Linen Green"
     bg:#FDFCF8  bg2:#F5F3ED  bg3:#EBE8E0
     text:#1A1A12  text2:#5A5A48  text3:#9A9A88
     accent:#16A34A  accent2:#22C55E  warm:#1A1A12

P16  "Pearl Orange"
     bg:#FFFDF8  bg2:#FFF8EE  bg3:#FFF0DD
     text:#1C1106  text2:#6B4F2E  text3:#A08A6A
     accent:#EA580C  accent2:#F97316  warm:#1C1106

P17  "Frost Violet"
     bg:#FCFAFE  bg2:#F4F0FA  bg3:#EAE2F4
     text:#1A0E28  text2:#5A4878  text3:#9080A8
     accent:#7C3AED  accent2:#8B5CF6  warm:#1A0E28

P18  "Bone Coral"
     bg:#FDF9F6  bg2:#F8F0EA  bg3:#F0E6DC
     text:#181210  text2:#6A5448  text3:#A08878
     accent:#E11D48  accent2:#F43F5E  warm:#181210

P19  "Snow Teal"
     bg:#F8FDFC  bg2:#EEF8F6  bg3:#E0F0EC
     text:#0A1A18  text2:#3A5A54  text3:#7A9A94
     accent:#0D9488  accent2:#14B8A6  warm:#0A1A18

P20  "Cream Magenta"
     bg:#FEFAFB  bg2:#FAF0F4  bg3:#F4E4EA
     text:#1A0C14  text2:#6A4A58  text3:#A08090
     accent:#DB2777  accent2:#EC4899  warm:#1A0C14

P21  "Mist Navy"
     bg:#F8F9FC  bg2:#EEF0F6  bg3:#E2E6F0
     text:#0E1629  text2:#445068  text3:#8090A8
     accent:#1E40AF  accent2:#2563EB  warm:#0E1629

P22  "Paper Rust"
     bg:#FDFAF6  bg2:#F8F2EA  bg3:#F0E8DC
     text:#1C1208  text2:#6B502A  text3:#A08862
     accent:#B45309  accent2:#D97706  warm:#1C1208

P23  "Ivory Moss"
     bg:#FBFDF8  bg2:#F2F8EE  bg3:#E6F0E0
     text:#0E1A0C  text2:#3A5A34  text3:#7A9A74
     accent:#15803D  accent2:#16A34A  warm:#0E1A0C

P24  "Sand Indigo"
     bg:#FDFCF8  bg2:#F6F4EE  bg3:#EEECE4
     text:#121024  text2:#484460  text3:#8884A0
     accent:#4338CA  accent2:#4F46E5  warm:#121024
```

---

## 5. PALETTE + MODE ASSIGNMENT

Use a **deterministic hash** of the clinic name to assign palette and mode. This ensures the same clinic always gets the same design, and siblings look different.

```javascript
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function assignDesign(clinicName) {
  const h = djb2(clinicName);
  const modeIndex = h % 3;  // 0=G (Glass), 1=C (Cinematic), 2=K (Kinetic)
  const mode = ['G', 'C', 'K'][modeIndex];
  
  // Dark palettes (P01-P12) for Glass/Cinematic, Light palettes (P13-P24) for Kinetic
  let paletteIndex;
  if (mode === 'K') {
    paletteIndex = (h % 12) + 13;  // P13-P24
  } else {
    paletteIndex = (h % 12) + 1;   // P01-P12
  }
  
  return { mode, palette: paletteIndex };
}
```

---

## 6. FONT PAIRING SYSTEM

Each palette gets a unique font pairing. Never reuse the same combination as the default concepts. Rotate through these pairings based on palette index:

```
P01  Display: Fraunces           Body: DM Sans
P02  Display: Playfair Display   Body: Outfit
P03  Display: Cormorant Garamond Body: Work Sans
P04  Display: Lora               Body: Nunito Sans
P05  Display: Crimson Pro        Body: Manrope
P06  Display: Source Serif 4     Body: Sora
P07  Display: Bitter             Body: Rubik
P08  Display: Merriweather       Body: Open Sans
P09  Display: Libre Baskerville  Body: Figtree
P10  Display: DM Serif Display   Body: Karla
P11  Display: Spectral           Body: Plus Jakarta Sans
P12  Display: Literata           Body: Lexend
P13  Display: Syne               Body: Space Grotesk
P14  Display: Clash Display*     Body: General Sans*
P15  Display: Cabinet Grotesk*   Body: Satoshi*
P16  Display: Bricolage Grotesque Body: Geist*
P17  Display: Space Grotesk      Body: Inter Tight
P18  Display: Instrument Serif   Body: Be Vietnam Pro
P19  Display: Young Serif        Body: Outfit
P20  Display: Bodoni Moda        Body: Jost
P21  Display: Newsreader         Body: Figtree
P22  Display: Vollkorn           Body: Nunito
P23  Display: Bitter             Body: Lexend Deca
P24  Display: DM Serif Text      Body: DM Sans

* = If not on Google Fonts, substitute with next closest Google Font option.
  Clash Display → Syne | Cabinet Grotesk → Archivo Black
  General Sans → Work Sans | Satoshi → DM Sans  
  Geist → Inter Tight
```

**IMPORTANT**: Always include `Noto Sans Georgian` in the font stack for Georgian text rendering.

---

## 7. HTML SECTION STRUCTURE

Every page follows this section order. Hide sections gracefully when data is missing.

```
1.  NAVIGATION          — Sticky, with logo/name + language toggle (KA/EN/RU) + CTA button
2.  HERO                — Clinic name, tagline, rating badge, primary CTA, hero image
3.  MARQUEE (optional)  — Scrolling text strip (Modes C & K only)
4.  STATS COUNTER       — 3-4 key numbers: rating, years, patients, specialists
5.  SERVICES            — 6 dental services with icons and descriptions
6.  GALLERY             — Clinic photos from Google Maps imageUrls
7.  REVIEWS             — Customer testimonials (4★+ only, max 6)
8.  HOURS + CONTACT     — Working hours table + phone/address/map link
9.  FAQ                 — 4 common dental questions with expand/collapse
10. CTA SECTION         — Final call-to-action with phone + booking prompt
11. FOOTER              — Clinic name, address, social links, copyright
```

---

## 8. TRILINGUAL SYSTEM

All visible text must support three languages using inline spans:

```html
<span class="i ka">ქართული ტექსტი</span>
<span class="i en">English text</span>
<span class="i ru">Русский текст</span>
```

CSS language switching:
```css
.i { display: none }
.i.ka { display: inline }
body.en .i { display: none } body.en .i.en { display: inline }
body.ru .i { display: none } body.ru .i.ru { display: inline }
body.ka .i { display: none } body.ka .i.ka { display: inline }
```

JavaScript toggler:
```javascript
function L(lang) {
  document.body.className = lang;
  document.querySelectorAll('.lb').forEach(b => 
    b.classList.toggle('on', b.dataset.l === lang)
  );
}
```

### Language Button Design
Three small buttons in the nav: **KA** | **EN** | **RU** — active one is highlighted with accent color.

### Translation Guidelines

**Hero tagline** (trilingual):
```
ka: "თქვენი ღიმილი — ჩვენი ხელოვნება"  (Your Smile — Our Art)
en: "Your Smile — Our Craft"
ru: "Ваша улыбка — наше мастерство"
```

**Service names** (always these 6):
```
ka: თერაპია | ორთოდონტია | იმპლანტაცია | ესთეტიკა | ორთოპედია | ჰიგიენა
en: Therapy | Orthodontics | Implants | Cosmetics | Prosthetics | Hygiene
ru: Терапия | Ортодонтия | Имплантация | Эстетика | Ортопедия | Гигиена
Icons: 🦷 😁 🔩 ✨ 👑 🪥
```

**Service descriptions** (trilingual):
```
ka: კბილების მკურნალობა | კბილების სწორი განლაგება | თანამედროვე იმპლანტები | ვინირები და გათეთრება | გვირგვინები და ხიდები | პროფესიონალური გაწმენდა
en: Tooth treatment & restoration | Teeth alignment solutions | Modern implant systems | Veneers & whitening | Crowns & bridges | Professional cleaning
ru: Лечение и восстановление | Выравнивание зубов | Современные имплантаты | Виниры и отбеливание | Коронки и мосты | Проф. чистка
```

**Section headings** (trilingual):
```
Services:  მომსახურეობები | Our Services | Услуги
Gallery:   გალერეა | Gallery | Галерея
Reviews:   შეფასებები | Reviews | Отзывы
Hours:     სამუშაო საათები | Working Hours | Часы работы
Contact:   კონტაქტი | Contact | Контакт
FAQ:       ხშირი კითხვები | FAQ | Частые вопросы
```

**FAQ content** (always these 4):
```
Q1 ka: უფასოა პირველადი კონსულტაცია?
   en: Is the first consultation free?
   ru: Бесплатна ли первичная консультация?
A1 ka: დიახ, პირველადი კონსულტაცია და დიაგნოსტიკა სრულიად უფასოა.
   en: Yes, the initial consultation and diagnostics are completely free.
   ru: Да, первичная консультация и диагностика полностью бесплатны.

Q2 ka: რა გადახდის მეთოდებს იღებთ?
   en: What payment methods do you accept?
   ru: Какие способы оплаты принимаете?
A2 ka: ვიღებთ ნაღდ ანგარიშსწორებას, Visa/MasterCard ბარათებს, მობილურ NFC გადახდებს და განვადებას.
   en: We accept cash, Visa/MasterCard, mobile NFC payments, and installment plans.
   ru: Наличные, Visa/MasterCard, мобильные NFC-платежи и рассрочка.

Q3 ka: რამდენ ხანს სჭირდება იმპლანტაცია?
   en: How long does implantation take?
   ru: Сколько длится имплантация?
A3 ka: იმპლანტაციის სრული პროცესი 3-6 თვე გრძელდება. თავად პროცედურა 1-2 საათი მიმდინარეობს.
   en: The full implantation process takes 3-6 months. The procedure itself lasts 1-2 hours.
   ru: Полный процесс — 3-6 месяцев. Сама процедура — 1-2 часа.

Q4 ka: მუშაობთ შაბათ-კვირას?
   en: Do you work on weekends?
   ru: Работаете ли вы по выходным?
A4 ka: დიახ, ვმუშაობთ კვირაში 7 დღე, შაბათ-კვირის ჩათვლით.
   en: Yes, we are open 7 days a week, including weekends.
   ru: Да, мы работаем 7 дней в неделю, включая выходные.
```

**Stats counters** (use real data where available):
```
stat1: {rating}★  — ka: Google რეიტინგი | en: Google Rating | ru: Рейтинг Google
stat2: 2000+     — ka: კმაყოფილი პაციენტი | en: Happy Patients | ru: Довольных пациентов
stat3: 10+       — ka: წელი გამოცდილება | en: Years Experience | ru: Лет опыта
stat4: 15+       — ka: სპეციალისტი | en: Specialists | ru: Специалистов
```

**CTA buttons**:
```
Primary:   ka: დაჯავშნე ვიზიტი | en: Book a Visit | ru: Записаться
Secondary: ka: დაგვირეკეთ | en: Call Us | ru: Позвоните нам
```

**Working hours day names**:
```
ორშაბათი→Mon/Пн  სამშაბათი→Tue/Вт  ოთხშაბათი→Wed/Ср
ხუთშაბათი→Thu/Чт  პარასკევი→Fri/Пт  შაბათი→Sat/Сб  კვირა→Sun/Вс
```

---

## 9. RESPONSIVE BREAKPOINTS

```css
/* Desktop:  > 1024px — full layout */
/* Tablet:   768px-1024px — 2-column grids, smaller hero */
/* Mobile:   < 768px — single column, burger menu, stacked hero */
/* Small:    < 480px — tighter spacing, smaller fonts */
```

Mobile navigation: Burger menu icon → full-screen overlay or slide-in drawer with language toggle included.

---

## 10. ANIMATION STANDARDS

### All Modes — Scroll Reveal
Use `IntersectionObserver` with `threshold: 0.15` to trigger `.visible` class:
```javascript
const obs = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('v'); obs.unobserve(e.target); }});
}, { threshold: 0.15 });
document.querySelectorAll('.rv').forEach(el => obs.observe(el));
```

### Mode G — CSS-Only Animations
- Aurora orb drift: `@keyframes orbit` with translate + scale
- Card hover: `translateY(-8px)` + border glow + box-shadow
- Stagger: Use `animation-delay` incrementally on children

### Mode C — GSAP Animations
Include via CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/ScrollTrigger.min.js"></script>
```
- Loading screen → hero reveal timeline
- Word-by-word stagger on hero heading
- 3D tilt on service cards (mousemove)
- Horizontal scroll gallery (ScrollTrigger pin)
- Counter number animation (textContent snap)
- Section fade-in with ScrollTrigger

### Mode K — CSS + Vanilla JS
- Custom cursor tracking via `mousemove`
- Clip-path hero reveal on load
- Line-by-line text reveal (translateY within overflow:hidden containers)
- Accordion toggle with height animation
- Stacked gallery with scroll events

---

## 11. GENERATION WORKFLOW

When asked to generate a page for a specific clinic:

### Step 1: Determine Design
```
Input: clinic JSON object
→ Run djb2(clinic.name)
→ Determine mode (G/C/K)
→ Determine palette (P01-P24)
→ Look up font pairing
```

### Step 2: Extract Data
```
→ Parse name (split on | if bilingual)
→ Filter imageUrls (w800 only, max 8)
→ Deduplicate reviews, filter 4★+, take max 6
→ Parse workingHours into structured day/time objects
→ Collect phone, address, emails, socialLinks, googleMapsUrl
→ Get rating + reviewsCount
```

### Step 3: Build HTML
```
→ Apply palette CSS variables to :root
→ Load Google Fonts for assigned font pair + Noto Sans Georgian
→ Build all sections per Section Structure (§7)
→ Inject trilingual content per Translation Guidelines (§8)
→ Add mode-specific animations (§10)
→ Inline all CSS in <style> tag
→ Inline all JS in <script> tag at end of body
→ Self-contained single .html file
```

### Step 4: Quality Checks
```
→ All text trilingual? (every user-visible string has ka/en/ru spans)
→ No placeholder text? (no "Lorem ipsum", no "XXX", no "example.com")
→ Responsive? (test mental model at 375px, 768px, 1200px)
→ Missing data handled? (empty arrays → section hidden, not empty)
→ Proper Georgian rendering? (Noto Sans Georgian loaded)
→ CTA buttons functional? (tel: links, mailto: links work)
→ Rating accurate? (matches clinic.rating, correct stars filled)
→ No fabricated data? (only use what's in the JSON)
```

---

## 12. FILE NAMING

Output files should be named by sanitizing the clinic name:
```
{clinic_name_sanitized}.html
```

Sanitize: lowercase, replace spaces/special chars with hyphens, remove Georgian chars, keep Latin alphanumeric + hyphens, collapse multiple hyphens, trim hyphens from edges.

If name is purely Georgian, transliterate or use the English portion if `|` exists.

---

## 13. EXAMPLE INVOCATION

To generate a page for a specific clinic, provide the clinic JSON and say:

> "Generate a single HTML page for this clinic using the GENERATE-SINGLE-PAGE.md prompt"

The generator will:
1. Hash the name → get Mode K + Palette P14 (for example)
2. Load Alpine Blue colors + Clash Display/General Sans fonts
3. Build a kinetic/brutalist light-themed page
4. Inject all real data from the JSON
5. Output a single self-contained HTML file

---

## 14. VISUAL DIFFERENTIATION GUARANTEES

- **No two clinics** with the same palette + mode combination will look identical because the real data (name, images, reviews, rating) differs
- **24 palettes × 3 modes = 72 visual combinations** — for 335 clinics, some share a combination but real content makes them unique
- **Font pairings rotate** with palette, ensuring typographic variety
- **Dark/Light split**: ~67% dark pages (Glass + Cinematic), ~33% light pages (Kinetic) — natural variety
- **Animation style varies**: CSS-only (Glass) vs GSAP-heavy (Cinematic) vs vanilla JS (Kinetic)

---

## 15. DESIGN PRINCIPLES (Non-Negotiable)

1. **No generic AI aesthetics**: No Inter font, no purple-on-white gradient clichés, no cookie-cutter layouts
2. **Bold color commitment**: Dominant accent with strategic use, not timid even distribution
3. **Typography-driven**: Display fonts create hierarchy, body fonts maintain readability
4. **Atmosphere**: Every page has depth — noise textures, gradients, blurred elements, overlapping layers
5. **Motion with purpose**: Every animation serves UX (reveal, guide eye, delight) — no gratuitous movement
6. **Conversion-focused**: Clear CTA hierarchy, phone number prominent, trust signals (rating, reviews)
7. **Georgian-first**: Default language is Georgian, layout respects Georgian script characteristics
8. **Real data only**: Never fabricate reviews, ratings, services, or clinic details
9. **Self-contained**: Single HTML file with all CSS + JS inlined, only external = Google Fonts + GSAP CDN
10. **Premium feel**: Every page should look like it cost $5000+ to design — that's the sales pitch
