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

/** True only when this admin runs a real vendored release that can name itself. */
export const canStampRendererFloor = () => !fromSource() && !!BUILD?.version;

/** The renderer version to stamp, or null when this build has no business stamping one. */
export const rendererFloor = () => (canStampRendererFloor() ? BUILD.version : null);

/* ⚠️ TWO WAYS TO BE UNABLE TO STAMP, AND THE SECOND WAS A HOLE UNTIL IT WAS MEASURED. Running from
   source is the obvious one. The other is a vendored core OLDER than 0.1.675, which exports no
   `BUILD` at all — the first cut returned `canStamp: true` with a null floor, so a dialog would
   have believed it could stamp and then written nothing. Both are "no", for different reasons, and
   the dialog shows which. */
export const stampBlockedReason = () => {
  if (fromSource()) {
    return `This admin is running spattoo-core from SOURCE (../spattoo-core/src), not the vendored `
      + `release. The designer reports ${BUILD?.version ?? 'an unknown version'}, which is the last `
      + `release rather than the code on screen — stamping it would record a version that never `
      + `rendered this template. Catalogue from deployed admin instead.`;
  }
  if (!BUILD?.version) {
    return `The vendored spattoo-core is older than 0.1.675 and cannot name its own version, so `
      + `there is nothing truthful to stamp. Release core and re-vendor, then catalogue.`;
  }
  return null;
};
