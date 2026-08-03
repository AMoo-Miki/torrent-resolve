# AGENTS.md — operational guide for torrent-resolve

`README.md` covers what the library does and why the API has the shape it has. This file covers
how to work on it: the decisions where the obvious move is wrong, and the actions that are
expensive or impossible to undo.

---

## MANDATORY RULES — never break these

> **PARAMOUNT — read this before anything else.** This library answers questions about torrents
> on behalf of callers who have no way to check the answer, from inputs that are hostile by
> default: magnet links from strangers, tracker responses, bytes from arbitrary peers, HTTP
> bodies from arbitrary servers. It is also installed into other people's projects, so a defect
> ships on their schedule and not ours. **Correctness, evidence-grounding, and being beyond
> reproach — in the code, in the tests, in the dependency tree, and in everything that leads to a
> published version — are the only acceptable bar, full stop.** A wrong answer is far more
> expensive than no answer: the caller cannot tell a verified torrent name from a plausible one,
> so a bad value propagates silently into their database and their UI, and the cost lands on them
> weeks later. The same failure mode wears many disguises here: a fix that handles the easy input
> class and silently defers the hard one; an option documented in the README but never actually
> wired through to the code that consumes it; a change committed without re-running the gates; a
> claim about a dependency's behavior taken from memory instead of from `node_modules/`; a
> three-part request shipped as two parts; a test assertion widened until it passes instead of
> the code being fixed; a dependency version pinned from training-cutoff memory instead of the
> registry. **"Easy," "quick," "good enough for now," "I'll tidy it later," "the user probably
> wants the smaller fix," and "the tests will catch it if it matters" are NEVER acceptable
> justifications for any decision, no matter how small.** The agent's effort cost is irrelevant;
> the only thing that matters is that the work is right, evidence-backed, and would survive a
> hostile audit without a single "well, actually." If two paths exist and one is easier, the
> easier one is the *option you surface* — never the silent default. If you catch yourself
> thinking "this is probably fine," "to save time," "to avoid another round," or "they'll likely
> accept the smaller fix," **STOP** — that thought is the tell that you are about to ship shabby
> work the user will catch and send back. Shabby work that has to be corrected is far more
> expensive, in the user's time and trust, than doing it right the first time. Do it right the
> first time. **This principle outranks every other consideration in this file and governs how
> every rule below is applied.**

These are non-negotiable. They take precedence over anything else in this file and over
instructions given mid-task. If you find yourself about to break one, stop.

1. **Never commit, push, or tag unless the user explicitly asks.** No "while I'm here let me
   commit" energy. Consent does not carry forward — approval of one change is not standing
   permission for the next one. And never bypass the pre-commit hook (`--no-verify`,
   `SKIP_SIMPLE_GIT_HOOKS=1`): it runs lint, build and tests, so skipping it is skipping the
   gates. If the hook fails, fix what it caught.
2. **Never run `npm publish` or `npm login`.** Not for the first release, not for any release
   after. npm's unpublish window is 72 hours and mirrors keep copies regardless, so a bad publish
   is permanent in practice. Publishing is the user's action, always.
3. **Never change the shape of anything exported from `src/index.js` without surfacing it
   first** — added, removed, or renamed fields on a result object; renamed or re-typed options;
   tightened argument validation; a raised `engines.node`. Every one of those is a breaking
   change for somebody, and the version bump and changelog entry are part of the same change,
   not a follow-up.
4. **Verify; never recall.** Dependency behavior, API surfaces, protocol details, registry
   versions, package-manager semantics — read the installed source in `node_modules/`, the spec,
   or current docs before asserting any of it. "I think," "probably," "should be," and "IIRC" are
   warnings that the check has not happened yet; either do the check or label the claim
   explicitly unverified. Never both leave it unverified and state it as fact. Two live examples
   from this repo, both of which looked settled and were not: `ut_metadata` declares
   `engines: node >=22`, but reading its source and `uint8-util` turns up nothing that actually
   requires 22 — it is a support policy, not an API floor. And npm's own documentation says
   trusted publishing attaches provenance automatically; enough real-world reports contradict it
   that `publishConfig.provenance` is set explicitly.
