import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// release-please derives the next version and the whole changelog from these commit subjects. A
// subject it cannot parse is not an error there, it is simply skipped, so the release ships
// without mentioning the change. That is invisible until someone goes looking for an entry that
// was never written, which is why this runs at authoring time instead.
const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9._/-]+\\))?(!)?: .+$`);
const MAX_SUBJECT_LENGTH = 100;

// Written by git itself, or by a rebase replaying work that was already checked once.
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

// git passes the path of the file holding the message. simple-git-hooks writes the configured
// command into the hook verbatim without forwarding "$@", so package.json has to pass "$1"
// through explicitly. Fail loudly rather than guessing at .git/COMMIT_EDITMSG, which is not
// always the file git means (a merge uses MERGE_MSG) and would silently check the wrong text.
const messagePath = process.argv[2];
if (!messagePath) {
  console.error('check-commit-msg.js expects the commit message file as its first argument.');
  console.error('The commit-msg hook should run: node scripts/check-commit-msg.js "$1"');
  process.exit(1);
}

const raw = readFileSync(messagePath, 'utf8');
const lines = raw.split(/\r?\n/).filter((line) => !line.startsWith('#'));
const subject = lines.find((line) => line.trim() !== '') ?? '';
const message = lines.join('\n');

if (GIT_GENERATED.test(subject)) process.exit(0);

/** Reads package.json at a git revision. `:` is the staged copy, i.e. what this commit will contain. */
const versionAt = (rev) => {
  try {
    return JSON.parse(execFileSync('git', ['show', `${rev}package.json`], { encoding: 'utf8' })).version ?? null;
  } catch {
    return null; // no such revision (first commit) or no package.json there
  }
};

const stagedVersion = versionAt(':');
const previousVersion = versionAt('HEAD:');
const versionChanged = stagedVersion !== null && previousVersion !== null && stagedVersion !== previousVersion;

/** release-please's own record of what is currently released; authoritative over package.json. */
const readManifestVersion = () => {
  try {
    return JSON.parse(execFileSync('git', ['show', ':.release-please-manifest.json'], { encoding: 'utf8' }))['.'];
  } catch {
    return null;
  }
};

/** @param {string} v @returns {[number, number, number]|null} */
const parseSemver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** @param {number[]} a @param {number[]} b */
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** @param {string} text */
const firstLine = (text) => text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';

/** @param {string} text */
const declaresBreaking = (text) => /^[a-z]+(\([^)]*\))?!:/.test(firstLine(text)) || /^BREAKING[ -]CHANGE:/m.test(text);

/** @param {string} text */
const declaresFeature = (text) => /^feat(\([^)]*\))?!?:/.test(firstLine(text));

/**
 * The bump these commits imply, which is what release-please would compute on its own. Below 1.0
 * a breaking change only reaches minor, because `^0.1.0` admits nothing outside `0.1.x` and
 * `bump-minor-pre-major` is set; from 1.0 onward it reaches major.
 * @param {number} currentMajor
 * @param {{breaking: boolean, feature: boolean}} found
 */
const impliedBump = (currentMajor, found) => {
  if (currentMajor === 0) return found.breaking || found.feature ? 'minor' : 'patch';
  if (found.breaking) return 'major';
  if (found.feature) return 'minor';
  return 'patch';
};

/** @param {number[]} current @param {number[]} target */
const declaredBump = (current, target) => {
  if (target[0] > current[0]) return 'major';
  if (target[1] > current[1]) return 'minor';
  return 'patch';
};

/** Commit messages already on this branch since the last release tag, this one excluded. */
const rangeMessages = () => {
  try {
    const args = ['log', '--format=%B%x00'];
    try {
      const lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim();
      args.push(`${lastTag}..HEAD`);
    } catch {
      // No tags yet, so everything on the branch belongs to the upcoming first release.
    }
    return execFileSync('git', args, { encoding: 'utf8' }).split('\0');
  } catch {
    return [];
  }
};

const errors = [];

if (!HEADER.test(subject)) {
  errors.push(
    'Subject is not a conventional commit.\n' +
      `    got:      ${subject || '(empty)'}\n` +
      '    expected: type(optional-scope): summary\n' +
      `    types:    ${TYPES.join(', ')}\n` +
      '    append !  to the type for a breaking change, e.g. feat!: drop Node 22',
  );
} else if (subject.length > MAX_SUBJECT_LENGTH) {
  errors.push(`Subject is ${subject.length} characters; keep it under ${MAX_SUBJECT_LENGTH}.`);
}

// release-please owns the version. Its Release PR is what edits package.json, CHANGELOG.md and
// the manifest, and it derives the bump from the commit types: `feat!` or a BREAKING CHANGE
// footer gives a major, `feat` a minor, `fix` a patch. Hand-editing the version here does not
// release anything; it just gives two sources of truth that drift, and release-please's next PR
// overwrites whatever was typed. Use --no-verify for the one-time registry bootstrap documented
// in .github/workflows/release.yml, which is the only time a human sets this by hand.
if (versionChanged) {
  errors.push(
    `This commit changes the package.json version (${previousVersion} -> ${stagedVersion}).\n` +
      '    release-please owns that field and sets it in the Release PR. To release a specific\n' +
      '    version, leave package.json alone and add a Release-As footer instead.',
  );
}

const releaseAs = /^Release-As:\s*(.+)$/im.exec(message);
if (releaseAs) {
  const declared = releaseAs[1].trim().replace(/^v/, '');
  const target = parseSemver(declared);
  const current = parseSemver(readManifestVersion() ?? previousVersion ?? '');

  if (!target) {
    errors.push(`Release-As: ${declared} is not a valid semver version (expected MAJOR.MINOR.PATCH).`);
  } else if (current && compare(target, current) <= 0) {
    errors.push(
      `Release-As: ${declared} is not greater than the current released version ${current.join('.')}.\n` +
        '    A release cannot go backwards or repeat a version already published.',
    );
  } else if (current) {
    // Commit types alone can never produce a wrong version, because release-please derives it.
    // This footer is the one place a human overrides that, so it is the one place worth checking
    // the override still agrees with what the commits actually say.
    const inRange = [message, ...rangeMessages()];
    const found = { breaking: inRange.some(declaresBreaking), feature: inRange.some(declaresFeature) };
    const expected = impliedBump(current[0], found);
    const actual = declaredBump(current, target);

    if (actual !== expected) {
      const saw = found.breaking
        ? 'a breaking change'
        : found.feature
          ? 'a feat but no breaking change'
          : 'neither a feat nor a breaking change';
      errors.push(
        `Release-As: ${declared} is a ${actual} bump from ${current.join('.')}, but the commits since\n` +
          `    the last release contain ${saw}, which implies a ${expected} bump.\n` +
          (expected === 'major'
            ? '    Declare the major version, or drop the breaking marker if it was not breaking.'
            : expected === 'minor'
              ? '    Declare the minor version, or use fix/chore types if nothing was added.'
              : '    Declare the patch version, or mark the commit that added something as feat.') +
          (current[0] === 0 ? '\n    (Below 1.0 a breaking change implies a minor bump, not a major.)' : ''),
      );
    }
  }
}

if (errors.length > 0) {
  console.error('\nCommit rejected:\n');
  for (const error of errors) console.error(`  - ${error}\n`);
  console.error('Fix the message and commit again, or pass --no-verify to override deliberately.\n');
  process.exit(1);
}
