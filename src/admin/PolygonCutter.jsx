import { useState, useRef, useEffect } from 'react';

// ── Regular polygons, drawn rather than traced ───────────────────────────────────────────────────
//
// Football panels are hexagons, and a hexagon is six vertices. Drawing one by hand — or exporting it
// from a design tool — gives soft edges and whatever imprecision the export had, and then
// `buildSolidReliefGeometry` traces that back into a polygon: an approximation of an approximation,
// forty points describing something that should be six.
//
// So the AUTHORING is programmatic and the runtime is unchanged. What comes out is an ordinary PNG
// that goes through the ordinary element pipeline — `relief.solid` traces the alpha, extrudes a real
// slab, and applies the fondant grain, the bevelled rim and the surface finish that every other
// decoration gets. A geometry-native hexagon would have been a SECOND way to render a decoration,
// arriving with none of that.
//
// ── Anti-aliasing is deliberately left ON ───────────────────────────────────────────────────────
// The instinct is to turn it off for a "crisp" edge. Don't: the relief tracer thresholds alpha at
// 128, so a soft edge resolves to a clean sub-pixel boundary, while a hard one gives it a staircase
// to trace. Smooth in, straight out.

const PRESETS = [
  { label: 'Football — white', sides: 6, rotation: 0,  fill: '#FFFFFF', stroke: '#E8E8E8' },
  { label: 'Football — black', sides: 6, rotation: 0,  fill: '#1A1A1A', stroke: '#000000' },
  { label: 'Pentagon — black', sides: 5, rotation: 0,  fill: '#1A1A1A', stroke: '#000000' },
];

