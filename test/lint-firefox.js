// Validates the extension against Firefox's manifest schema via addons-linter.
//
//   node test/lint-firefox.js
//
// The linter walks whatever directory it is given, so the shippable files are
// staged into a temp dir first -- otherwise it lints node_modules and the test
// harness too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHIPPED = ['manifest.json', 'popup.html', 'popup.js', 'icons', 'src'];

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-lint-'));
try {
  for (const entry of SHIPPED) {
    fs.cpSync(path.join(ROOT, entry), path.join(staging, entry), { recursive: true });
  }

  const linter = spawnSync('npx', ['--no-install', 'addons-linter', staging], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  if (linter.error || linter.status === null) {
    console.error('\naddons-linter not available -- run: npm install');
    process.exit(1);
  }

  // A "service_worker ignored on Firefox" warning is expected and desired: it
  // confirms Firefox is falling through to background.scripts.
  process.exit(linter.status);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
