import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// `prepare` runs on every local `npm install`, including in checkouts that have no .git at all
// (a CI artifact, an extracted tarball). simple-git-hooks exits non-zero there, which would fail
// the install over a hook nobody asked for. Absent .git, skipping is the right outcome, so check
// first rather than swallowing the error afterward.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(new URL('../.git', import.meta.url))) process.exit(0);

// Called in-process rather than by shelling out to its CLI. Spawning it needs a shell on Windows
// to resolve the .cmd wrapper, and passing arguments through a shell is deprecated in Node 22
// because they get concatenated instead of escaped.
const { setHooksFromConfig, skipInstall } = createRequire(import.meta.url)('simple-git-hooks');
if (skipInstall()) process.exit(0);

await setHooksFromConfig(projectRoot);
