import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
/* CORE'S OWN BLOB, CORE'S OWN CREAM. `buildPipingHeap` is the function the cream pen already calls
 * on every tap, and `mediumOf(...).material(...)` is the exact material it dresses one in. Nothing
 * here is a prototype copy: the older studios in this folder each carry their own version of a
 * geometry with a note promising it "ports to spattoo-core verbatim", and PipingCalibrator mirrors
 * CakeTier's maths under three separate "MUST stay identical" warnings — a promise a comment cannot
 * keep (INVARIANTS #15). A pattern is N of core's blobs, never a second renderer. */
import {
  buildPipingHeap, NOZZLES, NOZZLE_BY_KEY, DEFAULT_NOZZLE, mediumOf, SizeDial,
  finishToMaterial,
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
} from '@spattoo/designer';
import { fetchElementTypes, fetchAdminElementCategories, uploadThumbnail, createGlobalElement }
  from '../lib/api.js';

/* ── A cream pattern, composed by hand — PROOF OF CONCEPT ────────────────────────────────────────
 *
 * Sandeep, on the unicorn mane: *"the piping includes multiple nozzles and a lot of overlap.
 * currently we dont have a mechanism to overlap like or create a pattern with multiple nozzle
 * pipings."* Then on how it gets built: *"create a patten - adding by clicks, and adding by just
 * projecting / drawing a line so that piping continues. all these we need to prove first."*
 *
 * ADMIN, AND DELIBERATELY NOT SAVING. *"right now admin authored. this is as proof of concept…
 * saving the pattern is not admin's concern, we can do that while wiring this to core."* So this
 * screen proves the COMPOSING and stops there — no element row, no parts JSON, no publish.
 *
 * ⚠️ FOUR THINGS IT HAS TO PROVE, and each is visible on screen:
 *   1. CLICK places one blob where you clicked, seated on the surface it hit.
 *   2. DRAG lays a run of them along the line, the piping continuing as the hand moves.
 *   3. The tip and the colour can CHANGE between strokes, so one pattern mixes nozzles — the thing
 *      the reference photograph is full of and the designer cannot express today.
 *   4. They OVERLAP on purpose, and cream into cream still reads as cream.
 *
 * ⚠️ TOP AND SIDE COME FREE, and that is the point of seating off the RAYCAST rather than off a
 * (theta, y) dial. The hit gives a point and a face normal wherever it lands, so the wall, the top
 * and the shoulder between them all work without a branch — and a run drawn diagonally across the
 * two IS the "cross" from the reference. Nothing here knows about zones.
 *
 * ── WHEN THIS IS WIRED INTO CORE ────────────────────────────────────────────────────────────────
 *
 * Sandeep, while this was still a studio: *"when a baker saves a pattern, and loads that pattern on
 * another cake, pattern should have its own popup card. if i make the card with pipings with few
 * colors, i should be able to change the colors later. we will start with colors changing, then see
 * what other props need adjustment controls."*
 *
 * ⚠️ THE CARD ALREADY EXISTS — do not build a second one. A placed `decor_pattern` is selected as
 * ONE entity (`selectExclusive({ type: 'pattern', patternId, patternElementId })`) and rendered by
 * `renderPatternBody` (CakeDesigner.jsx:8066, mounted at :14006). Tapping any part opens that card;
 * the parts stay individually draggable. What the card carries TODAY is a surface chooser and
 * "Remove from cake" — and no colour control whatsoever. So the gap is not the card, it is what is
 * on it.
 *
 * ⚠️ AND RECOLOURING A PLACED GROUP ALREADY EXISTS, TWICE, IN ONE SHAPE. `clusterPaletteOf` /
 * `setClusterPalette` (:6393) and `scatterPaletteOf` / `setScatterPalette` (:6572) both DERIVE the
 * palette by walking the placed pieces and collecting distinct colours, then write back by cycling
 * that palette across them in id order. Deriving rather than storing is the whole trick: a stored
 * palette and the cake can disagree, and the cake is the truth — which is also why an old design
 * with three hand-picked colours reads back correctly with nothing migrated. A pattern's palette is
 * the same question asked of `patternId` instead of `clusterId` or `elementId`. A THIRD copy of this
 * rule would be the defect; the honest move is one helper the three share.
 *
 * ⚠️ COLOURS FIRST, BY HIS OWN SEQUENCING — then whatever else earns a control. The likely next
 * ones, in the order the studio suggests they matter: overall SIZE (one dial scaling every piece,
 * like the group card's proportional resize), the PRESS into the surface, and per-piece TIP swaps.
 * None of those should be guessed at now; the studio is where they get judged.
 *
 * ⚠️ ONE THING THE SAVED SHAPE MUST CARRY FOR ANY OF IT TO WORK. A pattern part today is
 * `{ element_id, dx, dz, mirror }`. Composed piping needs the piece's own normal (which way it grew
 * — see the stacking note below), its tip, its size and whether it was seated on the cake or on
 * other cream. Colour is per piece and already storable; the rest is not. Decide that shape before
 * the first pattern is saved, because every saved pattern afterwards has to keep reading.
 *
 * ⚠️ WHAT IS BORROWED, AND WHAT IS NEW. The walk along a drawn line is the pen's own rule, read off
 * `stampTransforms`: cumulative arc length, a copy every `spacing × 2 × thickness`, the forward
 * direction taken from the segment. Matching it matters — a second spacing convention would mean a
 * pattern composed here and a border piped in the designer disagree about what "0.85" means.
 * What is NOT reusable: `stampTransforms` places GLB clones and carries ONE normal for a whole
 * stroke, which is wrong on a curved wall, and `CreamPen` is not exported so a studio cannot mount
 * it. So the capture is here, per-sample normals and all. When this graduates to core, THAT is the
 * piece to move — a heap run along a path — not another copy of the pen.
 */

/* The designer's own bottom tier, so everything is judged at the scale a customer sees — the same
   numbers TopEdgeStudio and ChocolateDripStudio use. */
const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;
const TOP_Y = BOARD_H + BOTTOM_H;

