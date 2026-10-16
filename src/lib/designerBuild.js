/* ⚠️ A NAMESPACE IMPORT, NOT `import { BUILD }`. A named import of an export that does not exist
   is a hard build error, and `BUILD` only arrives in core 0.1.675 — so a named import would mean
   this file could not be consumed until a release carrying it had been vendored, and would break
   any rollback to an older tarball. A namespace read is just `undefined`, which the `?.` below
   already handles: an admin on a pre-0.1.675 core simply cannot stamp, which is the correct and
   safe answer rather than a build failure. */
import * as designer from '@spattoo/designer';
const BUILD = designer.BUILD;
const fromSource = () =>
  typeof __CORE_FROM_SOURCE__ === 'undefined' ? false : !!__CORE_FROM_SOURCE__;

/* ── What renderer build is this admin actually running? ─────────────────────────────────────────
 *
 * THE one answer, because a catalogued template is stamped with it and a wrong stamp is worse than
 * none: everything downstream — the import gate, and later the app gate — believes the number
 * without being able to check it.
 *
 * Two facts, from two places, and neither can supply the other:
 *
 *   · `BUILD.version` comes from core, written into buildId.js by `npm version`. For a vendored
 *     tarball it is exact.
 *   · `__CORE_FROM_SOURCE__` comes from vite.config.js, off the same `existsSync` that decides
 *     whether to alias the designer to core's src. When that alias is live, admin is running
 *     UNCOMMITTED working-tree code while `BUILD.version` still names the last release — so the
 *     version is a floor, not a fact, and must not be stamped on anything.
 *
 * Core cannot determine the second on its own: pack-vendor.mjs requires the tarball's src/ to be
 * byte-identical to `git archive HEAD src`, so nothing injected at pack time survives the guard,
 * and a committed flag cannot distinguish a tarball from a working tree sitting on the same commit
 * and then moving past it. The knowledge lives here or nowhere.
 *
 * spattoo-docs/plans/renderer-version-floor.md
 */

/* ── The floor is the DESIGNER's version, not a judgement about this admin ───────────────────────
 *
 * ⚠️ THIS NEVER BLOCKS, AND IT USED TO. The first cut refused to stamp whenever admin aliased the
 * designer to core's working tree, on the reasoning that `BUILD.version` then names the last
 * release rather than the code on screen. The reasoning is sound and the rule was still wrong:
 * admin is internal and runs on localhost nearly all the time, so the "unsafe" branch was the
 * ordinary one and cataloguing was blocked outright. Sandeep: *"admin mostly runs on localhost
 * since i am the only developer. this should only be a warning. cannot block me to do the action.
 * it should not be based on what admin is running — it should be on what designer vendored
 * version."*
 *
 * So the number stamped is simply what the designer reports. That IS the vendored release, and it
 * is the right floor: a template composed against working-tree code still cannot need a renderer
 * OLDER than the last release, so the stamp is a true lower bound either way. What running from
 * source costs is the ceiling — the template may need the NEXT release — and that is a caveat to
 * show, not a door to lock. The admin can always raise the number by hand.
 */

/** True when the designer can name its own version at all (core 0.1.675+). */
export const canStampRendererFloor = () => !!BUILD?.version;

/** True when admin is aliased to core's working tree rather than a vendored tarball. */
export const runningFromSource = () => fromSource();

/** The renderer version to stamp — whatever the designer reports, or null if it cannot say. */
export const rendererFloor = () => BUILD?.version ?? null;

/* ⚠️ A WARNING, NOT A BLOCK — the name changed with the behaviour so a caller cannot keep the old
   meaning by keeping the old word. Both branches are things worth reading before cataloguing and
   neither is a reason to refuse. */
export const stampWarning = () => {
  if (fromSource()) {
    return `This admin runs spattoo-core from SOURCE (../spattoo-core/src). ${BUILD?.version ?? 'The version shown'} `
      + `is the last RELEASE, so it is a true floor but possibly a low one: if this design uses `
      + `anything added since, raise it by hand or re-stamp after the next release.`;
  }
  if (!BUILD?.version) {
    return `The vendored spattoo-core is older than 0.1.675 and cannot name its own version, so `
      + `nothing is stamped automatically. Leave this empty for "renders anywhere", or type the `
      + `version you know it needs.`;
  }
  return null;
};
