import React, { lazy, Suspense, useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { supabase } from './lib/supabase.js';
import Login from './auth/Login.jsx';
import logo from './images/spattoo-green.png';

const CreateTemplate = lazy(() =>
  import('@spattoo/designer').then(m => ({ default: m.CreateTemplate }))
);
const AddElement = lazy(() => import('./admin/AddElement.jsx'));

const ROUTES = {
  '/templates/create': CreateTemplate,
  '/elements/add':     AddElement,
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
    <div style={{ minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif' }}>
      <div style={{ padding: '24px 40px', background: '#fff', borderBottom: '1.5px solid #C5D4C8', display: 'flex', alignItems: 'center', gap: 16 }}>
        <img src={logo} alt="Spattoo" style={{ height: 36 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase' }}>Admin</span>
      </div>
      <div style={{ padding: 40 }}>
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12, padding: 0, maxWidth: 320 }}>
          <li>
            <a href="/templates/create" style={{ display: 'block', padding: '14px 20px', background: '#fff', borderRadius: 12, border: '1.5px solid #C5D4C8', color: '#2C4433', fontWeight: 700, textDecoration: 'none', fontSize: 14 }}>
              Create Template
            </a>
          </li>
          <li>
            <a href="/elements/add" style={{ display: 'block', padding: '14px 20px', background: '#fff', borderRadius: 12, border: '1.5px solid #C5D4C8', color: '#2C4433', fontWeight: 700, textDecoration: 'none', fontSize: 14 }}>
              Add Element
            </a>
          </li>
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
  return <Router />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
