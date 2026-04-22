import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { supabase } from './lib/supabase.js';

const CreateTemplate = lazy(() =>
  import('@spattoo/designer').then(m => ({ default: m.CreateTemplate }))
);

const ROUTES = {
  '/templates/create': CreateTemplate,
};

const FALLBACK = (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', color: '#9b5f72' }}>
    Loading…
  </div>
);

function Router() {
  const path = window.location.pathname;
  const Screen = ROUTES[path];

  if (Screen) {
    return (
      <Suspense fallback={FALLBACK}>
        <Screen supabase={supabase} />
      </Suspense>
    );
  }

  return (
    <div style={{ padding: 40, fontFamily: 'Quicksand, sans-serif' }}>
      <h2 style={{ color: '#6b2d42', marginBottom: 24 }}>Spattoo Admin</h2>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <li><a href="/templates/create" style={{ color: '#9b5f72', fontWeight: 700 }}>Create Template</a></li>
      </ul>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>
);