/* ── Seating a blob ──────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ A HEAP IS NOT LIFTED, AND THAT WAS MY FIRST BUG HERE. `CreamPen`'s `seatAt` lifts its hit point
 * along the normal by the rope radius, and that is RIGHT for a stroke: a rope is a tube whose
 * CENTRELINE must sit one radius above the surface for its skin to touch. A heap is not a tube lying
 * down, it is a cone standing up, swept FROM the base point ALONG the normal — so the same lift
 * pushes the whole blob off the cake. Measured on the real geometry at thickness 0.11: lifted, the
 * nearest face sits 0.0275 clear of the wall and the blob floats; unlifted, the base buries 0.0825
 * into it, which is what piped cream does when it is squeezed against a surface. Floating is why the
 * first render had no contact shading and read as pasted on.
 *
 * ⚠️ AND THE SAME LIFT IS ON SHIPPED CAKES. `CreamPen.jsx:210` stores a tapped heap at `pts[0]`,
 * which came from `seatAt` — so every heap a baker has tapped floats by the same margin. Not fixed
 * here: that moves cream already placed on saved cakes, and it is Sandeep's call.
 */
/* ⚠️ `bury` DEFAULTS, AND THAT GUARD IS NOT DECORATION. It was missing from the stored record while
 * `Blob` destructured it, so this did `addScaledVector(normal, -undefined)` — NaN. Measured on the
 * real geometry: the base point came out `NaN, NaN, NaN` and all 31,110 position components with it,
 * so every piece was built, added to the list and rendered as absolutely nothing. The pattern was
 * filling up behind an empty cake. NaN travels silently through vector maths and only shows up as an
 * invisible mesh, which is the worst kind of failure to debug from a screenshot. */
function seat(point, normal, bury = 0) {
  const b = Number.isFinite(bury) ? bury : 0;
  return new THREE.Vector3().copy(point).addScaledVector(normal, -b);
}

/* ── WHAT A PIECE CAN BE ─────────────────────────────────────────────────────────────────────────
 *
 * Sandeep: *"sometimes we add sprikles or other decorations on the piping… lets add pearls as pieces
 * in the studio."*
 *
 * ⚠️ A TABLE KEYED BY `kind`, NEVER A BRANCH ON A NAME (INVARIANTS #1). This is the same shape
 * core's own `MEDIA` uses for cream-vs-chocolate: the piece carries a key, the table answers what
 * that key means, and a third kind — a sugar flower, a leaf, a GLB stamp from the catalogue — is a
 * ROW here rather than an edit to the composer. That matters more than it looks: the whole direction
 * settled with Sandeep is GLB-first with procedural alongside, and `kind` is the seam both arrive
 * through. A composer written with `if (pearl)` in it would have to be reopened for every one.
 *
 * ⚠️ A PEARL IS A SPHERE, and that is not laziness — it is what a pearl is. There is no shared
 * "pearl builder" to reuse: the ball cluster packs GLB spheres from the catalogue, and
 * `fondantParts.js` has a `ball` entry but it belongs to the fondant-modelling table, not to
 * decorations. So the geometry is generated here and the FINISH is imported, because that half does
 * have one home: `finishToMaterial` is the metallic↔matte curve the cluster's own Finish control
 * writes, so a pearl in a pattern and a pearl in a cluster catch the light identically.
 *
 * ⚠️ BOTH KINDS SEAT THROUGH THE SAME RAYCAST. A pearl lands on cream or on cake depending only on
 * what the ray struck — which is the whole of "sometimes we add sprinkles on the piping". Nothing in
 * the seating code knows a pearl from a rosette.
 */
const PIECE_KINDS = {
  nozzle: {
    label: 'Rosette',
    hint: 'piped cream, from a tip',
    build: ({ point, normal, nozzle, thickness, heapHeight, bury }) => {
      const p = seat(new THREE.Vector3().fromArray(point), new THREE.Vector3().fromArray(normal), bury);
      return buildPipingHeap(p, new THREE.Vector3().fromArray(normal), nozzle, thickness, heapHeight);
    },
    /* Cream, from core's medium table — the identical curve the cake shades its piping with. */
    material: ({ colour, softness }) => ({
      side: THREE.DoubleSide,
      ...mediumOf('cream').material({ softness }, colour),
    }),
  },
  pearl: {
    label: 'Pearl',
    hint: 'a hard ball tucked between',
    /* ⚠️ SEATED BY ITS CENTRE, not its base. A heap grows FROM its seat ALONG the normal; a sphere
       sits half-buried in whatever it was pressed into, which is what a real dragee does — so the
       centre goes one radius out and `bury` then presses it back in. Getting this wrong is the
       floating-heap bug again in a different shape. */
    build: ({ point, normal, thickness, bury }) => {
      const n = new THREE.Vector3().fromArray(normal);
      const c = new THREE.Vector3().fromArray(point).addScaledVector(n, thickness - bury);
      return new THREE.SphereGeometry(thickness, 24, 18).translate(c.x, c.y, c.z);
    },
    material: ({ colour, finish }) => ({
      color: colour,
      ...finishToMaterial(finish ?? 0),
    }),
  },
};

function Blob(piece) {
  const { point, normal, kind = 'nozzle', strokeId } = piece;
  const spec = PIECE_KINDS[kind] ?? PIECE_KINDS.nozzle;
  const geo = useMemo(() => spec.build(piece),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, point, normal, piece.nozzle, piece.thickness, piece.heapHeight, piece.bury]);
  useEffect(() => () => geo?.dispose(), [geo]);
  if (!geo) return null;
  /* ⚠️ `strokeId` RIDES ON THE MESH so the hit handler can tell a piece from THIS stroke apart from
     one already finished. Without it a drag stacks on its own tail — the piece placed a moment ago
     is still under the moving pointer — and a straight run climbs into a spiral. */
  /* ⚠️ THE PIECE'S OWN GROWTH DIRECTION RIDES ALONG TOO. A rosette's FACE normals swing right round
   * between crests and creases, so a piece seated on the face it happened to strike grows off
   * sideways — which is what the green ones did: scattered, leaning, and reading as smooth leaves,
   * because a heap seen along its flank has no ribs to show. What a baker actually does is pipe the
   * next one in the same direction as the pile, so the piece below has to be able to say which way
   * it grew.
   *
   * ⚠️ AND THIS COMMENT LIVES ABOVE THE RETURN, IN PLAIN JS, FOR A REASON I HAVE NOW LEARNED TWICE
   * IN ONE FILE. A brace-wrapped JSX comment is only valid where JSX CHILDREN are expected; placed
   * directly after `return (` it makes two top-level expressions and the build dies with
   * "Expected )". The surface-tile fix earlier today broke exactly the same way, and a parse check
   * is what caught both — nothing about it is visible by reading the diff. */
  return (
    <mesh geometry={geo} castShadow receiveShadow userData={{ strokeId, grow: normal }}>
      {/* The material comes from the KIND's own entry — cream's sheen curve for a rosette, the
          metallic↔matte pairing for a pearl. Both are core's, neither is hand-rolled here. */}
      <meshPhysicalMaterial {...spec.material(piece)} />
    </mesh>
  );
}