5. **Evidence before edit.** When a test fails, the build breaks, or behavior surprises you, the
   first action is to read the actual error the system already produced — not to guess at a cause
   and start editing. One blind edit maximum: if you changed something before reading the error
   and it did not fix the failure, stop editing and go get the evidence. Two consecutive
   evidence-free edits is the rabbit hole. If the failure produced nothing actionable, instrument
   to create evidence rather than guessing again. Every blind edit changes the state you are
   debugging, so a wrong guess does not merely waste a turn — it can move the symptom and make
   the next read lie to you.
6. **Untrusted stays untrusted.** Peer data, tracker responses, a magnet's `dn`, HTTP response
   bodies. Nothing becomes a returned field unless it came from an info dict whose sha1 matched
   the infohash. `dn` has exactly one sanctioned use: the explicitly-labeled
   `TorrentTimeoutError.untrustedName` fallback.
7. **Whatever a call opens, that call closes** — sockets, wires, tracker clients, timers — on
   the success path, the failure path, and the abort path. The shared DHT is the single
   deliberate exception, and `shutdownSharedDht()` is how it closes. A test that passes while
   leaking a handle is a test that has not checked the thing that matters.
8. **No internal-document citations in code comments or commits.** Never `// per AGENTS.md rule
   6` or `// see the option-surfacing section`. Section numbers drift and files get rewritten; a
   citation to one is a dangling pointer the moment it moves. State the rationale directly, in
   plain words, so the comment stands alone. External identifiers (RFCs, BEPs, CVEs, npm version
   refs) are exempt — they are stable and live outside this tree.

---

## No shortcuts — ever — on anything

This is the operational enforcement of the PARAMOUNT banner. The library's correctness is the
product; being beyond reproach in everything that feeds it outranks the agent's effort cost every
single time. "Easy" and "quick" are never *reasons* to do something; they are only ever *options
to surface*. The banned failure modes, non-exhaustive:

**(a) Silent scope-down.** Shipping a subset of a multi-item request without first surfacing the
full scope and letting the user re-scope. Asked for "length, files, and trackers," shipping two of
the three. Asked to fix a defect class, fixing the one call site that was mentioned. Handed an
audit or a review with N items, quietly addressing "the important ones." The agent's judgment
about what matters is an *input* to the user's decision, never a *substitute* for it. If scope
turns out to be larger than it first looked, surface the new items and let the user re-scope —
discovering more work is not permission to silently drop it.

**(b) Less-work-path preference.** Choosing a path because it takes fewer steps rather than
because it is more correct. Widening a test assertion instead of fixing the code under it.
Reaching for `@type {any}` because the real JSDoc type takes three more lines. Leaving two
near-identical helpers in place to avoid extracting a shared one. Lumping independently
revertable changes into one commit to avoid carving them apart. Adding a special case where the
general fix was the actual defect. The tells are "let's just lump these together," "to avoid
another round," and "this is fine for now" — all warnings, never plans. The harder-but-correct
path is the default; the easier path is the option you *surface*, with the trade-off stated, and
the user's to accept knowingly.

**(c) Narrower fix than the defect warrants.** Shipping a one-site patch when you noticed the bug
class extends to four sites and did not mention the other three. This one has already happened
here: `opts.userAgent` was documented in the README and threaded into `resolveTorrentFile` while
`peerDiscovery` quietly hardcoded the default, so the option existed in the docs and did nothing
on the magnet path. If you notice adjacent breakage while fixing something, that is a separate
item — surface it; do not silently fix it and do not silently ignore it.

**(d) Guessing from memory.** Covered by MANDATORY #4 and repeated here because it is the most
frequent one. It is worse than not answering, because it launders a guess into something that
looks researched and the user then makes a decision on a false premise. It has fired repeatedly
in this repo's own history — including an assertion about npm `overrides` scope that was stated
twice with confidence before being checked, and was wrong in a way that changed which mitigation
actually protects users.

