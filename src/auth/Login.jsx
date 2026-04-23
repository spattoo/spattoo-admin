import { useState } from 'react';
import { supabase } from '../lib/supabase.js';
import logo from '../images/spattoo-green.png';

const s = {
  page: {
    minHeight: '100vh', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: '#EDEAE2',
    fontFamily: "'Quicksand', sans-serif",
  },
  card: {
    background: '#fff', borderRadius: 16,
    border: '1.5px solid #C5D4C8',
    padding: 40, width: '100%', maxWidth: 380,
  },
  logo: {
    display: 'block', width: 180, margin: '0 auto 8px',
  },
  subtitle: {
    fontSize: 12, color: '#6B8C74', textAlign: 'center', marginBottom: 28,
    fontWeight: 600, letterSpacing: 0.5,
  },
  field: { marginBottom: 16 },
  label: {
    display: 'block', fontSize: 11, fontWeight: 700,
    color: '#3D5A44', letterSpacing: 1,
    textTransform: 'uppercase', marginBottom: 6,
  },
  input: {
    width: '100%', padding: '10px 12px',
    border: '1.5px solid #C5D4C8', borderRadius: 8,
    fontSize: 13, fontFamily: "'Quicksand', sans-serif",
    color: '#2C4433', outline: 'none', boxSizing: 'border-box',
  },
  btn: {
    width: '100%', padding: '11px 0', borderRadius: 10,
    cursor: 'pointer', border: 'none', fontSize: 14, fontWeight: 700,
    fontFamily: "'Quicksand', sans-serif",
    background: '#3D5A44', color: '#fff', marginTop: 8,
  },
  error: {
    fontSize: 12, color: '#c00', textAlign: 'center',
    marginTop: 12, fontWeight: 600,
  },
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  }

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={s.page}>
        <div style={s.card}>
          <img src={logo} alt="Spattoo" style={s.logo} />
          <div style={s.subtitle}>Admin Portal</div>
          <form onSubmit={handleLogin}>
            <div style={s.field}>
              <label style={s.label}>Email</label>
              <input
                style={s.input}
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@spattoo.com"
                required
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Password</label>
              <input
                style={s.input}
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <button style={{ ...s.btn, opacity: loading ? 0.6 : 1 }} disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
            {error && <div style={s.error}>{error}</div>}
          </form>
        </div>
      </div>
    </>
  );
}