/* The world normal at a hit, whatever was struck — cake or cream. Shared by the cake's handlers and
   the piping group's, so a piece seated on a rosette is seated by the same rule as one on the wall.
   `transformDirection` because a face normal is in the mesh's own space and the cake sits in a
   lifted group; without it a piece on the wall would grow along the wrong axis. */
function hitNormal(e) {
  return e.face
    ? e.face.normal.clone().transformDirection(e.object.matrixWorld).normalize()
    : new THREE.Vector3(0, 1, 0);
}

/* The cake, and the thing the pointer hits. `onPointerDown`/`Move`/`Up` live here rather than on the
   canvas so a drag that wanders off the cake simply stops adding, instead of throwing blobs at the
   sky — the same reason CreamPen raycasts against tagged catchers and ignores a miss. */
function Cake({ colour, onDown, onMove, onUp, drawing, orbit }) {
  const body = useMemo(
    () => new THREE.CylinderGeometry(R, R, BOTTOM_H, 160).translate(0, BOTTOM_H / 2, 0), []);
  useEffect(() => () => body?.dispose(), [body]);
  const top = useMemo(() => new THREE.CircleGeometry(R, 160).rotateX(-Math.PI / 2), []);
  useEffect(() => () => top?.dispose(), [top]);
  const mat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, metalness: 0 }), [colour]);
  useEffect(() => () => mat?.dispose(), [mat]);

  const hit = (e, fn) => {
    e.stopPropagation();
    /* ⚠️ ORBIT IS TURNED OFF HERE, ON THE PRESS ITSELF, not from React state a render later.
     * OrbitControls listens on the canvas DOM element, so an R3F `stopPropagation` does not reach
     * it — and an `enabled={!drawing}` prop arrives after the gesture has already begun, which is
     * why a drag spun the cake instead of piping on it. The designer solves this the same way
     * (`CakeCanvas`: a capture-phase pointerdown reads the `isPenCatcher` tag and clears
     * `enableRotate` before OrbitControls' bubble listener sees the event); here the press is
     * already on the cake, so the tag is unnecessary and the assignment is the whole of it. */
    if (orbit?.current) orbit.current.enableRotate = false;
    fn(e.point.clone(), hitNormal(e));
  };

  return (
    <group position={[0, BOARD_H, 0]}>
      <mesh geometry={body} material={mat} castShadow receiveShadow
        onPointerDown={e => hit(e, onDown)}
        onPointerMove={e => drawing && hit(e, onMove)}
        onPointerUp={onUp} />
      <mesh geometry={top} material={mat} position={[0, BOTTOM_H, 0]} castShadow receiveShadow
        onPointerDown={e => hit(e, onDown)}
        onPointerMove={e => drawing && hit(e, onMove)}
        onPointerUp={onUp} />
    </group>
  );
}

function Swatch({ value, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, cursor: 'pointer' }}>
      <input type="color" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: 34, height: 34, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 8, cursor: 'pointer' }} />
      <span style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>{label}</span>
    </label>
  );
}

/* ── PICKING A TIP: THUMBNAILS, NOT A DROPDOWN ───────────────────────────────────────────────────
 *
 * Sandeep: *"in the studio, we should not have a dropdown (like in admin) for piping selection. it
 * should be the thumbnails."*
 *
 * ⚠️ AND A NOZZLE ALREADY KNOWS HOW TO DRAW ITSELF. Every tip in `NOZZLES` carries the 2D
 * cross-section the sweep is built from — `[x, y]` pairs on roughly a unit circle — which is
 * literally the shape of the opening you pipe through, and how a tip is pictured on the packet. So a
 * thumbnail is that array as an SVG polygon: no render, no canvas, no asset, nothing to generate or
 * cache. Nineteen of them cost nineteen `<polygon>` elements.
 *
 * ⚠️ ONE FIXED viewBox, NOT EACH SCALED TO FILL ITS BOX, and that is the whole argument for
 * thumbnails over a dropdown. The wall tips are SQUASHED — `rose12w` measures x ±0.55 against y ±1.0
 * where `star5` is x ±1.0 — because they are pressed against a side rather than standing off a top.
 * Normalising each to fill would hide exactly the difference a baker is choosing between, and the
 * dropdown hid it behind a word. At a common scale the squashed ones look squashed.
 *
 * ⚠️ FILLED IN THE COLOUR ON THE NOZZLE, so the grid previews what the next click will lay down
 * rather than showing nineteen grey shapes.
 */
function TipThumbs({ value, onChange, colour }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))',
                  gap: 6, marginBottom: 10 }}>
      {NOZZLES.map(n => {
        const active = n.key === value;
        /* SVG's y runs DOWN and the profile's runs up, so y is negated — without it every
           asymmetric tip is drawn mirrored, which on a lobed star is invisible and on a squashed
           wall tip is a lie about which way it spreads. */
        const pts = n.profile.map(([x, y]) => `${x.toFixed(3)},${(-y).toFixed(3)}`).join(' ');
        return (
          <button key={n.key} type="button" onClick={() => onChange(n.key)} aria-pressed={active}
            title={`${n.label} — ${n.hint}`}
            style={{ padding: 4, borderRadius: 9, cursor: 'pointer', lineHeight: 0,
                     border: `1.5px solid ${active ? '#2C4433' : '#D8D3CA'}`,
                     background: active ? '#EEF2EF' : '#fff' }}>
            <svg viewBox="-1.12 -1.12 2.24 2.24" style={{ width: '100%', aspectRatio: '1 / 1', display: 'block' }}>
              <polygon points={pts} fill={colour} stroke="#00000022" strokeWidth={0.03} />
            </svg>
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ on, onChange, label, hint }) {
  return (
    <button type="button" onClick={() => onChange(!on)} aria-pressed={on}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
               padding: '10px 12px', marginBottom: 10, borderRadius: 10, minHeight: 44,
               cursor: 'pointer', fontFamily: 'inherit',
               border: `1.5px solid ${on ? '#2C4433' : '#D8D3CA'}`,
               background: on ? '#2C4433' : '#fff' }}>
      <span style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                     border: `1.5px solid ${on ? '#fff' : '#B9B3A8'}`,
                     background: on ? '#fff' : 'transparent' }} />
      <span>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: on ? '#fff' : '#2C4433' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 10.5, color: on ? '#C9D6CE' : '#8a8a8a' }}>{hint}</span>
      </span>
    </button>
  );
}

