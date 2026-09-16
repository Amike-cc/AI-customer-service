import fs from 'fs';
import vm from 'vm';

// Load the compiled JS module to get the ACTUAL evaluated string
const compiledPath = 'd:/code/AIkefu/dist/src/product/ProductSyncService.js';
const compiled = fs.readFileSync(compiledPath, 'utf-8');

// We need to extract the evaluated string, not the raw template literal
// The compiled JS has: const SCRAPE_PRODUCT_LIST_SCRIPT = `...`;
// When Node.js evaluates this, the template literal is processed

// Use a sandbox to evaluate just the template literal
const marker = 'const SCRAPE_PRODUCT_LIST_SCRIPT = ';
const idx = compiled.indexOf(marker);
if (idx < 0) { console.log('Marker not found'); process.exit(1); }

// Extract the assignment statement (up to the semicolon)
let end = idx + marker.length;
let depth = 0;
let inString = false;
let stringChar = '';
let inTemplate = false;
let i = idx + marker.length;
while (i < compiled.length) {
  const ch = compiled[i];
  if (inTemplate) {
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') { inTemplate = false; }
    i++;
    continue;
  }
  if (ch === '`') { inTemplate = true; i++; continue; }
  if (ch === ';' && !inString) { end = i; break; }
  i++;
}
const assignment = compiled.substring(idx, end + 1);

// Evaluate the assignment in a sandbox to get the actual string value
const sandbox = { config: { platformId: 'feige' }, JSON };
const context = vm.createContext(sandbox);
// The template literal references ${JSON.stringify(config.platformId)} - we need to provide that
const wrappedCode = `
  var config = { platformId: 'feige' };
  ${assignment}
  SCRAPE_PRODUCT_LIST_SCRIPT
`;

try {
  const result = vm.runInContext(wrappedCode, context);
  console.log('Template literal evaluated successfully!');
  console.log('Script length:', result.length, 'chars,', result.split('\n').length, 'lines');

  // Now try to parse the EVALUATED string
  try {
    new vm.Script(result, { filename: 'evaluated-scrape-script.js' });
    console.log('EVALUATED SCRIPT PARSES CORRECTLY! ✓');
  } catch (e) {
    console.log('EVALUATED SCRIPT SYNTAX ERROR:', e.message);
    const match = e.stack.match(/evaluated-scrape-script\.js:(\d+)/);
    if (match) {
      const lineNum = parseInt(match[1]);
      const lines = result.split('\n');
      console.log(`\nAround line ${lineNum}:`);
      for (let l = Math.max(0, lineNum - 3); l < Math.min(lines.length, lineNum + 2); l++) {
        console.log(`${l + 1}: ${lines[l]}`);
      }
    }
  }
} catch (e) {
  console.log('Template literal evaluation failed:', e.message);
}
