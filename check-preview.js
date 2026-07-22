// Quick syntax check for public/preview.html's JavaScript.
// Run:  node check-preview.js
// Prints OK, or the exact line/column of any syntax error.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, 'public', 'preview.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.error('No <script> blocks found.'); process.exit(1); }
const js = blocks.join('\n;\n');
try {
  vm.compileFunction(js, [], { filename: 'preview-inline.js' });
  console.log(`OK — preview.html script parses cleanly (${blocks.length} block(s), ${js.length} chars).`);
} catch (e) {
  console.error('SYNTAX ERROR in preview.html script:\n');
  console.error(e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
}