export default function ManeStudio() {
  /* What is on the nozzle RIGHT NOW. Every blob records the tip, colour and size it was piped with,
     so changing these mid-pattern is how one pattern comes to hold several nozzles. */
  /* Which kind of piece the next click or drag lays down. A pattern holds a mix — that is the point
     — so this is "what is in my hand now", exactly like the tip and the colour beside it. */
  const [kind, setKind] = useState('nozzle');
  const [tip, setTip] = useState(NOZZLE_BY_KEY.rose8w ? 'rose8w' : DEFAULT_NOZZLE);
  const [thickness, setThickness] = useState(0.09);
  /* A pearl's own size and finish. SEPARATE from the rosette's, because a pearl tucked between
     rosettes is a fraction of their size and switching kinds should not make you re-dial it every
     time. 0 is the metallic end of core's own scale — a gold dragee, the reference photograph's. */
  const [pearlSize, setPearlSize] = useState(0.028);
  const [pearlFinish, setPearlFinish] = useState(0);
  const [pearlColour, setPearlColour] = useState('#D9B44A');
  const [heapHeight, setHeapHeight] = useState(0.9);   // HEAP_HEIGHT_PER_DIAMETER
  const [softness, setSoftness] = useState(0.7);       // the cream medium's own default
  const [colour, setColour] = useState('#E85A9B');
  const [bury, setBury] = useState(0);
  /* ⚠️ THE PEN'S OWN NUMBER AND THE PEN'S OWN MEANING. `stampTransforms` steps by
     `spacing × 2 × thickness` and the pen card offers 0.5…1.6 with 0.85 default — "0.55 is shells
     crowding each other, 1.4 a dotted run". Below 1 the copies overlap, which is the mane. A second
     convention here would make the same number mean two things in one product. */
  const [spacing, setSpacing] = useState(0.62);
  const [tierColour, setTierColour] = useState('#F4EFE9');
  const [raking, setRaking] = useState(true);

  /* Every blob ever placed: { point[3], normal[3], nozzle, thickness, heapHeight, colour, softness,
     strokeId }. Flat rather than grouped by stroke, because undo works in strokes and the renderer
     wants a list — `strokeId` gives both. */
  const [blobs, setBlobs] = useState([]);
  const [drawing, setDrawing] = useState(false);
  /* Which way a piece grows when it lands ON cream rather than on the cake.
     `pile`    — the direction the piece underneath grew. Stacked rosettes face the same way, which
                 is what a hand does and what the reference photograph shows.
     `surface` — the true face normal of whatever rib was struck. Truthful to the geometry and, in
                 practice, scattered: this is what put the green pieces in at wild angles.
     A toggle rather than my pick, because the first version WAS my pick and it was wrong. */
  const [stackAlong, setStackAlong] = useState('pile');
  /* The live OrbitControls instance, so a press can kill rotate before the controls' own DOM
     listener acts on it. `makeDefault` publishes it; a ref is how the designer reaches it too. */
  const orbit = useRef(null);

  /* ── Saving the row that puts the studio in Decorations ──────────────────────────────────────
   *
   * Sandeep: *"keep save to db button in the admin studio. take the screenshot of the piping from
   * there."*
   *
   * ⚠️ THE ROW IS THE DOOR. The designer reaches a studio through
   * `PROCEDURAL_TOOLS[placement_config.procedural]`, so `cream_pattern` in core is only the handler
   * — without an elements row carrying that key there is nothing in Decorations to tap. Add Element
   * can author one, but its tile would then be a stock picture; this button bakes the tile from real
   * piped cream, which is the point of doing it from here.
   *
   * ⚠️ AND THE KEY IS TYPED NOWHERE. It is a constant, because a mistyped generator key produces an
   * element that sits in the picker and does nothing when tapped — Add Element's own warning. */
  const PROCEDURAL_KEY = 'cream_pattern';
  const shotRef = useRef(null);
  const [types, setTypes] = useState([]);
  const [cats, setCats] = useState([]);
  const [typeId, setTypeId] = useState('');
  const [catId, setCatId] = useState('');
  const [rowName, setRowName] = useState('Cream pattern studio');
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  /* ⚠️ A DELIBERATE THUMBNAIL VIEW, NOT AN AUTOMATED GRAB. `preserveDrawingBuffer` (already set on
     the Canvas) fixes a BLANK capture; it does nothing for an EMPTY-LOOKING one, and CloudStudio
     records why that distinction matters — "those pixels differ, they just all differ by nothing
     anybody can see". A 60px tile of a whole cake with a small run of cream on it is unreadable, and
     white cream on a pale cake is unreadable at any size. So this frames the PIPING, and you look at
     it before saving: what is on screen is exactly what gets stored. */
  const [thumbView, setThumbView] = useState(false);

  /* ── Where the thumbnail camera goes ─────────────────────────────────────────────────────────
   *
   * ⚠️ DERIVED FROM THE PIECES, NOT A FIXED POSITION. A run can be anywhere on a wall 1.2 in radius
   * and 1.45 tall, so any hardcoded eye would frame whatever I happened to pipe while writing this
   * and miss everything else. Centroid for where to look, the spread of the points for how far back
   * to stand — the same shape CloudStudio's `shot` memo has, and for the same reason: the tile is a
   * picture of the DECORATION, not of a cake with something small on it.
   *
   * ⚠️ PULLED BACK BY THE SPREAD, WITH A FLOOR. At fov 34 the frame covers `2·d·tan(17°)` ≈ 0.61·d,
   * so d ≈ span/0.61 fits the run edge to edge; ×1.5 leaves margin, and the 0.55 floor stops a
   * SINGLE piece — span 0 — putting the camera inside the cream.
   *
   * ⚠️ OFF THE WALL'S OWN NORMAL, so a run on the side is seen face-on rather than edge-on. The
   * centroid's x/z direction IS that normal on a cylinder, which is the one thing a flat plate
   * would not have given us.
   */
  const shot = useMemo(() => {
    if (!blobs.length) return { centre: [0, BOARD_H + BOTTOM_H * 0.55, 0], eye: [0, TOP_Y * 0.62, 3.6] };
    const pts = blobs.map(b => b.point);
    const c = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map(v => v / pts.length);
    const span = Math.max(
      ...pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])), 0.001) * 2;
    /* ⚠️ THE FLOOR IS ON THE FRAME, NOT ON THE DISTANCE, and flooring the distance was wrong in a
       way the arithmetic showed straight away. `dist = max(0.55, …)` held the camera 0.55 back for
       anything small, and at fov 34 that frames only 0.34 world units — NARROWER than a 0.20 run, so
       a short one came out cropped, and a single piece sat in a frame barely wider than itself.
       Flooring the SPAN keeps the 1.5x margin at every size: a lone piece gets a 0.25-wide subject
       in a 0.61 frame, and a long run is unchanged. */
    const dist = (Math.max(span, 0.25) / 0.611) * 1.5;
    const radial = Math.hypot(c[0], c[2]) || 1e-6;
    const nx = c[0] / radial, nz = c[2] / radial;      // outward normal at the centroid
    return { centre: c, eye: [c[0] + nx * dist, c[1] + dist * 0.25, c[2] + nz * dist] };
  }, [blobs]);

  useEffect(() => { fetchElementTypes().then(setTypes).catch(() => setTypes([])); }, []);
  useEffect(() => { fetchAdminElementCategories().then(setCats).catch(() => setCats([])); }, []);
  /* ⚠️ NEVER `cream_piping`, AND I PICKED IT FIRST BECAUSE IT SOUNDED RIGHT.
   *
   * A row typed `cream_piping` NEVER REACHES `PROCEDURAL_TOOLS`. The decorations grid filters that
   * slug out along with `piping_pattern` and `drip` (CakeDesigner: the `et.slug !== 'cream_piping'`
   * filter), because those rows are collected into `creamPipingEls` and opened as a PIPING RING
   * CARD instead — zone tiles, COLOR / SIZE / RADIAL. So `tapPlaceElement` is never called, the
   * `procedural` key on the row is never read, and the studio never opens. Sandeep saw exactly that:
   * a "Cream pattern studio" card showing a BOARD tile and three ring dials.
   *
   * It looked like the obvious home for a piping studio. What decides the type is not what the
   * element is ABOUT, it is which routing that type puts the row through — the same trap as picking
   * a doc by its title. Every working studio row proves the point: card_topper and rainbow are
   * `topper`, chocolate_garnish is `scattered_decor`, and the harness fixture that opened this very
   * studio correctly is `topper`.
   *
   * Picked from the list rather than hardcoded so a renamed or re-minted type does not file it
   * somewhere odd, and it falls back to the first type that is NOT one of the three the grid drops.
   */
  useEffect(() => {
    if (!typeId && types.length) {
      const routable = types.filter(t => !['cream_piping', 'piping_pattern', 'drip'].includes(t.slug));
      setTypeId(routable.find(t => t.slug === 'topper')?.id ?? routable[0]?.id ?? '');
    }
  }, [types, typeId]);

  async function saveRow() {
    if (!rowName.trim()) return setMsg({ ok: false, text: 'Name it first.' });
    if (!typeId)         return setMsg({ ok: false, text: 'Pick an element type.' });
    if (!blobs.length)   return setMsg({ ok: false, text: 'Pipe something — the tile is a picture of real cream.' });
    if (!thumbView)      return setMsg({ ok: false, text: 'Switch to the thumbnail view first, so you can see what gets stored.' });
    setBusy('Saving…'); setMsg(null);
    try {
      /* The same idiom CakeShapeStudio, GenerateShape and GenerateModel use: the canvas lives inside
         a wrapper ref, so reach it rather than holding a second reference to the GL context. */
      const canvas = shotRef.current?.querySelector('canvas');
      if (!canvas) throw new Error('No canvas to capture.');
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('The capture came back empty.');
      const thumbKey = await uploadThumbnail('elements/thumbnails', blob);
      await createGlobalElement({
        name: rowName.trim(),
        description: 'Pipe a block, then repeat it on the cake',
        element_type_id: typeId,
        ...(catId ? { category_id: catId } : {}),
        parent_id: null,
        /* No artwork: the studio IS the element. Nullable in the schema, and the POST guard requires
           only name + element_type_id. */
        image_url: null,
        thumbnail_url: thumbKey,
        file_size: null,
        allowed_zones: ['top_surface', 'side'],
        allowed_actions: { move: true, delete: true, resize: true, color: true },
        placement_config: { procedural: PROCEDURAL_KEY },
      });
      setMsg({ ok: true, text: `Saved. "${rowName.trim()}" now opens the cream pattern studio from Decorations.` });
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Could not save the row.' });
    } finally {
      setBusy(null);
    }
  }

  /* The direction to grow a piece seated on existing cream. `grow` is the underlying piece's own
     stored normal, carried on its mesh — absent on the cake, whose face normal is already the right
     answer, so this falls back to it and the wall keeps behaving exactly as it did. */
  const stackNormal = useCallback((e) => {
    const g = e.object?.userData?.grow;
    if (stackAlong === 'pile' && Array.isArray(g)) return new THREE.Vector3().fromArray(g);
    return hitNormal(e);
  }, [stackAlong]);
  /* The last SEATED sample of the run in progress, and how far past it we have walked. Kept in a ref
     because a pointermove fires far faster than React renders and every sample must be measured
     against the real previous one, not against a stale render's copy. */
  const run = useRef({ id: null, last: null, carry: 0 });

  /* The walk step follows whatever is in hand: a run of pearls is a run of small things, so it steps
     by the PEARL's diameter. Using the rosette's would scatter them a rosette apart. */
  const step = Math.max(spacing * 2 * (kind === 'pearl' ? pearlSize : thickness), 1e-3);

  /* ⚠️ EVERY FIELD THE RENDERER READS IS RECORDED HERE — `bury` included, and leaving it out is what
     blanked the screen. A piece remembers the tip, colour, size AND press it was piped with, which
     is what lets one pattern hold several nozzles; a field the renderer wants but the record omits
     arrives as `undefined` and, in vector maths, as NaN. */
  const addBlob = useCallback((point, normal, strokeId) => {
    setBlobs(prev => [...prev, kind === 'pearl'
      ? { kind, point: point.toArray(), normal: normal.toArray(),
          thickness: pearlSize, colour: pearlColour, finish: pearlFinish, bury, strokeId }
      : { kind, point: point.toArray(), normal: normal.toArray(),
          nozzle: tip, thickness, heapHeight, colour, softness, bury, strokeId }]);
  }, [kind, tip, thickness, heapHeight, colour, softness, bury, pearlSize, pearlColour, pearlFinish]);

  /* CLICK — one blob, exactly where the pointer hit. This is proof 1, and it is also the whole of
     the pen's "tap" behaviour: a press that does not travel is a pipe-and-lift. */
  const onDown = useCallback((point, normal) => {
    const id = crypto.randomUUID();
    run.current = { id, last: point.clone(), carry: 0 };
    setDrawing(true);
    addBlob(point, normal, id);
  }, [addBlob]);

  /* DRAG — proof 2. Walk the path by ARC LENGTH and drop a blob every `step`, carrying the remainder
     between moves so spacing is even across the whole run rather than resetting at each event. The
     normal comes from THIS sample, not from the stroke's first hit, which is what lets a run travel
     round a curved wall or over the shoulder onto the top and stay seated all the way. */
  const onMove = useCallback((point, normal) => {
    const st = run.current;
    if (!st.id || !st.last) return;
    let remaining = point.distanceTo(st.last);
    if (remaining < 1e-6) return;
    const dir = point.clone().sub(st.last).normalize();
    let walked = 0;
    while (st.carry + (remaining - walked) >= step) {
      const advance = step - st.carry;
      walked += advance;
      st.carry = 0;
      addBlob(st.last.clone().addScaledVector(dir, walked), normal, st.id);
    }
    st.carry += remaining - walked;
    st.last = point.clone();
  }, [addBlob, step]);

  /* Rotate comes back on release, so the cake can still be turned between strokes. Bound to the
     WINDOW rather than the mesh: a drag that ends off the cake — over the board, past the
     silhouette — would otherwise never fire a pointerup on the mesh and would leave orbit dead. */
  const onUp = useCallback(() => {
    setDrawing(false);
    run.current = { id: null, last: null, carry: 0 };
    if (orbit.current) orbit.current.enableRotate = true;
  }, []);
  useEffect(() => {
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [onUp]);

  const undoStroke = () => setBlobs(prev => {
    if (!prev.length) return prev;
    const lastId = prev[prev.length - 1].strokeId;
    return prev.filter(b => b.strokeId !== lastId);
  });

  const strokeCount = new Set(blobs.map(b => b.strokeId)).size;
  const tipsUsed = new Set(blobs.map(b => b.nozzle)).size;

  const cap = { fontSize: 11, fontWeight: 800, color: '#6B8C74', letterSpacing: 0.4,
                textTransform: 'uppercase', margin: '18px 0 12px' };
  const row = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 };
  const btn = { padding: '9px 14px', borderRadius: 9, minHeight: 40, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12.5, fontWeight: 800, flex: 1 };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Quicksand, sans-serif',
                  background: '#EDEAE2' }}>
      <div style={{ width: 290, padding: '22px 20px', overflowY: 'auto', background: '#fff',
                    borderRight: '1.5px solid #E8E4DC' }}>
        <h1 style={{ fontSize: 17, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Cream pattern</h1>
        <p style={{ fontSize: 12, color: '#5C7565', margin: '0 0 6px', lineHeight: 1.5 }}>
          Click the cake to place one. Drag to pipe a run. Change the tip or the colour and keep
          going — the pattern holds whatever you piped with. Pipe onto the cream you have already
          placed and it stacks: a piece only touches the cake if that is what you aimed at.
        </p>
        <p style={{ fontSize: 10.5, color: '#b29aa2', lineHeight: 1.5, margin: '0 0 4px' }}>
          Core&rsquo;s own <code>buildPipingHeap</code> and cream material. Nothing is saved yet —
          that belongs with the wiring into the baker&rsquo;s designer.
        </p>

        {/* ⚠️ WHAT IS IN YOUR HAND, chosen before you place. Two buttons rather than a dropdown
            because there are two and both matter — a dropdown hides half the vocabulary behind a
            tap, and the whole point of this row is that a pattern mixes kinds. */}
        <div style={cap}>In hand</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {Object.entries(PIECE_KINDS).map(([k, spec]) => (
            <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
              style={{ ...btn, padding: '9px 10px', textAlign: 'left',
                       border: `1.5px solid ${kind === k ? '#2C4433' : '#D8D3CA'}`,
                       background: kind === k ? '#2C4433' : '#fff',
                       color: kind === k ? '#fff' : '#2C4433' }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{spec.label}</span>
              <span style={{ display: 'block', fontSize: 10, fontWeight: 600,
                             color: kind === k ? '#C9D6CE' : '#8a8a8a' }}>{spec.hint}</span>
            </button>
          ))}
        </div>

        {kind === 'pearl' ? (
          <>
            <div style={cap}>The pearl</div>
            <div style={row}>
              <SizeDial size={pearlSize} min={0.01} max={0.07} step={0.002} onChange={setPearlSize}
                        fmt={v => `${Math.round(v * 1000)}`} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Size</div>
                <div style={{ fontSize: 11, color: '#8a8a8a' }}>a fraction of a rosette</div>
              </div>
            </div>
            <div style={row}>
              {/* Core's own metallic↔matte scale, 0 = metallic. The same curve the ball cluster's
                  Finish control writes, so a pearl here and a pearl there catch light alike. */}
              <SizeDial size={pearlFinish} min={0} max={1} step={0.05} onChange={setPearlFinish}
                        fmt={v => (v < 0.25 ? 'metal' : v > 0.75 ? 'matte' : `${Math.round(v * 100)}`)} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Finish</div>
                <div style={{ fontSize: 11, color: '#8a8a8a' }}>metallic &rarr; matte</div>
              </div>
            </div>
            <Swatch value={pearlColour} onChange={setPearlColour} label="Colour" />
          </>
        ) : (
          <>
        <div style={cap}>On the nozzle</div>
        <TipThumbs value={tip} onChange={setTip} colour={colour} />
        {/* The chosen tip NAMED below the grid. Nineteen labels in the grid would drown the shapes,
            and a shape with no name is unsearchable — a baker asking for "1M" has to be able to find
            it. Hover gives the rest. */}
        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#2C4433', marginBottom: 12 }}>
          {NOZZLE_BY_KEY[tip]?.label ?? tip}
          <span style={{ fontWeight: 600, color: '#8a8a8a' }}> — {NOZZLE_BY_KEY[tip]?.hint}</span>
        </div>
        <Swatch value={colour} onChange={setColour} label="Colour" />
        <div style={row}>
          <SizeDial size={thickness} min={0.03} max={0.22} step={0.005} onChange={setThickness}
                    fmt={v => `${Math.round(v * 1000) / 10}`} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Size</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>how wide the nozzle is</div>
          </div>
        </div>
        <div style={row}>
          <SizeDial size={heapHeight} min={0.3} max={2.0} step={0.05} onChange={setHeapHeight}
                    fmt={v => `${Math.round(v * 100) / 100}`} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Height</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>how far it stands off</div>
          </div>
        </div>
        <div style={row}>
          {/* ⚠️ Below 1.0 the copies interpenetrate — the whole point. The pen's own range and
              default, so the number means the same thing in both places. */}
          <SizeDial size={spacing} min={0.3} max={1.6} step={0.02} onChange={setSpacing}
                    fmt={v => `${Math.round(v * 100) / 100}`} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Spacing</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>
              {spacing >= 1 ? 'apart' : 'overlapping'}
            </div>
          </div>
        </div>
        <div style={row}>
          <SizeDial size={softness} min={0} max={1} step={0.05} onChange={setSoftness}
                    fmt={v => `${Math.round(v * 100)}`} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Softness</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>glossy &rarr; matte</div>
          </div>
        </div>
          </>
        )}

        {/* ⚠️ OUTSIDE THE TERNARY, BECAUSE BOTH KINDS READ IT. `bury` is used by the rosette builder
            (the heap's base) AND by the pearl's (its centre goes one radius out, then presses back
            in by this much). Left inside the rosette branch it was unreachable the moment a pearl
            was in hand — a value that still governed how the pearl seated, with no way to see or
            change it. That is the same shape as the floating seat and the NaN: a control and the
            thing it controls quietly disagreeing. */}
        <div style={row}>
          {/* Measured: at size 0.11 an unburied base already sits 0.0825 inside the wall — the
              profile's own back-reach. This presses it in further, the way a hand does. */}
          <SizeDial size={bury} min={0} max={0.12} step={0.005} onChange={setBury}
                    fmt={v => (v === 0 ? 'on' : `${Math.round(v * 1000) / 10}`)} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Pressed in</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>how hard it meets what it lands on</div>
          </div>
        </div>

        <div style={cap}>The pattern</div>
        <div style={{ fontSize: 12, color: '#2C4433', fontWeight: 700, marginBottom: 10 }}>
          {blobs.length} piece{blobs.length === 1 ? '' : 's'} · {strokeCount} stroke{strokeCount === 1 ? '' : 's'} · {tipsUsed} tip{tipsUsed === 1 ? '' : 's'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button type="button" onClick={undoStroke} disabled={!blobs.length}
            style={{ ...btn, border: '1.5px solid #D8D3CA', background: '#fff', color: '#2C4433',
                     opacity: blobs.length ? 1 : 0.4 }}>Undo stroke</button>
          <button type="button" onClick={() => setBlobs([])} disabled={!blobs.length}
            style={{ ...btn, border: '1.5px solid #f0c9c9', background: '#fff6f6', color: '#c0392b',
                     opacity: blobs.length ? 1 : 0.4 }}>Clear</button>
        </div>

        <div style={cap}>The cake</div>
        <Swatch value={tierColour} onChange={setTierColour} label="Tier" />
        <Toggle on={raking} onChange={setRaking} label="Raking view" hint="side-on, where depth shows" />

        <div style={cap}>Piping onto piping</div>
        <Toggle on={stackAlong === 'pile'}
                onChange={v => setStackAlong(v ? 'pile' : 'surface')}
                label="Follow the piece below"
                hint={stackAlong === 'pile'
                  ? 'stacked pieces face the same way'
                  : 'each grows off the rib it landed on'} />

        <div style={cap}>Save the catalogue row</div>
        <p style={{ fontSize: 10.5, color: '#8a8a8a', lineHeight: 1.5, margin: '0 0 10px' }}>
          Creates the elements row that puts the <b>cream pattern studio</b> in Decorations. The tile
          is a picture of the cream you piped here — switch to the thumbnail view and frame it first.
        </p>
        <Toggle on={thumbView} onChange={setThumbView}
                label={thumbView ? 'Thumbnail view — this is the tile' : 'Set up the thumbnail'}
                hint={thumbView ? 'framed on the piping, not the cake' : 'frame the piping for its tile'} />
        <input value={rowName} onChange={e => setRowName(e.target.value)} placeholder="Name on the tile"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 9,
                   minHeight: 40, marginBottom: 8, border: '1.5px solid #D8D3CA',
                   fontFamily: 'inherit', fontSize: 13, color: '#2C4433' }} />
        <select value={typeId} onChange={e => setTypeId(e.target.value)}
          style={{ width: '100%', padding: '9px 10px', borderRadius: 9, minHeight: 40, marginBottom: 8,
                   border: '1.5px solid #D8D3CA', background: '#fff', fontFamily: 'inherit',
                   fontSize: 12.5, fontWeight: 700, color: '#2C4433' }}>
          <option value="">Element type…</option>
          {/* ⚠️ THE THREE PIPING TYPES ARE NOT OFFERED. A row typed cream_piping, piping_pattern or
              drip is filtered out of the decorations grid and opened as a piping RING card, so it
              never reaches PROCEDURAL_TOOLS and the studio never opens. Leaving them in the list
              would let the next person make exactly the row that has to be deleted again. */}
          {types.filter(t => !['cream_piping', 'piping_pattern', 'drip'].includes(t.slug))
                .map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {/* Optional on the POST, but a tile with no category has no grid to appear in. */}
        <select value={catId} onChange={e => setCatId(e.target.value)}
          style={{ width: '100%', padding: '9px 10px', borderRadius: 9, minHeight: 40, marginBottom: 8,
                   border: '1.5px solid #D8D3CA', background: '#fff', fontFamily: 'inherit',
                   fontSize: 12.5, fontWeight: 700, color: '#2C4433' }}>
          <option value="">Category… (optional, but a tile needs a grid)</option>
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" onClick={saveRow} disabled={!!busy}
          style={{ ...btn, width: '100%', border: 'none', background: '#2C4433', color: '#fff',
                   opacity: busy ? 0.5 : 1 }}>
          {busy ?? 'Save to the catalogue'}
        </button>
        {msg && (
          <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 700, lineHeight: 1.45,
                        color: msg.ok ? '#2C7A4B' : '#c0392b' }}>{msg.text}</div>
        )}

        <p style={{ fontSize: 10.5, color: '#b29aa2', lineHeight: 1.5, marginTop: 14 }}>
          Drag across the shoulder and the run climbs from the side onto the top — the seat comes
          from whatever the pointer hits, so a diagonal run IS the cross in the reference. A real
          pattern will also have to skip core&rsquo;s sibling de-overlap (a config flag, per
          INVARIANTS 3b) while still refusing to drive through a bottom border.
        </p>
      </div>

      {/* ⚠️ THE REF IS ON THE WRAPPER, and without it the save button is a lie: `saveRow` reaches the
          canvas with `shotRef.current?.querySelector('canvas')` — the idiom CakeShapeStudio,
          GenerateShape and GenerateModel all use — so an unattached ref makes every press fail on
          "No canvas to capture". Declared and never attached is not a thing a build or a parse can
          object to. */}
      <div ref={shotRef} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* ⚠️ `shadows`, because the designer's canvas has it and SceneLights only casts when asked.
            A blob standing off a wall is judged by the shadow it throws onto that wall as much as by
            its own shading — without one it reads as a sticker. */}
        {/* ⚠️ `thumbView` IS IN THE KEY, or the camera never moves. R3F reads `camera` once, at
            mount — changing the prop on a live canvas does nothing, which is why `raking` was
            already keyed. A toggle that relabels itself and reframes nothing would be worse than no
            toggle: it claims to show what gets stored. */}
        <Canvas shadows key={`${raking ? 'raking' : 'front'}-${thumbView ? 'thumb' : 'scene'}`}
          camera={thumbView ? { position: shot.eye, fov: 34 }
                : raking
            ? { position: [2.5, TOP_Y * 0.95, 2.6], fov: 34 }
            : { position: [0, TOP_Y * 0.62, 3.6], fov: 34 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          {/* ⚠️ THE DESIGNER'S OWN RIG AND GROUND (INVARIANTS #17). Cream judged under a light no
              cake has had is a judgement about the wrong variable. CardCutoutStudio's caveat applies
              here too: admin never calls `configureEnvMap`, so SceneEnv falls back to drei's indoor
              preset while deployed cakes use the self-hosted outdoor map. */}
          <SceneLights shadows />
          <SceneEnv />
          <SceneBackground colour={DESIGNER_GROUND} />
          {/* ⚠️ ORBIT IS OFF WHILE DRAWING, or a drag across the cake spins the camera instead of
              piping. The designer has the same problem and solves it the same way — a pen session
              owns the pointer. */}
          {/* ⚠️ A REF, NOT `enabled={!drawing}`. That prop was set from React state one render AFTER
              the press, by which time OrbitControls had already begun its own gesture on the canvas
              DOM element — so a drag spun the cake instead of piping on it, and no stroke appeared.
              The ref lets the press itself clear `enableRotate` before the controls' bubble-phase
              listener runs, which is exactly what CakeCanvas does for the designer's pen. Rotate is
              restored on a window-level pointerup, so a drag released off the cake cannot leave the
              camera stuck. */}
          <OrbitControls ref={orbit} enablePan={false} makeDefault
                         target={thumbView ? shot.centre : [0, BOARD_H + BOTTOM_H * 0.55, 0]} />
          <mesh position={[0, BOARD_H / 2, 0]} receiveShadow castShadow>
            <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
            <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
          </mesh>
          <Cake colour={tierColour} drawing={drawing} orbit={orbit}
                onDown={onDown} onMove={onMove} onUp={onUp} />
          {/* ⚠️ NO WRAPPER GROUP, AND THAT IS NOT A TIDY-UP. `e.point` from an R3F pointer event is
              already in WORLD space — the cake's own `BOARD_H` lift is baked into it. Rendering the
              blobs inside a second group offset by `BOARD_H` added that 0.1 a second time, so every
              piece would have floated a board's height above the spot it was piped on, and a run
              near the shoulder would have missed the cake entirely. A stored world point renders at
              a world position; the seat and the render have to speak the same frame. */}
          {/* ── PIPING ONTO PIPING ──────────────────────────────────────────────────────────────
              Sandeep: *"if there are two piping side by side, 3rd one i should be able to do on top
              of / or in between the gaps of these existing ones. not everything need to touch the
              cake surface."*

              ⚠️ THE PLACED CREAM IS A HIT TARGET, and before this it was not. The blobs carried no
              pointer handlers, so a click aimed at a rosette fell straight through to the cake mesh
              behind it and seated the new piece on the WALL — buried inside the one you were aiming
              at. Nothing errored; it simply went where you could not see it.

              ⚠️ THE SEAT IS WHATEVER THE RAY STRUCK, cream or cake, and its own face normal comes
              with it. That is the whole of "not everything needs to touch the cake surface": a piece
              landing on a rosette grows out of the rosette's surface, and one aimed at the gap
              between two hits the wall and grows out of that. The pile decides, not a rule.

              ⚠️ A PIECE FROM THE STROKE IN PROGRESS IS IGNORED — and it returns WITHOUT
              `stopPropagation`, which is the point. R3F walks the intersections nearest-first and
              keeps going until something stops it, so declining here lets the ray carry on to the
              cake behind and the run stays on the surface it started on. Stopping the event instead
              would have made a drag simply die wherever it crossed its own tail.

              One group rather than a handler per mesh: `e.object` already says which piece was hit,
              and a hundred meshes each carrying three closures is a hundred re-subscriptions on
              every render. */}
          <group
            onPointerDown={e => {
              if (e.object?.userData?.strokeId === run.current.id) return;   // my own tail — fall through
              e.stopPropagation();
              if (orbit.current) orbit.current.enableRotate = false;
              onDown(e.point.clone(), stackNormal(e));
            }}
            onPointerMove={e => {
              if (!drawing) return;
              if (e.object?.userData?.strokeId === run.current.id) return;
              e.stopPropagation();
              onMove(e.point.clone(), stackNormal(e));
            }}>
            {blobs.map((b, i) => <Blob key={i} {...b} />)}
          </group>
        </Canvas>
      </div>
    </div>
  );
}
