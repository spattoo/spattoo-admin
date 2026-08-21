import { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { fetchAdminTemplates, createTemplate, updateTemplate, deleteTemplate, uploadBlob, fetchAllTags, saveTemplateTags, saveTemplateAttrs, exportTemplates, publishTemplate
} from '../lib/api.js';

const SHAPES = [
  { value: 'round',      label: 'Round' },
  { value: 'round_long', label: 'Round — Tall' },
  { value: 'square',     label: 'Square' },
  { value: 'rectangle',  label: 'Rectangle' },
  { value: 'heart',      label: 'Heart' },
  { value: 'hexagon',    label: 'Hexagon' },
];

const TIER_SCALES  = { 1: [1.0], 2: [1.0, 0.72], 3: [1.0, 0.72, 0.52] };
const TIER_HEIGHT  = 0.7;
const SHAPE_HEIGHT = { round_long: 1.3 };

function shapeHeight(shape) { return SHAPE_HEIGHT[shape] ?? TIER_HEIGHT; }
const TIER_GAP      = 0.04;
const BOARD_HEIGHT  = 0.06;
const CAKE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#F5E6C8', roughness: 0.4,  metalness: 0 });
const BOARD_MATERIAL= new THREE.MeshStandardMaterial({ color: '#C9A84C', roughness: 0.3,  metalness: 0.6 });

function tierGeometry(shape, scale) {
  const r = scale, h = shapeHeight(shape);
  switch (shape) {
    case 'round':
    case 'round_long':
      return new THREE.CylinderGeometry(r, r, h, 48);
    case 'square':
      return new THREE.BoxGeometry(r * 2, h, r * 2);
    case 'rectangle':
      return new THREE.BoxGeometry(r * 2.8, h, r * 2);
    case 'hexagon':
      return new THREE.CylinderGeometry(r, r, h, 6);
    case 'heart': {
      const a = r * 0.85;
      const s = new THREE.Shape();
      s.moveTo(0, a * 1.1);
      s.bezierCurveTo( a * 1.6,  a * 1.1,  a * 1.6, -a * 0.3, 0, -a * 0.85);
      s.bezierCurveTo(-a * 1.6, -a * 0.3, -a * 1.6,  a * 1.1, 0,  a * 1.1);
      return new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
    }
    default:
      return new THREE.CylinderGeometry(r, r, h, 48);
  }
}

function boardGeometry(shape, scale) {
  const r = scale * 1.25, h = BOARD_HEIGHT;
  switch (shape) {
    case 'square':   return new THREE.BoxGeometry(r * 2, h, r * 2);
    case 'rectangle':return new THREE.BoxGeometry(r * 2.8, h, r * 2);
    default:         return new THREE.CylinderGeometry(r, r, h, 48);
  }
}

function CakeTier({ shape, scale, yCenter, color }) {
  const geo    = useMemo(() => tierGeometry(shape, scale), [shape, scale]);
  const isHeart = shape === 'heart';
  const h       = shapeHeight(shape);
  const topY    = isHeart ? yCenter + h : yCenter + h / 2;
  const col     = color || '#F5E6C8';

  return (
    <group
      position={isHeart ? [0, yCenter + h / 2, 0] : [0, yCenter, 0]}
      rotation={isHeart ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
    >
      <mesh geometry={geo} castShadow receiveShadow>
        <meshStandardMaterial color={col} roughness={0.68} metalness={0} />
      </mesh>
      {!isHeart && (
        <mesh position={[0, h / 2 + 0.01, 0]} castShadow>
          <cylinderGeometry args={[scale - 0.01, scale - 0.01, 0.02, 48]} />
          <meshStandardMaterial color={col} roughness={0.60} metalness={0} />
        </mesh>
      )}
    </group>
  );
}

function CakeScene({ shape, tierCount, tierColors, onReady }) {
  const groupRef = useRef();
  const { camera, controls } = useThree();
  const scales = TIER_SCALES[tierCount];

  const h = shapeHeight(shape);
  // Compute y-center for each tier stacked from bottom
  const tiers = scales.map((scale, i) => {
    const yBottom = BOARD_HEIGHT + i * (h + TIER_GAP);
    return { scale, yCenter: yBottom + h / 2 };
  });

  const boardGeo = useMemo(() => boardGeometry(shape, scales[0]), [shape, scales[0]]);

  useEffect(() => {
    if (!groupRef.current) return;
    const box    = new THREE.Box3().setFromObject(groupRef.current);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist   = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.15;

    // Elevated angle — looking from above-right so top surface is visible
    camera.position.set(center.x + dist * 0.3, center.y + dist * 0.7, center.z + dist);
    camera.near = dist / 100;
    camera.far  = dist * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    if (controls) { controls.target.copy(center); controls.update(); }

    const t = setTimeout(onReady, 600);
    return () => clearTimeout(t);
  }, [shape, tierCount]);

  return (
    <group ref={groupRef}>
      <mesh geometry={boardGeo} material={BOARD_MATERIAL} position={[0, BOARD_HEIGHT / 2, 0]} />
      {tiers.map((tier, i) => (
        <CakeTier key={i} shape={shape} scale={tier.scale} yCenter={tier.yCenter} color={tierColors?.[i]} />
      ))}
    </group>
  );
}

function CakePreview({ shape, tierCount, tierColors, canvasRef, onCapture }) {
  return (
    <div ref={canvasRef} style={{ width: '100%', height: 300, borderRadius: 10, overflow: 'hidden', border: '1.5px solid #C5D4C8', background: '#f4f4f5' }}>
      <Canvas gl={{ preserveDrawingBuffer: true }} camera={{ fov: 45 }}>
        <color attach="background" args={['#f4f4f5']} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[6, 14, 8]} intensity={1.5} castShadow />
        <directionalLight position={[-4, 4, -4]} intensity={0.4} />
        <Environment preset="apartment" backgroundBlurriness={1} />
        <CakeScene shape={shape} tierCount={tierCount} tierColors={tierColors} onReady={onCapture} />
        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = {
  exportBar: {
    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
    padding: '8px 12px', borderRadius: 10, background: '#F3F7F4',
    fontSize: 12, color: '#2C4433', fontFamily: "'Quicksand',sans-serif",
  },
  exportBtn: {
    marginLeft: 'auto', padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: '#2C4433', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: "'Quicksand',sans-serif",
  },
  exportGhost: {
    padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8',
    background: '#fff', color: '#6B8C74', fontSize: 12, fontWeight: 700, fontFamily: "'Quicksand',sans-serif",
  },
  page:  { minHeight: '100vh', background: '#EDEAE2', fontFamily: "'Quicksand', sans-serif", padding: '40px 0' },
  inner: { maxWidth: 860, margin: '0 auto', padding: '0 24px' },
  header:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 },
  title: { fontSize: 20, fontWeight: 800, color: '#2C4433' },
  btn: (v = 'primary') => ({
    padding: v === 'primary' ? '10px 22px' : '7px 16px',
    borderRadius: 10, cursor: 'pointer', border: 'none',
    fontSize: 13, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
    background: v === 'primary' ? '#3D5A44' : '#E8EDE9',
    color: v === 'primary' ? '#fff' : '#3D5A44',
  }),
  card:    { background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', padding: 24, marginBottom: 14 },
  formCard:{ background: '#fff', borderRadius: 16, border: '1.5px solid #3D5A44', padding: 28, marginBottom: 28 },
  grid:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 },
  field:   { marginBottom: 16 },
  label:   { display: 'block', fontSize: 11, fontWeight: 700, color: '#3D5A44', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 },
  input:   { width: '100%', padding: '9px 12px', border: '1.5px solid #C5D4C8', borderRadius: 8, fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', outline: 'none', boxSizing: 'border-box' },
  radioRow:{ display: 'flex', gap: 8 },
  radioBtn:(active) => ({ flex: 1, padding: '7px 0', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${active ? '#3D5A44' : '#C5D4C8'}`, background: active ? '#E8EDE9' : '#fff', color: active ? '#2C4433' : '#6B8C74', fontSize: 13, fontWeight: 700, fontFamily: "'Quicksand', sans-serif" }),
  msg:     (ok) => ({ fontSize: 13, fontWeight: 600, color: ok ? '#3D5A44' : '#c00', marginTop: 12 }),
  thumb:   { width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1.5px solid #C5D4C8', background: '#f7f9f7', flexShrink: 0 },
  badge:   (color) => ({ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: color === 'green' ? '#E8EDE9' : color === 'red' ? '#fdecea' : color === 'neutral' ? '#EEE8F0' : '#f0f0f0', color: color === 'green' ? '#3D5A44' : color === 'red' ? '#c00' : color === 'neutral' ? '#7A5A8A' : '#888', letterSpacing: 0.5, textTransform: 'uppercase' }),
};

// ─── Form ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIER_COLOR = '#fefbea';

function TemplateForm({ onSaved, onCancel }) {
  const [name, setName]               = useState('');
  const [shape, setShape]             = useState('round');
  const [tierCount, setTierCount]     = useState(1);
  const [tierColors, setTierColors]   = useState([DEFAULT_TIER_COLOR]);
  const [weight, setWeight]           = useState('');
  const [minAge, setMinAge]           = useState('');
  const [maxAge, setMaxAge]           = useState('');
  const [occasionTags, setOccasionTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState(new Set());
  const [thumbBlob, setThumbBlob]     = useState(null);
  const [capturing, setCapturing]     = useState(false);
  const [saving, setSaving]           = useState(false);
  const [msg, setMsg]                 = useState(null);
  const canvasRef                     = useRef();

  useEffect(() => {
    fetchAllTags().then(tags => setOccasionTags(tags.filter(t => t.category === 'occasion')));
  }, []);

  // Keep tierColors length in sync with tierCount
  useEffect(() => {
    setTierColors(prev => {
      const next = Array.from({ length: tierCount }, (_, i) => prev[i] ?? DEFAULT_TIER_COLOR);
      return next;
    });
  }, [tierCount]);

  // Reset thumbnail only when cake structure changes (shape/tier count)
  useEffect(() => setThumbBlob(null), [shape, tierCount]);

  // Re-capture after color changes (canvas updates live, just need a short settle delay)
  useEffect(() => {
    setCapturing(true);
    const t = setTimeout(() => {
      const canvas = canvasRef.current?.querySelector('canvas');
      if (canvas) {
        canvas.toBlob(blob => {
          if (blob) setThumbBlob(blob);
          setCapturing(false);
        }, 'image/webp', 0.85);
      } else {
        setCapturing(false);
      }
    }, 300);
    return () => { clearTimeout(t); setCapturing(false); };
  }, [tierColors]);

  function captureThumb() {
    const canvas = canvasRef.current?.querySelector('canvas');
    if (!canvas) return;
    canvas.toBlob(blob => { if (blob) setThumbBlob(blob); }, 'image/webp', 0.85);
  }

  async function handleSave() {
    if (!name.trim()) { setMsg({ ok: false, text: 'Name is required.' }); return; }
    setSaving(true); setMsg(null);
    try {
      let thumbnailKey = null;
      if (thumbBlob) {
        const ext = thumbBlob.type === 'image/webp' ? 'webp' : 'png';
        const filename = `${crypto.randomUUID()}.${ext}`;
        const { key } = await uploadBlob('templates/thumbnails', filename, thumbBlob);
        thumbnailKey = key;
      }
      const newTemplate = await createTemplate({
        name:          name.trim(),
        shape,
        tier_count:    tierCount,
        type:          'basic',
        design:        {
          tiers: TIER_SCALES[tierCount].map((scale, i) => {
            const h = shapeHeight(shape);
            const dims = shape === 'rectangle'
              ? { width: +(scale * 2.8).toFixed(4), depth: +(scale * 2).toFixed(4) }
              : { width: +(scale * 2).toFixed(4), depth: +(scale * 2).toFixed(4) };
            return {
              index:  i,
              scale,
              shape,
              height: h,
              radius: scale,
              ...dims,
              color:  tierColors[i] ?? DEFAULT_TIER_COLOR,
            };
          }),
          elements: [],
          text_slots: [{ id: 'main_text', label: 'Message', value: '', zone: 'top_surface', tier_index: tierCount - 1 }],
        },
        thumbnail_url: thumbnailKey,
        sort_order:    0,
      });
      const hasAttrs = weight !== '' || minAge !== '' || maxAge !== '';
      if (hasAttrs) {
        await saveTemplateAttrs(newTemplate.id, {
          min_weight_kg: weight !== '' ? parseFloat(weight) : null,
          min_age:       minAge !== '' ? parseInt(minAge, 10) : null,
          max_age:       maxAge !== '' ? parseInt(maxAge, 10) : null,
        });
      }
      if (selectedTagIds.size > 0) {
        await saveTemplateTags(newTemplate.id, [...selectedTagIds]);
      }
      setMsg({ ok: true, text: 'Template created!' });
      setTimeout(onSaved, 700);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.formCard}>
      <div style={{ fontSize: 15, fontWeight: 800, color: '#2C4433', marginBottom: 20 }}>New Basic Template</div>

      <div style={s.grid}>
        <div style={s.field}>
          <label style={s.label}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Single Tier Round" />
        </div>
        <div style={s.field}>
          <label style={s.label}>Shape</label>
          <div style={{ ...s.radioRow, flexWrap: 'wrap' }}>
            {SHAPES.map(sh => (
              <button key={sh.value} style={{ ...s.radioBtn(shape === sh.value), flex: 'none', padding: '6px 14px' }} onClick={() => setShape(sh.value)}>
                {sh.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={s.grid}>
        <div style={{ ...s.field, marginBottom: 20 }}>
          <label style={s.label}>Tiers</label>
          <div style={s.radioRow}>
            {[1, 2, 3].map(n => (
              <button key={n} style={s.radioBtn(tierCount === n)} onClick={() => setTierCount(n)}>
                {n} Tier{n > 1 ? 's' : ''}
              </button>
            ))}
          </div>
        </div>

        <div style={{ ...s.field, marginBottom: 20 }}>
          <label style={s.label}>Tier Colors</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {tierColors.map((color, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <input
                  type="color"
                  value={color}
                  onChange={e => { const v = e.target.value; setTierColors(prev => prev.map((c, j) => j === i ? v : c)); }}
                  style={{ width: 36, height: 36, padding: 2, border: '1.5px solid #C5D4C8', borderRadius: 8, cursor: 'pointer', background: 'none' }}
                />
                <span style={{ fontSize: 10, color: '#6B8C74', fontWeight: 600 }}>T{i + 1}</span>
                <span style={{ fontSize: 9, color: '#999', fontFamily: 'monospace' }}>{color}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={s.grid}>
        <div style={s.field}>
          <label style={s.label}>Weight (kg)</label>
          <input style={s.input} type="number" min="0" step="0.5" placeholder="e.g. 1.5" value={weight} onChange={e => setWeight(e.target.value)} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Age Range (years)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={{ ...s.input, width: '50%' }} type="number" min="0" step="1" placeholder="Min" value={minAge} onChange={e => setMinAge(e.target.value)} />
            <span style={{ color: '#6B8C74', fontWeight: 700 }}>–</span>
            <input style={{ ...s.input, width: '50%' }} type="number" min="0" step="1" placeholder="Max" value={maxAge} onChange={e => setMaxAge(e.target.value)} />
          </div>
        </div>
      </div>

      {occasionTags.length > 0 && (
        <div style={s.field}>
          <label style={s.label}>Occasions</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {occasionTags.map(tag => {
              const selected = selectedTagIds.has(tag.id);
              return (
                <button key={tag.id} type="button"
                  style={{ padding: '5px 14px', borderRadius: 20, border: `1.5px solid ${selected ? '#3D5A44' : '#C5D4C8'}`, background: selected ? '#E8EDE9' : '#fff', color: selected ? '#2C4433' : '#6B8C74', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: "'Quicksand', sans-serif" }}
                  onClick={() => setSelectedTagIds(prev => { const next = new Set(prev); selected ? next.delete(tag.id) : next.add(tag.id); return next; })}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={s.field}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={{ ...s.label, marginBottom: 0 }}>Preview & Thumbnail</label>
          <button style={s.btn('secondary')} onClick={captureThumb}>Re-capture</button>
        </div>
        <CakePreview shape={shape} tierCount={tierCount} tierColors={tierColors} canvasRef={canvasRef} onCapture={captureThumb} />
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 }}>
          {capturing ? (
            <>
              <div style={{ width: 18, height: 18, border: '2.5px solid #C5D4C8', borderTopColor: '#3D5A44', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600 }}>Capturing…</span>
            </>
          ) : thumbBlob ? (
            <>
              <img src={URL.createObjectURL(thumbBlob)} style={{ ...s.thumb, width: 48, height: 48 }} alt="thumbnail" />
              <span style={{ fontSize: 11, color: '#3D5A44', fontWeight: 600 }}>Thumbnail captured</span>
            </>
          ) : null}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button style={{ ...s.btn('primary'), opacity: saving ? 0.6 : 1 }} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Template'}
        </button>
        <button style={s.btn('secondary')} onClick={onCancel}>Cancel</button>
      </div>
      {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ManageTemplates() {
  const [templates, setTemplates] = useState([]);
  // Picked for export — separate from anything the editor holds, for the same reason as elements:
  // ticking a template is not opening it.
  //
  // ⚠️ These, and handleExport below, were declared in OTHER COMPONENTS: the state in TemplateForm
  // and the handler inside CakeTier, a three.js mesh 200 lines above. Only the JSX landed here, so
  // every render threw "picked is not defined" and the screen showed the error boundary. Neither
  // misplacement is visible when reading either half on its own — a `useState` looks at home at the
  // top of any component, which is why the anchor a patch attaches to matters more than the patch.
  const [picked, setPicked]       = useState(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [publishing, setPublishing] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [msg, setMsg]             = useState(null);

  async function load() {
    setLoading(true);
    try   { setTemplates(await fetchAdminTemplates()); }
    catch (err) { setMsg({ ok: false, text: err.message }); }
    finally { setLoading(false); }
  }

  async function handleExport() {
    if (!picked.size) return;
    setExporting(true);
    try {
      const bundle = await exportTemplates([...picked]);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `templates-${new Date().toISOString().slice(0, 10)}-${bundle.cake_templates.length}.json`;
      a.click();
      URL.revokeObjectURL(url);
      // The element count is the number worth showing: a template bundle carries the elements its
      // design references, so it is routinely far larger than the templates ticked — and those
      // elements are what stops the templates misbehaving silently at the other end.
      setMsg({ ok: true, text:
        `Exported ${bundle.cake_templates.length} template(s) — plus ${bundle.elements.length} element(s), ` +
        `${bundle.tags.length} tag(s), ${bundle.assets.length} asset(s). Import under Elements → Import Elements.` });
    } catch (e) {
      setMsg({ ok: false, text: e?.message ?? 'Export failed' });
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggleActive(t) {
    try {
      await updateTemplate(t.id, { is_active: !t.is_active });
      setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, is_active: !x.is_active } : x));
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  }

  // Copy a bakery's template into the catalogue. A COPY: the bakery keeps its own row, so a later
  // edit to the catalogue version cannot rewrite what they see.
  //
  // The interesting failure is 409 — the design uses decorations that belong to that bakery, which
  // every other bakery would fail to resolve. It renders anyway (the designer tolerates a missing
  // catalogue row) with caps and clustering silently gone, so the route refuses and names them.
  async function handlePublish(t) {
    // Says what will happen to BOTH rows. "Publish" on its own does not suggest the bakery's copy is
    // about to be deactivated, and a template disappearing from a studio should never be a surprise.
    if (!window.confirm(
      `Copy "${t.name}" into the catalogue?\n\n`
      + `${t.owner_name}'s own copy is deactivated so the same cake does not appear twice in their `
      + `studio — it stays here and can be reactivated.`
    )) return;
    setPublishing(t.id);
    try {
      const r = await publishTemplate(t.id);
      setMsg({
        ok: true,
        text: r?.warning
          ?? `"${t.name}" is in the catalogue${r?.deactivated_source ? `, and ${t.owner_name}'s copy is now inactive` : ''}.`,
      });
      await load();
    } catch (e) {
      const names = e?.private_elements?.map(x => x.name).join(', ');
      setMsg({ ok: false, text: names ? `${e.message} — ${names}` : (e?.message ?? 'Publish failed') });
    } finally {
      setPublishing(null);
    }
  }

  async function handleDelete(t) {
    if (!window.confirm(`Delete "${t.name}"? This cannot be undone.`)) return;
    try {
      await deleteTemplate(t.id);
      setTemplates(prev => prev.filter(x => x.id !== t.id));
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  }

  return (
    <>
      <div style={s.page}>
        <div style={s.inner}>
          <div style={s.header}>
            <div style={s.title}>Cake Templates</div>
            {!showForm && (
              <button style={s.btn('primary')} onClick={() => setShowForm(true)}>+ New Basic Template</button>
            )}
          </div>

          {showForm && (
            <TemplateForm
              onSaved={() => { setShowForm(false); load(); }}
              onCancel={() => setShowForm(false)}
            />
          )}

          {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}

          {templates.length > 0 && (
            <div style={s.exportBar}>
              <button onClick={() => setPicked(p2 => p2.size === templates.length ? new Set() : new Set(templates.map(t => t.id)))}
                      style={s.exportGhost}>
                {picked.size === templates.length ? 'Deselect all' : `Select all ${templates.length}`}
              </button>
              {picked.size > 0 && <span style={{ fontWeight: 700 }}>{picked.size} picked</span>}
              {picked.size > 0 && (
                <button onClick={handleExport} disabled={exporting} style={s.exportBtn}>
                  {exporting ? 'Exporting…' : 'Export'}
                </button>
              )}
            </div>
          )}

          {loading ? (
            <div style={{ color: '#6B8C74', fontSize: 13 }}>Loading…</div>
          ) : templates.length === 0 ? (
            <div style={{ ...s.card, color: '#6B8C74', fontSize: 13 }}>No templates yet. Create your first one.</div>
          ) : (
            templates.map(t => (
              <div key={t.id} style={s.card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <input
                    type="checkbox"
                    checked={picked.has(t.id)}
                    onChange={() => setPicked(prev => {
                      const next = new Set(prev);
                      next.has(t.id) ? next.delete(t.id) : next.add(t.id);
                      return next;
                    })}
                    title="Pick for export"
                    style={{ width: 15, height: 15, flexShrink: 0, cursor: 'pointer', accentColor: '#2C4433' }} />
                  <div style={{ ...s.thumb, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {t.thumbnail_url
                      ? <img src={t.thumbnail_url} alt={t.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }} />
                      : <span style={{ fontSize: 9, color: '#C5D4C8' }}>No thumb</span>
                    }
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: '#2C4433', marginBottom: 5 }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: '#6B8C74', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <span>{t.shape}</span>
                      <span>{t.tier_count} tier{t.tier_count > 1 ? 's' : ''}</span>
                      {t.attrs?.min_weight_kg != null && <span>{t.attrs.min_weight_kg} kg</span>}
                      {(t.attrs?.min_age != null || t.attrs?.max_age != null) && (
                        <span>{t.attrs?.min_age ?? 0}–{t.attrs?.max_age ?? '∞'} yrs</span>
                      )}
                      {(t.tag_slugs ?? []).map(slug => (
                        <span key={slug} style={s.badge('neutral')}>{slug.replace(/_/g, ' ')}</span>
                      ))}
                      <span style={s.badge('green')}>{t.type}</span>
                      <span style={s.badge(t.is_active ? 'green' : 'red')}>{t.is_active ? 'Active' : 'Inactive'}</span>
                      {/* WHOSE this is. The screen lists every bakery's templates, and two things
                          here work only on catalogue rows — Export takes global templates only, and
                          Publish is what makes one. Without the owner on the card both are offered
                          on rows that cannot do them, and the answer arrives as a 404. */}
                      <span style={s.badge(t.owner_name ? 'neutral' : 'green')}>
                        {t.owner_name ?? 'catalogue'}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={s.btn('secondary')} onClick={() => toggleActive(t)}>
                      {t.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    {/* Only for a bakery that authors the catalogue (migration 070). Every other
                        baker's template is their own work, so the button is not offered — and the
                        route refuses it too, because a hidden button is not a rule. */}
                    {t.can_publish && (
                      <button style={s.btn('secondary')} disabled={publishing === t.id}
                        title="Copy this into the catalogue, leaving the bakery's own copy alone"
                        onClick={() => handlePublish(t)}>
                        {publishing === t.id ? 'Publishing…' : 'Publish to catalogue'}
                      </button>
                    )}
                    <button
                      style={{ ...s.btn('secondary'), color: '#c00', background: '#fdecea' }}
                      onClick={() => handleDelete(t)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
