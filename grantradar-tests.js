#!/usr/bin/env node
/**
 * GrantRadar CI Test Suite
 * ========================
 * Run before every commit: node grantradar-tests.js [path/to/index.html]
 *
 * Tests every failure mode that has caused a blank dashboard:
 *   1. JS syntax validity
 *   2. GRANTS array structure & boundaries
 *   3. Sentinel marker present
 *   4. Grant schema — every required field, correct types, valid values
 *   5. No grants injected into renderSidebar or any non-GRANTS location
 *   6. No duplicate IDs or duplicate URLs
 *   7. No expired grants (deadline < today)
 *   8. Deadline format (YYYY-MM-DD, "Rolling", or "TBC")
 *   9. All funder names are in the known FUNDERS list
 *  10. Sectors are all from the allowed list
 *  11. renderSidebar sections array is clean (6 entries, no grant objects)
 *  12. GRANTS array count matches stats (open + upcoming + closed = total)
 *  13. cardHtml() renders without throwing for every grant
 *  14. filterGrants() runs without throwing on all grants
 *  15. countFor() runs without throwing for every filter key/value combo
 *  16. sortGrants() runs without throwing
 *  17. No grant is in the file more than once (outside the GRANTS array)
 *
 * Exit code 0 = all tests passed. Exit code 1 = failures found.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────
const FILE = process.argv[2] || path.join(__dirname, 'index.html');
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

const VALID_STATUSES  = new Set(['open', 'upcoming', 'closed']);
const VALID_FUNDERS   = new Set(['Innovate UK','UKRI','SBRI','Wellcome Trust','EIC Europe','Horizon Europe','EIT Europe','Eureka','ERC']);
const VALID_SECTORS   = new Set(['AI','Advanced Manufacturing','Agritech','Biotech','Clean Tech','Deep Tech','Digital','Energy','Health','Mobility','Social Sciences']);
const VALID_CURRENCIES = new Set(['gbp', 'eur']);
const REQUIRED_FIELDS  = ['id','funder','title','amount','amtVal','currency','status','deadline','eligibility','type','trl','sectors','location','desc','url'];
const SENTINEL = '  // @@GRANTS_END@@';
const SIDEBAR_FN = 'function renderSidebar()';
const EXPECTED_SIDEBAR_SECTIONS = 6; // funder, status, sector, type, eligibility, location

// ── Test runner ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const failures = [];
const warnings = [];

function pass(name) {
  process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  passed++;
}
function fail(name, detail) {
  process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n`);
  if (detail) process.stdout.write(`      \x1b[31m${detail}\x1b[0m\n`);
  failures.push({ name, detail });
  failed++;
}
function warn(name, detail) {
  process.stdout.write(`  \x1b[33m⚠\x1b[0m ${name}\n`);
  if (detail) process.stdout.write(`      \x1b[33m${detail}\x1b[0m\n`);
  warnings.push({ name, detail });
  warned++;
}
function section(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

// ── Load file ──────────────────────────────────────────────────────────────
if (!fs.existsSync(FILE)) {
  console.error(`\x1b[31mERROR: File not found: ${FILE}\x1b[0m`);
  process.exit(1);
}
const content = fs.readFileSync(FILE, 'utf8');

// ── 1. JS SYNTAX ───────────────────────────────────────────────────────────
section('1. JavaScript Syntax');
const scriptStart = content.indexOf('<script>');
const scriptEnd   = content.lastIndexOf('</script>');
if (scriptStart === -1 || scriptEnd === -1) {
  fail('Script tags found', 'No <script> or </script> tag found');
} else {
  const js = content.slice(scriptStart + 8, scriptEnd);
  const tmpJs = '/tmp/grantradar_syntax_check.js';
  fs.writeFileSync(tmpJs, js);
  try {
    execSync(`node --check ${tmpJs} 2>&1`, { stdio: 'pipe' });
    pass('JS syntax valid');
  } catch (e) {
    fail('JS syntax valid', e.stdout?.toString()?.slice(0, 200) || e.message);
  }
}

// ── 2. STRUCTURAL MARKERS ──────────────────────────────────────────────────
section('2. File Structure');

// Sentinel
if (content.includes(SENTINEL)) {
  pass('Sentinel @@GRANTS_END@@ present');
} else {
  fail('Sentinel @@GRANTS_END@@ present', 'Sentinel missing — cron insertion will be unsafe');
}

// GRANTS array boundaries
const grantsStart = content.indexOf('const GRANTS = [');
const grantsEnd   = content.indexOf('\n];', grantsStart);
if (grantsStart === -1) {
  fail('const GRANTS = [ found', 'Array declaration missing');
} else if (grantsEnd === -1) {
  fail('GRANTS array closes with \\n];', 'Closing ]; not found after GRANTS start');
} else {
  pass('const GRANTS = [ found');
  pass('GRANTS array closes with \\n];');
}

// Exactly one GRANTS array (no duplicate declarations)
const grantsDecls = (content.match(/const GRANTS\s*=/g) || []).length;
grantsDecls === 1 ? pass('Exactly one GRANTS array declaration') :
  fail('Exactly one GRANTS array declaration', `Found ${grantsDecls} declarations`);

// ── 3. PARSE GRANTS ────────────────────────────────────────────────────────
section('3. GRANTS Array Parsing');

// Extract grants block
const grantsBlock = (grantsStart !== -1 && grantsEnd !== -1)
  ? content.slice(grantsStart, grantsEnd + 3)
  : '';

// Parse grants using Node eval with a sandboxed context
let GRANTS = [];
let parseError = null;
try {
  const vm = require('vm');
  const ctx = vm.createContext({});
  // Extract just the array literal
  const arrayLiteral = grantsBlock
    .replace('const GRANTS = ', '')
    .replace(/\n\/\/[^\n]*\n\];$/, '\n];')  // strip sentinel comment before ];
    .trim();
  GRANTS = vm.runInContext('(' + arrayLiteral.slice(0, -1) + ')', ctx); // strip trailing ;
} catch (e) {
  parseError = e.message;
}

if (parseError) {
  fail('GRANTS array parseable', parseError.slice(0, 200));
} else {
  pass(`GRANTS array parseable (${GRANTS.length} grants)`);
}

// ── 4. GRANT SCHEMA ────────────────────────────────────────────────────────
section('4. Grant Schema Validation');

if (GRANTS.length > 0) {
  const schemaErrors = [];
  const badStatuses  = [];
  const badDeadlines = [];
  const badFunders   = [];
  const badSectors   = [];
  const badCurrencies = [];
  const badAmtVals   = [];
  const badTrls      = [];
  const badUrls      = [];
  const expiredGrants = [];

  for (const g of GRANTS) {
    // Required fields
    for (const field of REQUIRED_FIELDS) {
      if (g[field] === undefined || g[field] === null || g[field] === '') {
        schemaErrors.push(`${g.id || '?'}: missing field "${field}"`);
      }
    }

    // status must be exactly open/upcoming/closed
    if (g.status !== undefined && !VALID_STATUSES.has(g.status)) {
      badStatuses.push(`${g.id}: status="${g.status}" (must be open/upcoming/closed)`);
    }

    // deadline must be YYYY-MM-DD, "Rolling", or "TBC"
    if (g.deadline && g.deadline !== 'Rolling' && g.deadline !== 'TBC') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(g.deadline)) {
        badDeadlines.push(`${g.id}: deadline="${g.deadline}" (must be YYYY-MM-DD)`);
      } else {
        // Check not expired
        const d = new Date(g.deadline);
        d.setHours(0,0,0,0);
        if (d < TODAY) {
          expiredGrants.push(`${g.id}: deadline ${g.deadline} is in the past`);
        }
      }
    }

    // funder must be in known list
    if (g.funder && !VALID_FUNDERS.has(g.funder)) {
      badFunders.push(`${g.id}: funder="${g.funder}"`);
    }

    // sectors must be array, all from allowed list
    if (g.sectors !== undefined) {
      if (!Array.isArray(g.sectors) || g.sectors.length === 0) {
        badSectors.push(`${g.id}: sectors must be a non-empty array`);
      } else {
        for (const s of g.sectors) {
          if (!VALID_SECTORS.has(s)) {
            badSectors.push(`${g.id}: unknown sector "${s}"`);
          }
        }
      }
    }

    // currency
    if (g.currency !== undefined && !VALID_CURRENCIES.has(g.currency)) {
      badCurrencies.push(`${g.id}: currency="${g.currency}"`);
    }

    // amtVal must be a number
    if (g.amtVal !== undefined && typeof g.amtVal !== 'number') {
      badAmtVals.push(`${g.id}: amtVal="${g.amtVal}" (must be number)`);
    }

    // trl must be [min, max] array of two numbers
    if (g.trl !== undefined) {
      if (!Array.isArray(g.trl) || g.trl.length !== 2 ||
          typeof g.trl[0] !== 'number' || typeof g.trl[1] !== 'number' ||
          g.trl[0] < 1 || g.trl[1] > 9 || g.trl[0] > g.trl[1]) {
        badTrls.push(`${g.id}: trl=${JSON.stringify(g.trl)} (must be [min,max] 1-9)`);
      }
    }

    // url must start with http
    if (g.url !== undefined && !g.url.startsWith('http')) {
      badUrls.push(`${g.id}: url="${g.url}"`);
    }
  }

  schemaErrors.length === 0 ? pass('All grants have required fields') :
    fail('All grants have required fields', schemaErrors.slice(0,5).join('; '));

  badStatuses.length === 0 ? pass('All status values are open/upcoming/closed') :
    fail('All status values are open/upcoming/closed', badStatuses.slice(0,5).join('; '));

  badDeadlines.length === 0 ? pass('All deadlines in YYYY-MM-DD / Rolling / TBC format') :
    fail('All deadlines in YYYY-MM-DD / Rolling / TBC format', badDeadlines.slice(0,5).join('; '));

  badFunders.length === 0 ? pass('All funder names are in the known list') :
    warn('All funder names are in the known list', badFunders.slice(0,5).join('; '));

  badSectors.length === 0 ? pass('All sectors are from the allowed list') :
    fail('All sectors are from the allowed list', badSectors.slice(0,5).join('; '));

  badCurrencies.length === 0 ? pass('All currencies are gbp or eur') :
    fail('All currencies are gbp or eur', badCurrencies.slice(0,5).join('; '));

  badAmtVals.length === 0 ? pass('All amtVal fields are numbers') :
    fail('All amtVal fields are numbers', badAmtVals.slice(0,5).join('; '));

  badTrls.length === 0 ? pass('All trl fields are [min, max] arrays') :
    fail('All trl fields are [min, max] arrays', badTrls.slice(0,5).join('; '));

  badUrls.length === 0 ? pass('All URLs start with http') :
    fail('All URLs start with http', badUrls.slice(0,5).join('; '));

  expiredGrants.length === 0 ? pass('No expired grants (all deadlines are future or Rolling)') :
    warn('No expired grants', expiredGrants.join('; '));
}

// ── 5. DUPLICATE CHECKS ────────────────────────────────────────────────────
section('5. Duplicate Detection');

if (GRANTS.length > 0) {
  const idCounts   = {};
  const urlCounts  = {};
  for (const g of GRANTS) {
    idCounts[g.id]   = (idCounts[g.id]   || 0) + 1;
    if (g.url) urlCounts[g.url] = (urlCounts[g.url] || 0) + 1;
  }
  const dupIds  = Object.entries(idCounts).filter(([,v]) => v > 1).map(([k]) => k);
  const dupUrls = Object.entries(urlCounts).filter(([,v]) => v > 1).map(([k]) => k);

  dupIds.length === 0 ? pass('No duplicate grant IDs') :
    fail('No duplicate grant IDs', dupIds.join(', '));

  dupUrls.length === 0 ? pass('No duplicate grant URLs') :
    warn('No duplicate grant URLs', dupUrls.slice(0,3).join(', '));
}

// ── 6. STRUCTURAL CONTAMINATION ───────────────────────────────────────────
section('6. Structural Contamination');

// No grant objects inside renderSidebar
const sidebarIdx   = content.indexOf(SIDEBAR_FN);
const sidebarChunk = sidebarIdx !== -1 ? content.slice(sidebarIdx, sidebarIdx + 1500) : '';
const grantInSidebar = /id:"[a-z]+-\d+"/.test(sidebarChunk);
grantInSidebar
  ? fail('No grant objects inside renderSidebar()', 'Grant id found in renderSidebar — dashboard will be blank')
  : pass('No grant objects inside renderSidebar()');

// renderSidebar sections array has exactly EXPECTED_SIDEBAR_SECTIONS entries
const sectionMatches = sidebarChunk.match(/\{\s*key:/g) || [];
sectionMatches.length === EXPECTED_SIDEBAR_SECTIONS
  ? pass(`renderSidebar has exactly ${EXPECTED_SIDEBAR_SECTIONS} section entries`)
  : fail(`renderSidebar has exactly ${EXPECTED_SIDEBAR_SECTIONS} section entries`,
      `Found ${sectionMatches.length} — expected ${EXPECTED_SIDEBAR_SECTIONS}. Structural corruption detected.`);

// All grant IDs appear only inside the GRANTS array block (not elsewhere in JS)
if (GRANTS.length > 0 && grantsStart !== -1 && grantsEnd !== -1) {
  const beforeGrants = content.slice(0, grantsStart);
  const afterGrants  = content.slice(grantsEnd + 3);
  const leakedIds = GRANTS.map(g => g.id).filter(id =>
    beforeGrants.includes(`id:"${id}"`) || afterGrants.includes(`id:"${id}"`)
  );
  leakedIds.length === 0 ? pass('No grant IDs found outside the GRANTS array') :
    fail('No grant IDs found outside the GRANTS array', leakedIds.slice(0,5).join(', '));
}

// ── 7. RUNTIME FUNCTION TESTS ─────────────────────────────────────────────
section('7. Runtime Function Tests');

if (GRANTS.length > 0 && !parseError) {
  // Simulate the browser environment minimally
  const vm = require('vm');
  const mockDoc = {
    getElementById: () => ({ innerHTML: '', addEventListener: ()=>{}, classList: { add:()=>{}, remove:()=>{}, toggle:()=>false }, style:{} }),
    querySelectorAll: () => ({ forEach: ()=>{} }),
    addEventListener: ()=>{}
  };
  const ctx = vm.createContext({ document: mockDoc, console, GRANTS });

  // Load all JS helpers into the context
  const js = content.slice(scriptStart + 8, scriptEnd);
  // Remove the init calls at the bottom (renderAll, renderStats etc) to avoid DOM errors
  const jsNoInit = js.replace(/^renderAll\(\);?\s*$/m, '// renderAll();')
                     .replace(/^renderStats\(\);?\s*$/m, '// renderStats();')
                     .replace(/^document\.addEventListener/m, '// document.addEventListener');
  try {
    vm.runInContext(jsNoInit, ctx);

    // Test cardHtml on every single grant
    let cardErrors = [];
    for (const g of GRANTS) {
      try {
        const html = ctx.cardHtml(g);
        if (typeof html !== 'string' || html.length < 50) {
          cardErrors.push(`${g.id}: returned empty or non-string`);
        }
      } catch (e) {
        cardErrors.push(`${g.id}: ${e.message}`);
      }
    }
    cardErrors.length === 0
      ? pass(`cardHtml() renders all ${GRANTS.length} grants without errors`)
      : fail('cardHtml() renders all grants without errors', cardErrors.slice(0,5).join('; '));

    // Test filterGrants (no active filters — should return all)
    try {
      const filtered = ctx.filterGrants(GRANTS);
      filtered.length === GRANTS.length
        ? pass(`filterGrants() returns all ${GRANTS.length} grants with no active filters`)
        : fail('filterGrants() returns all grants with no active filters',
            `Got ${filtered.length}, expected ${GRANTS.length}`);
    } catch(e) {
      fail('filterGrants() runs without errors', e.message);
    }

    // Test sortGrants
    try {
      const sorted = ctx.sortGrants(GRANTS);
      sorted.length === GRANTS.length
        ? pass('sortGrants() runs without errors')
        : fail('sortGrants() runs without errors', `Got ${sorted.length} results`);
    } catch(e) {
      fail('sortGrants() runs without errors', e.message);
    }

    // Test countFor on every filter key with each value
    const filterTests = [
      ['funder',      [...VALID_FUNDERS]],
      ['status',      ['Open','Upcoming','Closed']],
      ['sector',      [...VALID_SECTORS].slice(0,4)],
      ['type',        ['Grant','Fellowship']],
      ['eligibility', ['SME','University']],
      ['location',    ['UK','EU + Associated']],
    ];
    let countForErrors = [];
    for (const [key, values] of filterTests) {
      for (const value of values) {
        try {
          const count = ctx.countFor(key, value, GRANTS);
          if (typeof count !== 'number') countForErrors.push(`countFor(${key}, ${value}): not a number`);
        } catch(e) {
          countForErrors.push(`countFor(${key}, ${value}): ${e.message}`);
        }
      }
    }
    countForErrors.length === 0
      ? pass('countFor() runs without errors for all filter keys/values')
      : fail('countFor() runs without errors for all filter keys/values', countForErrors.slice(0,5).join('; '));

  } catch(e) {
    fail('JS context initialises without errors', e.message.slice(0, 200));
  }
}

// ── 8. STATS INTEGRITY ────────────────────────────────────────────────────
section('8. Stats Integrity');

if (GRANTS.length > 0) {
  const openCount     = GRANTS.filter(g => g.status === 'open').length;
  const upcomingCount = GRANTS.filter(g => g.status === 'upcoming').length;
  const closedCount   = GRANTS.filter(g => g.status === 'closed').length;
  const total         = GRANTS.length;

  (openCount + upcomingCount + closedCount === total)
    ? pass(`Stats add up: ${openCount} open + ${upcomingCount} upcoming + ${closedCount} closed = ${total} total`)
    : fail('Stats add up', `${openCount} + ${upcomingCount} + ${closedCount} ≠ ${total}`);

  total > 0 ? pass(`GRANTS array is non-empty (${total} grants)`) :
    fail('GRANTS array is non-empty', 'No grants found — dashboard will show 0');
}

// ── 9. FUNDER COVERAGE ────────────────────────────────────────────────────
section('9. Funder Coverage');

if (GRANTS.length > 0) {
  const fundersPresent = new Set(GRANTS.map(g => g.funder));
  for (const f of VALID_FUNDERS) {
    fundersPresent.has(f)
      ? pass(`${f} has at least one grant`)
      : warn(`${f} has at least one grant`, 'No grants from this funder — may have all been removed');
  }
}

// ── SUMMARY ───────────────────────────────────────────────────────────────
const total_tests = passed + failed + warned;
process.stdout.write(`\n${'─'.repeat(60)}\n`);
process.stdout.write(`\x1b[1mResults: ${total_tests} checks — `);
process.stdout.write(`\x1b[32m${passed} passed\x1b[0m\x1b[1m, `);
if (failed > 0) process.stdout.write(`\x1b[31m${failed} failed\x1b[0m\x1b[1m, `);
if (warned > 0) process.stdout.write(`\x1b[33m${warned} warnings\x1b[0m\x1b[1m`);
process.stdout.write(`\x1b[0m\n`);

if (failed > 0) {
  process.stdout.write(`\n\x1b[31mFAILURES:\x1b[0m\n`);
  for (const f of failures) {
    process.stdout.write(`  ✗ ${f.name}\n`);
    if (f.detail) process.stdout.write(`    → ${f.detail}\n`);
  }
  process.stdout.write(`\n\x1b[31m❌ DO NOT COMMIT — fix failures above first\x1b[0m\n`);
  process.exit(1);
} else {
  process.stdout.write(`\n\x1b[32m✅ All checks passed — safe to commit\x1b[0m\n`);
  process.exit(0);
}
