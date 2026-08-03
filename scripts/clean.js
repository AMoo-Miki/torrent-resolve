import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// tsc leaves behind output at paths it no longer emits to (rename a source file, change
// rootDir/outDir, and the old .d.ts just stays there). Wiping dist/ before every build makes
// that structural rather than something anyone has to remember.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
rmSync(dist, { recursive: true, force: true });