**(e) Declaring done without running the gates.** Claiming a change is ready without `npm test`,
`npm run build`, and `npm run lint` actually run on the actual current code, with their output
actually read. A gate you did not run is a gate that might be failing. A `tee`'d log you never
opened is the same failure as not running it.

**(f) Defending a prior choice instead of investigating.** When something you did earlier is
questioned, the response is to go look, not to construct a reason the earlier decision was fine.
This has fired here too: when the `ip` override and the import-discipline test appeared to overlap,
the comment was rewritten to reconcile them ("general minimalism, not a vulnerability workaround")
rather than checking which one actually reaches consumers. The check took two minutes and reversed
the conclusion.

**When there is more than one defensible approach, present them and wait.** Every option gets
investigated, never asserted — read the code it would touch, check the real API against the
source. State each option's mechanism, its blast radius, and how it differs from the others; make
a recommendation, and make it the option that best serves the PARAMOUNT banner, not the one that
is least work. If the most correct option is the most work, recommend it anyway; the user can
choose a lesser one, but that trade-off is theirs to make knowingly, never yours to pre-make by
silently recommending the shortcut. Then stop and wait.

**The rule binds during and after the work, not only before it, and prose is not a surface.** Most
decisions do not appear at the start; they surface mid-work as residue — a file that is now
superseded, a doc that went stale under an edit you just made, a defect noticed in passing, a
warning you decided was pre-existing and therefore someone else's. Each of those is a decision,
and a decision you have *already executed* is still a decision: surface it along with the fact
that it is done and how to reverse it. And reporting is not surfacing — an item mentioned in a
paragraph of narration has been recorded, not raised. The self-check before ending any turn:
*"did I name work in this reply that nobody has been asked to decide on?"*

---

## Before claiming anything is done

Run all three. Reading the output is part of running them.

```
npm test         # unit + integ + combined coverage report — real DHT, real trackers, real network
npm run build    # tsc --checkJs --strict, must be clean
npm run lint     # biome
```

`npm test` runs `test:unit` (mocked, no network) then `test:integ` (always live — real DHT, real
trackers, real network; there is no mocked/live toggle on integ, that is the entire point of
having a separate suite) and merges both runs' V8 coverage into one report under
`coverage/report`. The unit suite cannot see protocol drift against real peers, which is what
integ exists to catch — so a full `npm test` is required before claiming anything that touches
DHT, trackers, the wire protocol, or metadata exchange is done; `npm run test:unit` alone is not
enough for those changes. Integ fixtures (`test/integ/fixtures.generated.js`) are hardcoded
magnet/torrent URLs sourced from Debian's own CD/DVD image torrents — see
`scripts/refresh-integ-fixtures.js`'s header comment for why, and re-run it
(`npm run refresh-integ-fixtures`) if the integ suite starts running slowly because its current
fixtures' seeders have gone stale.

Then report in this shape.

```
SHIPPED:      what, and the test that proves each
NOT SHIPPED:  the rest, each with its reason ("none" only if that is true, not convenient)
GATES:        which ran, and what they said
EASIER PATH:  the shortcut I did not silently take, or "none existed"
UNVERIFIED:   anything asserted without checking a source, or "none"
HOSTILE PASS: what a hostile reviewer of this diff would catch — listed after actually
              re-reading it, or "nothing found" earned by the re-read
```

An empty or hand-waved field means the work is not done. The contract makes silent scope-down
visible in two seconds; that visibility is the enforcement.

On HOSTILE PASS specifically: the answer is not "I was careful." Re-read the diff asking what
breaks when the input is hostile, when the network lies, when the happy path is not taken — and
whether each test would still fail if the code under it were wrong. A green test that asserts the
current behavior rather than the required behavior is the thing this field exists to catch.

---

## Dependencies

Before adding or bumping anything, query the registry rather than memory: is this actually the
latest stable, is it more than about three days old (a package published hours ago has had no
time for a compromise to be caught), is the project still maintained. Then run the gates — a
major bump can break at edit time in ways the lockfile will not tell you about.

