import { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
/* The scene is CORE's, not a copy living here: the same lights, the same environment, the same
 * background, AND the same standing board the designer draws — so what this shows is what a baker
 * would get, and the two cannot drift (INVARIANTS #15, and the root CLAUDE.md on studios importing
 * the geometry rather than carrying one). */
import {
  SceneLights, SceneEnv, SceneBackground, StudioWall, baseColourOf, corsUrl, DESIGNER_GROUND,
} from '@spattoo/designer';

/* ── Studio backdrop — PROOF OF CONCEPT ──────────────────────────────────────────────────────────
 *
 * Sandeep, 2026-10-28: *"for background, is it possible to use a image than grid lines? i just want
 * to let use use a bakery image to make the studio look better?"* — then *"first we will do it as
 * poc, then do the real admin author work."*
 *
 * This is the looking part. Drop an image in, turn the cake, decide whether it holds up.
 *
 * ⚠️ IT IS A BOARD STANDING IN THE ROOM, NOT A BACKGROUND, AND THAT IS THE WHOLE FEATURE. The first
 * attempt put the picture on `scene.background`, which is painted across the viewport and is not in
 * the world at all: the cake hung in front of a photograph with nothing under it — *"cake looks like
 * floating and not matching with the ambiance in image"*. `StudioWall` stands where the grid wall
 * stands, with its base on the floor the cake is already on, so the cake's ground, its shadow and
 * its horizon are untouched. Sandeep's correction, exactly: *"cake should still look like its on the
 * same horizontal plane as it is now. only the place where vertical grid lines are placed, that
 * should be replaced with image. so the image stands there."*
 *
 * ⚠️ AND THE FLOOR CONTINUES THE PICTURE. Standing the board revealed the next join: the photo's own
 * floor stopped in a hard line with plain grey carrying on underneath. `baseColourOf` reads the
 * colour the image ENDS on and the ground takes it, which is the difference between a cake in a
 * bakery and a cake in front of a picture of one. Same call core makes, so the swatch below is the
 * floor the designer will actually paint.
 *
 * ⚠️ IT CANNOT CHANGE THE CAKE. `meshBasicMaterial`, unlit, exactly like the grid lines it replaces —
 * it takes no light, casts no shadow and bounces nothing onto what stands in front of it.
 *
 * ⚠️ WHAT THIS IS NOT, YET. It saves nothing. There is no backdrop row, no upload and no setting —
 * the root CLAUDE.md is explicit that a studio whose output only exists on screen is a mock-up, not
 * authoring. The real work, once the look is agreed: a `studio_backdrops` table an admin adds rows
 * to (rule 3), the image on R2 the way a storefront portrait already is, and a field on the baker's
 * saved studio look beside the ground colour.
 *
 * ⚠️ A BACKDROP REPLACES THE GRID, it does not sit under it — lines over a photograph read as a
 * mistake. Core already does this; the toggle here is only so the two can be compared.
 */
export default function StudioBackdropStudio() {
  const [image, setImage] = useState(null);     // blob: or https: — whatever is being looked at
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [dim, setDim] = useState(0);
  const [floor, setFloor] = useState(null);
  const madeUrl = useRef(null);

  /* The floor swatch, read with core's own function so what is shown here is what will be painted. */
  useEffect(() => {
    if (!image) { setFloor(null); return undefined; }
    let live = true;
    const img = new Image();
    /* `crossOrigin` AND `corsUrl`, for the reason core's own copy records: the header alone loses
       to a cache entry a plain <img> poisoned, and a tainted canvas throws rather than lies. */
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!live) return;
      setFloor(baseColourOf(img, (w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
      }));
    };
    img.onerror = () => { if (live) setFloor(null); };
    img.src = corsUrl(image);
    return () => { live = false; };
  }, [image]);

  useEffect(() => () => { if (madeUrl.current) URL.revokeObjectURL(madeUrl.current); }, []);

  const take = (file) => {
    if (!file) return;
    if (madeUrl.current) URL.revokeObjectURL(madeUrl.current);
    madeUrl.current = URL.createObjectURL(file);
    setName(file.name);
    setImage(madeUrl.current);
  };

  const btn = {
    padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: '#2C4433', color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
  };
  const ghost = {
    ...btn, background: '#fff', color: '#2C4433', border: '1.5px solid #D8E0DA', fontWeight: 600,
  };

  return (
    <div style={{ padding: 24, fontFamily: "'Quicksand', sans-serif", background: '#F7F9F7', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 20, margin: '0 0 4px', color: '#2C4433' }}>Studio backdrop</h1>
      <p style={{ fontSize: 13, color: '#6B8C74', margin: '0 0 16px', maxWidth: 720, lineHeight: 1.6 }}>
        A picture standing where the grid wall stands, with its base on the floor the cake is already
        on. Drop in an image and <strong>turn the cake</strong> — that is the test. A wall, a shelf
        or a counter photographed straight on holds at any angle; a room shot down its length reads
        as a painted flat the moment the cake rotates.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={btn}>
          Choose an image
          <input type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={e => take(e.target.files?.[0])} />
        </label>
        <input
          value={url} onChange={e => setUrl(e.target.value)}
          placeholder="…or paste an image URL"
          style={{ flex: '1 1 320px', minWidth: 240, padding: '9px 12px', borderRadius: 10,
                   border: '1.5px solid #D8E0DA', fontSize: 13, fontFamily: 'inherit' }} />
        <button type="button" style={ghost}
                onClick={() => { setImage(url.trim() || null); setName(url.trim()); }}>
          Show it
        </button>
        <button type="button" style={ghost} onClick={() => { setImage(null); setName(''); setUrl(''); }}>
          Grid lines
        </button>
        <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 8 }}>
          Push back {Math.round(dim * 100)}%
          <input type="range" min="0" max="0.8" step="0.05" value={dim}
                 onChange={e => setDim(Number(e.target.value))} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
                    fontSize: 11, color: '#9BB5A2', margin: '0 0 12px' }}>
        <span>
          Push back dims the picture so the cake wins it — the same reason a photographer throws a
          backdrop out of focus.
        </span>
        {floor && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6B8C74' }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: floor,
                           border: '1px solid #D8E0DA', display: 'inline-block' }} />
            floor {floor}
          </span>
        )}
      </div>

      <div style={{ height: 560, borderRadius: 14, overflow: 'hidden', border: '1px solid #E3EAE5' }}>
        <Canvas camera={{ position: [0, 2.6, 5.2], fov: 42 }} dpr={[1, 2]} shadows>
          <SceneLights shadows />
          <SceneEnv />
          {/* The ground takes the picture's base colour, which is what removes the join. With no
              picture it is the designer's own wall colour, so "Grid lines" is a true comparison. */}
          <SceneBackground colour={floor || DESIGNER_GROUND} look={floor ? 'sweep' : 'flat'} />
          {image && <StudioWall image={image} dim={dim} />}
          {/* A stand-in cake: two cylinders and a board. Deliberately plain — this page is about
              what is BEHIND the cake, and a decorated one would be the thing you looked at. */}
          <mesh position={[0, 0.72, 0]} castShadow>
            <cylinderGeometry args={[1.2, 1.2, 1.45, 64]} />
            <meshStandardMaterial color="#F6F1E7" roughness={0.9} />
          </mesh>
          <mesh position={[0, 1.78, 0]} castShadow>
            <cylinderGeometry args={[0.82, 0.82, 0.68, 64]} />
            <meshStandardMaterial color="#EADFCB" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.02, 0]} receiveShadow castShadow>
            <cylinderGeometry args={[1.75, 1.75, 0.06, 64]} />
            <meshStandardMaterial color="#D9AE3C" roughness={0.35} metalness={0.5} />
          </mesh>
          {/* Shadow catcher only — the ground itself is the background's colour, so floor and
              backdrop meet with no horizon of their own. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[400, 400]} />
            <shadowMaterial opacity={0.3} />
          </mesh>
          <OrbitControls enablePan={false} minDistance={3} maxDistance={9} />
        </Canvas>
      </div>

      <p style={{ fontSize: 11, color: '#9BB5A2', marginTop: 10 }}>
        {name ? `Showing ${name}. ` : ''}Nothing here is saved. When the look is agreed this becomes
        an admin-authored backdrop row plus a field on the baker’s studio setting — see the note at
        the top of this file.
      </p>
    </div>
  );
}
