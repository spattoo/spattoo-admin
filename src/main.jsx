import React, { lazy, Suspense, useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { supabase } from './lib/supabase.js';
import Login from './auth/Login.jsx';
import logo from './images/spattoo-green.png';
import { getSignedUploadUrl, uploadToR2, createTemplate } from './lib/api.js';

const CreateTemplate = lazy(() =>
  import('@spattoo/designer').then(m => ({ default: m.CreateTemplate }))
);
const AddElement       = lazy(() => import('./admin/AddElement.jsx'));
const OnboardBaker     = lazy(() => import('./admin/OnboardBaker.jsx'));
const ManageTemplates  = lazy(() => import('./admin/ManageTemplates.jsx'));
const DesignTemplate   = lazy(() => import('./admin/DesignTemplate.jsx'));
const GenerateShape    = lazy(() => import('./admin/GenerateShape.jsx'));
const GenerateModel    = lazy(() => import('./admin/GenerateModel.jsx'));
const GlbStudio        = lazy(() => import('./admin/GlbStudio.jsx'));
const GlbRecompose     = lazy(() => import('./admin/GlbRecompose.jsx'));
const ImageTo3DWizard  = lazy(() => import('./admin/ImageTo3DWizard.jsx'));
const BuildFromInspiration = lazy(() => import('./admin/BuildFromInspiration.jsx'));
const ElementTypes     = lazy(() => import('./admin/ElementTypes.jsx'));
const ManageElements   = lazy(() => import('./admin/ManageElements.jsx'));
const ManageFlavours        = lazy(() => import('./admin/ManageFlavours.jsx'));
const ManagePlans           = lazy(() => import('./admin/ManagePlans.jsx'));
const ManageTags            = lazy(() => import('./admin/ManageTags.jsx'));
const ManageNozzles         = lazy(() => import('./admin/ManageNozzles.jsx'));
const BakerSubscriptions    = lazy(() => import('./admin/BakerSubscriptions.jsx'));
const PatternBuilder        = lazy(() => import('./admin/PatternBuilder.jsx'));
const PipingCalibrator      = lazy(() => import('./admin/PipingCalibrator.jsx'));
const PerchCalibrator       = lazy(() => import('./admin/PerchCalibrator.jsx'));
const CreamPenStudio        = lazy(() => import('./admin/CreamPenStudio.jsx'));
const FreehandPenStudio     = lazy(() => import('./admin/FreehandPenStudio.jsx'));
const RolesCapabilities     = lazy(() => import('./admin/RolesCapabilities.jsx'));
const ROUTES = {
  '/templates/create':    CreateTemplate,
  '/templates/design':    DesignTemplate,
  '/templates':           ManageTemplates,
  '/elements/add':        AddElement,
  '/elements/manage':     ManageElements,
  '/elements/generate':   GenerateShape,
  '/elements/generate-model': GenerateModel,
  '/glb-studio':          GlbStudio,
  '/glb-recompose':       GlbRecompose,
  '/elements/image-to-3d': ImageTo3DWizard,
  '/elements/build-from-inspiration': BuildFromInspiration,
  '/elements/types':      ElementTypes,
  '/elements/tags':       ManageTags,
  '/elements/nozzles':    ManageNozzles,
  '/bakers/onboard':      OnboardBaker,
  '/bakers/subscriptions': BakerSubscriptions,
  '/flavours':            ManageFlavours,
  '/plans':               ManagePlans,
  '/pattern-builder':     PatternBuilder,
  '/elements/piping-calibrator': PipingCalibrator,
  '/elements/perch-calibrator':  PerchCalibrator,
  '/elements/cream-pen':         CreamPenStudio,
  '/elements/freehand-pen':      FreehandPenStudio,
  '/admin/roles':                RolesCapabilities,
};

const FALLBACK = (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', color: '#9b5f72' }}>
    Loading…
  </div>
);

// Grouped navigation — rendered as hover/click flyouts in the header.
const NAV_GROUPS = [
  { title: 'Templates', items: [
    { href: '/templates',        label: 'Manage Templates' },
    { href: '/templates/design', label: 'Design Template' },
  ] },
  { title: 'Elements', items: [
    { href: '/elements/add',    label: 'Add Element' },
    { href: '/elements/manage', label: 'Manage Elements' },
    { href: '/elements/types',  label: 'Element Types' },
  ] },
  { title: 'Editors', items: [
    { href: '/elements/build-from-inspiration', label: 'Build from Inspiration' },
    { href: '/elements/image-to-3d',    label: 'Image → 3D Cake' },
    { href: '/elements/generate',       label: 'Generate Shape' },
    { href: '/elements/generate-model', label: 'Generate 3D Model' },
    { href: '/glb-studio',              label: 'GLB Studio' },
    { href: '/glb-recompose',           label: 'GLB Recompose' },
    { href: '/elements/piping-calibrator', label: 'Piping Calibrator' },
    { href: '/elements/perch-calibrator',  label: 'Perch Calibrator' },
    { href: '/elements/cream-pen',      label: 'Cream Pen' },
    { href: '/elements/freehand-pen',   label: 'Freehand Pen' },
    { href: '/pattern-builder',         label: 'Pattern Builder' },
  ] },
  { title: 'Baker', items: [
    { href: '/bakers/onboard',       label: 'Onboard Baker' },
    { href: '/bakers/subscriptions', label: 'Baker Subscriptions' },
    { href: '/plans',                label: 'Subscription Plans' },
  ] },
  { title: 'Others', items: [
    { href: '/elements/nozzles', label: 'Nozzle Catalog' },
    { href: '/flavours',         label: 'Cake Flavours' },
  ] },
  { title: 'Access', items: [
    { href: '/admin/roles', label: 'Roles & Capabilities' },
  ] },
];

function NavMenu() {
  const [open, setOpen] = useState(null);
  const path = window.location.pathname;
  const navRef = useRef(null);
  // Click-driven: a flyout stays open until you pick a child, click another parent, or click
  // outside. (Hover-close made children vanish as the pointer moved toward them.)
  useEffect(() => {
    if (!open) return;
    const onDocDown = e => { if (navRef.current && !navRef.current.contains(e.target)) setOpen(null); };
    const onEsc = e => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDocDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);
  return (
    <nav ref={navRef} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {NAV_GROUPS.map(g => {
        const active = g.items.some(it => it.href === path);
        const isOpen = open === g.title;
        return (
          <div key={g.title} style={{ position: 'relative' }}>
            <button
              onClick={() => setOpen(o => (o === g.title ? null : g.title))}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: isOpen ? '#F4F8F5' : 'transparent',
                border: '1.5px solid', borderColor: isOpen ? '#C5D4C8' : 'transparent',
                borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
                fontFamily: "'Quicksand', sans-serif", fontSize: 13,
                fontWeight: 700, color: active ? '#2C4433' : '#5C7565',
              }}>
              {g.title}
              <span style={{ fontSize: 9, color: '#9BB5A2' }}>▾</span>
            </button>
            {isOpen && (
              <div style={{
                position: 'absolute', top: '100%', left: 0,
                background: '#fff', border: '1.5px solid #C5D4C8', borderRadius: 12,
                boxShadow: '0 8px 24px rgba(44,68,51,0.14)', minWidth: 210,
                padding: 6, zIndex: 30, marginTop: 4,
              }}>
                {g.items.map(it => (
                  <a key={it.href} href={it.href}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F4F8F5'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = it.href === path ? '#EEF4EF' : 'transparent'; }}
                    style={{
                      display: 'block', padding: '9px 12px', borderRadius: 8,
                      background: it.href === path ? '#EEF4EF' : 'transparent',
                      color: '#2C4433', textDecoration: 'none', fontSize: 13,
                      fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                    {it.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function AppHeader({ session }) {
  const isHome = window.location.pathname === '/';
  const [menuOpen, setMenuOpen] = useState(false);
  const email = session?.user?.email ?? '';
  const initials = email ? email.slice(0, 2).toUpperCase() : '?';

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 200,
      background: '#fff', borderBottom: '1px solid #E8EFE9',
      padding: '0 24px', height: 56,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      {!isHome && (
        <a
          href="/"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8, border: '1.5px solid #C5D4C8',
            color: '#6B8C74', textDecoration: 'none', fontSize: 16, fontWeight: 700,
            background: '#F4F8F5', flexShrink: 0,
          }}
          title="Back to home"
        >
          ←
        </a>
      )}
      <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
        <img src={logo} alt="Spattoo" style={{ height: 28 }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: '#9BB5A2', letterSpacing: 1.5, textTransform: 'uppercase' }}>Admin</span>
      </a>

      {session && <NavMenu />}

      <div style={{ flex: 1 }} />

      {session && (
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: '#F4F8F5', border: '1.5px solid #C5D4C8',
              borderRadius: 20, padding: '5px 12px 5px 6px',
              cursor: 'pointer', fontFamily: "'Quicksand', sans-serif",
            }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: '#2C4433', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 800, flexShrink: 0,
            }}>
              {initials}
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email}
            </span>
            <span style={{ fontSize: 10, color: '#9BB5A2', marginLeft: 2 }}>▾</span>
          </button>

          {menuOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                onClick={() => setMenuOpen(false)}
              />
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: '#fff', border: '1.5px solid #C5D4C8',
                borderRadius: 12, boxShadow: '0 4px 20px rgba(44,68,51,0.12)',
                minWidth: 200, zIndex: 20, overflow: 'hidden',
              }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #E8EFE9' }}>
                  <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 2 }}>Signed in as</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#2C4433', wordBreak: 'break-all' }}>{email}</div>
                </div>
                <button
                  onClick={handleSignOut}
                  style={{
                    width: '100%', padding: '12px 16px', background: 'none',
                    border: 'none', textAlign: 'left', cursor: 'pointer',
                    fontSize: 13, fontWeight: 700, color: '#C0392B',
                    fontFamily: "'Quicksand', sans-serif",
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  Sign Out
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Router({ session }) {
  const path = window.location.pathname;
  const Screen = ROUTES[path];

  if (Screen) {
    const extraProps = {};

    if (path === '/templates/create') {
      extraProps.onSave = async ({ name, tierCount, designJson, thumbnailBlob }) => {
        let thumbnailKey = null;
        if (thumbnailBlob) {
          const filename = `${crypto.randomUUID()}.png`;
          const { url, key } = await getSignedUploadUrl('templates/thumbnails', filename, 'image/png');
          await uploadToR2(url, thumbnailBlob);
          thumbnailKey = key;
        }
        await createTemplate({
          name,
          tier_count:   tierCount,
          design:       designJson,
          thumbnail_url: thumbnailKey,
        });
      };
    }

    return (
      <>
        <AppHeader session={session} />
        <Suspense fallback={FALLBACK}>
          <Screen supabase={supabase} {...extraProps} />
        </Suspense>
      </>
    );
  }

  // Home dashboard
  return (
    <div style={{ minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif' }}>
      <AppHeader session={session} />
      <div style={{ padding: 40 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 8px' }}>Spattoo Admin</h1>
        <p style={{ fontSize: 14, color: '#5C7565', margin: 0 }}>Use the menu above to manage templates, elements, editors, bakers and more.</p>
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) return FALLBACK;
  if (!session) return <Login />;
  return <Router session={session} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
