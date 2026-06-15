import React, { lazy, Suspense, useState, useEffect } from 'react';
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
const ElementTypes     = lazy(() => import('./admin/ElementTypes.jsx'));
const ManageElements   = lazy(() => import('./admin/ManageElements.jsx'));
const ManageFlavours        = lazy(() => import('./admin/ManageFlavours.jsx'));
const ManagePlans           = lazy(() => import('./admin/ManagePlans.jsx'));
const ManageTags            = lazy(() => import('./admin/ManageTags.jsx'));
const ManageNozzles         = lazy(() => import('./admin/ManageNozzles.jsx'));
const BakerSubscriptions    = lazy(() => import('./admin/BakerSubscriptions.jsx'));
const PatternBuilder        = lazy(() => import('./admin/PatternBuilder.jsx'));
const PipingCalibrator      = lazy(() => import('./admin/PipingCalibrator.jsx'));
const CreamPenStudio        = lazy(() => import('./admin/CreamPenStudio.jsx'));
const FreehandPenStudio     = lazy(() => import('./admin/FreehandPenStudio.jsx'));
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
  '/elements/types':      ElementTypes,
  '/elements/tags':       ManageTags,
  '/elements/nozzles':    ManageNozzles,
  '/bakers/onboard':      OnboardBaker,
  '/bakers/subscriptions': BakerSubscriptions,
  '/flavours':            ManageFlavours,
  '/plans':               ManagePlans,
  '/pattern-builder':     PatternBuilder,
  '/elements/piping-calibrator': PipingCalibrator,
  '/elements/cream-pen':         CreamPenStudio,
  '/elements/freehand-pen':      FreehandPenStudio,
};

const FALLBACK = (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', color: '#9b5f72' }}>
    Loading…
  </div>
);

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
      <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flex: 1 }}>
        <img src={logo} alt="Spattoo" style={{ height: 28 }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: '#9BB5A2', letterSpacing: 1.5, textTransform: 'uppercase' }}>Admin</span>
      </a>

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
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12, padding: 0, maxWidth: 320 }}>
          {[
            { href: '/templates',         label: 'Manage Templates' },
            { href: '/templates/design',  label: 'Design Template' },
            { href: '/elements/add',      label: 'Add Element' },
            { href: '/elements/manage',   label: 'Manage Elements' },
            { href: '/elements/generate', label: 'Generate Shape' },
            { href: '/elements/generate-model', label: 'Generate 3D Model' },
            { href: '/glb-studio', label: 'GLB Studio' },
            { href: '/glb-recompose', label: 'GLB Recompose' },
            { href: '/elements/types',    label: 'Element Types' },
            { href: '/elements/nozzles',  label: 'Nozzle Catalog' },
            { href: '/bakers/onboard',        label: 'Onboard Baker' },
            { href: '/bakers/subscriptions',  label: 'Baker Subscriptions' },
            { href: '/plans',                 label: 'Subscription Plans' },
            { href: '/flavours',              label: 'Cake Flavours' },
            { href: '/pattern-builder',       label: 'Pattern Builder' },
            { href: '/elements/piping-calibrator', label: 'Calibrator' },
            { href: '/elements/cream-pen',         label: 'Cream Pen' },
            { href: '/elements/freehand-pen',      label: 'Freehand Pen' },
          ].map(({ href, label }) => (
            <li key={href}>
              <a href={href} style={{ display: 'block', padding: '14px 20px', background: '#fff', borderRadius: 12, border: '1.5px solid #C5D4C8', color: '#2C4433', fontWeight: 700, textDecoration: 'none', fontSize: 14 }}>
                {label}
              </a>
            </li>
          ))}
        </ul>
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