const s = {
  wrap:  { padding: 24, maxWidth: 900, margin: '0 auto', fontFamily: "'Quicksand', sans-serif", display: 'flex', gap: 28, flexWrap: 'wrap' },
  panel: { flex: '1 1 280px', minWidth: 260 },
  h1:    { fontSize: 20, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' },
  sub:   { fontSize: 12.5, color: '#6B8C74', margin: '0 0 20px', lineHeight: 1.5 },
  field: { marginBottom: 14 },
  label: { display: 'block', fontSize: 11, fontWeight: 800, color: '#3D5A44', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5 },
  input: { width: '100%', padding: '7px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', color: '#2C4433', boxSizing: 'border-box' },
  row:   { display: 'flex', alignItems: 'center', gap: 10 },
  val:   { fontSize: 12, fontWeight: 700, color: '#6B8C74', minWidth: 52, textAlign: 'right' },
  btn:   { padding: '10px 18px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  chip:  { padding: '6px 12px', borderRadius: 20, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontWeight: 700, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit' },
  // The checkerboard is the point of the preview: these are cut out on transparency, and a white
  // page behind a white hexagon shows nothing at all.
  stage: { flex: '0 0 320px', width: 320, height: 320, borderRadius: 12, border: '1.5px solid #C5D4C8',
           backgroundImage: 'linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%)',
           backgroundSize: '16px 16px', backgroundPosition: '0 0,0 8px,8px -8px,-8px 0' },
  hint:  { fontSize: 11.5, color: '#8aa091', lineHeight: 1.55, marginTop: 14 },
};

/**
 * Draw a regular polygon centred in a square canvas.
 *
 * `radius` is centre-to-VERTEX, and the shape is inset by a margin so the silhouette never touches
 * the edge — a shape running off the canvas traces as an open boundary that closes along the border,
 * which is a different outline from the one you drew.
 */
export function drawPolygon(ctx, size, { sides, rotation, fill, stroke, cornerRadius }) {
  const c = size / 2;
  const margin = size * 0.06;
  const r = c - margin;
  // -90° so a rotation of 0 puts a FLAT edge on top, which is how a football panel sits. Without it
  // a "0°" hexagon would be pointy-top and every authored offset would be rotated by half a step.
  const start = (rotation - 90) * Math.PI / 180;

  const pts = Array.from({ length: sides }, (_, i) => {
    const a = start + (i * 2 * Math.PI) / sides;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  });

  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  if (cornerRadius > 0) {
    // A real fondant cutter has slightly soft corners, and a perfectly sharp point reads as plastic.
    // arcTo rounds between each pair of edges; the radius is clamped so it can never exceed half the
    // shortest edge and invert the corner.
    const edge = 2 * r * Math.sin(Math.PI / sides);
    const rad = Math.min(cornerRadius, edge / 2 - 0.5);
    pts.forEach((p, i) => {
      const prev = pts[(i - 1 + sides) % sides];
      const next = pts[(i + 1) % sides];
      const towards = (from, to, d) => {
        const dx = to[0] - from[0], dy = to[1] - from[1];
        const len = Math.hypot(dx, dy) || 1;
        return [from[0] + (dx / len) * d, from[1] + (dy / len) * d];
      };
      const a = towards(p, prev, rad);
      const b = towards(p, next, rad);
      i ? ctx.lineTo(...a) : ctx.moveTo(...a);
      ctx.arcTo(p[0], p[1], b[0], b[1], rad);
    });
  } else {
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  }
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke && stroke !== fill) {
    // A hairline edge so a WHITE panel still has a silhouette against white fondant. Drawn inside
    // the fill, not outside, or it would widen the traced outline past the shape you specified.
    ctx.lineWidth = Math.max(1, size * 0.006);
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

export default function PolygonCutter() {
  const [sides, setSides]       = useState(6);
  const [rotation, setRotation] = useState(0);
  const [corner, setCorner]     = useState(6);
  const [fill, setFill]         = useState('#FFFFFF');
  const [stroke, setStroke]     = useState('#E8E8E8');
  const [size, setSize]         = useState(1024);
  const canvasRef = useRef(null);

  // The preview is a fixed 320 px regardless of the export size — what changes with `size` is the
  // resolution of the file, not the shape, so a preview that resized would suggest otherwise.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    drawPolygon(c.getContext('2d'), 320, { sides, rotation, fill, stroke, cornerRadius: corner * (320 / size) });
  }, [sides, rotation, corner, fill, stroke, size]);

  function download() {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    drawPolygon(c.getContext('2d'), size, { sides, rotation, fill, stroke, cornerRadius: corner });
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = ({ 3: 'triangle', 4: 'square', 5: 'pentagon', 6: 'hexagon', 8: 'octagon' })[sides] ?? `${sides}-gon`;
      a.href = url;
      a.download = `${name}-${fill.replace('#', '').toLowerCase()}-${size}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }

  const applyPreset = (p) => { setSides(p.sides); setRotation(p.rotation); setFill(p.fill); setStroke(p.stroke); };

  return (
    <div style={s.wrap}>
      <div style={s.panel}>
        <h1 style={s.h1}>Polygon Cutter</h1>
        <p style={s.sub}>
          Exact shapes for fondant cut-outs. Download the PNG, then add it as an ordinary element with
          a <strong>solid relief</strong> so it extrudes into a real slab.
        </p>

        <div style={s.field}>
          <label style={s.label}>Presets</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map(p => (
              <button key={p.label} style={s.chip} onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label}>Sides</label>
          <div style={s.row}>
            <input type="range" min={3} max={12} value={sides} style={{ flex: 1 }}
                   onChange={e => setSides(+e.target.value)} />
            <span style={s.val}>{sides}</span>
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label}>Rotation</label>
          <div style={s.row}>
            <input type="range" min={0} max={90} value={rotation} style={{ flex: 1 }}
                   onChange={e => setRotation(+e.target.value)} />
            <span style={s.val}>{rotation}°</span>
          </div>
          <div style={{ fontSize: 11, color: '#8aa091', marginTop: 3 }}>
            0° is flat-top. A honeycomb needs every piece at the same rotation.
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label}>Corner softness</label>
          <div style={s.row}>
            <input type="range" min={0} max={60} value={corner} style={{ flex: 1 }}
                   onChange={e => setCorner(+e.target.value)} />
            <span style={s.val}>{corner ? `${corner}px` : 'sharp'}</span>
          </div>
        </div>

        <div style={{ ...s.field, display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Fill</label>
            <input type="color" value={fill} onChange={e => setFill(e.target.value)} style={{ ...s.input, height: 38, padding: 3 }} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Edge</label>
            <input type="color" value={stroke} onChange={e => setStroke(e.target.value)} style={{ ...s.input, height: 38, padding: 3 }} />
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label}>Export size</label>
          <select style={s.input} value={size} onChange={e => setSize(+e.target.value)}>
            <option value={512}>512 × 512</option>
            <option value={1024}>1024 × 1024</option>
            <option value={2048}>2048 × 2048</option>
          </select>
        </div>

        <button style={s.btn} onClick={download}>Download PNG</button>

        <p style={s.hint}>
          Transparent background, so it goes straight through the 2D pipeline — leave background
          removal <strong>off</strong>, there is nothing to remove and it can only nibble the edge.
        </p>
      </div>

      <canvas ref={canvasRef} width={320} height={320} style={s.stage} />
    </div>
  );
}