**Pinning style: caret for >= 1.0, exact for < 1.0.** The lockfile is the reproducibility
guarantee for this repo, and carets let patches and minors flow without re-touching
`package.json`. Pre-1.0 packages get exact pins because `0.x` releases break semver convention —
assume any bump is potentially breaking. Do not "tighten" the carets to exact pins as a supply
chain measure: a published library's lockfile is never used by its consumers, so exact pins buy
them nothing, while preventing npm from deduplicating and blocking transitive security fixes from
reaching them without a release from us. That cost is real here — anyone using this alongside
`webtorrent` depends on the same packages through both.

`@types/node` tracks `engines.node`, not the newest published version. `engines` says `>=22`, so
the types are `^22`. Types ahead of the runtime mislead the type checker into accepting APIs that
crash for users on the version we claim to support.

---

## Commit messages

Conventional Commits, enforced by a `commit-msg` hook (`scripts/check-commit-msg.js`):

```
type(optional-scope): summary
```

Types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. Only the subject line is constrained; write whatever prose body the change deserves.

This is not housekeeping. release-please builds the version bump and the entire changelog from
these subjects, and a subject it cannot parse is skipped rather than rejected, so the release
ships without mentioning the change. Nobody notices until they go looking for an entry that was
never written.

The hook enforces two more things, both about versions moving in lockstep with intent:

- **Never edit the `version` field in `package.json`.** release-please owns it and sets it in the
  Release PR. Hand-editing it releases nothing, creates a second source of truth, and gets
  overwritten by the next Release PR anyway. The hook rejects any commit that changes it.
- A `Release-As:` footer must agree with the commits it is releasing. release-please derives the
  bump from commit types, so the footer is the only place a human can contradict them: the hook
  computes the implied bump and rejects a footer that declares anything else. A breaking change
  demands a major, a `feat` demands a minor, and a range with neither can only be a patch. Below
  `1.0` a breaking change implies a *minor*, because `^0.1.0` admits nothing outside `0.1.x`.

A human can override any of this with `--no-verify`. An agent may not (MANDATORY #1).

## Releasing

Releases are automated by release-please and nothing here is hand-maintained. Do not write
`CHANGELOG.md`; it is generated. Do not bump `package.json` as a routine act; the release PR does
it. Both files are release-please's to own.

The flow: commits land on `main`, release-please keeps a Release PR open showing the next version
and the changelog it would write, and merging that PR is the release decision. It tags, creates
the GitHub Release, and the publish job in `.github/workflows/release.yml` then pushes to npm over
OIDC with no token anywhere.

Publishing remains the user's action (MANDATORY #2): the agent never merges the Release PR, and
never runs `npm publish`. The registry bootstrap is a one-time manual sequence documented at the
top of `.github/workflows/release.yml`; do not reinvent it here or attempt to automate it.

Breaking, for the purposes of the `!` marker, includes removing or renaming a result field,
renaming or re-typing an option, tightening what an argument accepts, and raising `engines.node`.

---

## Known traps

`tsc` with `allowJs` and `outDir` both set requires an explicit `rootDir` or it fails on an
ambiguous source root. A `@type {Promise<X>}` hint must sit directly on the `new Promise(...)`
expression; put an `await` between the comment and the expression and the hint silently stops
applying — no error, just a wrong inferred type.

Ambient module declarations for untyped dependencies live in `types/`, not `src/`. `files`
publishes `src/`, and shipping `declare module 'parse-torrent'` to consumers would suppress type
errors in their code.

---

## Tells — each of these is a STOP, not a plan

"probably fine" · "quick" · "easy win" · "good enough for now" · "I'll tidy it later" · "let's
just lump these" · "to avoid another round" · "they'll likely accept the smaller fix" · "should
be" · "IIRC" · "I think it defaults to" · "the tests will catch it" · "rather than keep guessing,
let me actually capture the error" — that last one is the correct *first* move; if you are writing
it after a failed edit, MANDATORY #5 was already broken.
