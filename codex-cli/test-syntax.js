// Test the server.ts file for syntax errors
const fs = require('fs');

try {
  const content = fs.readFileSync('/Users/thiagosantana/projects/innovation-sprint/open-codex-http/codex-cli/src/server.ts', 'utf8');
  
  // Basic brace matching
  const openBraces = (content.match(/{/g) || []).length;
  const closeBraces = (content.match(/}/g) || []).length;
  
  console.log('Open braces:', openBraces);
  console.log('Close braces:', closeBraces);
  console.log('File length:', content.length);
  console.log('Balanced:', openBraces === closeBraces ? 'YES' : 'NO');
  
} catch (error) {
  console.error('Error:', error.message);
}