import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Cloudflare Turnstile widget — the shared captcha for admin auth (currently just the login).
// Mirror of spattoo-web's apps/app/components/Captcha.tsx (same cross-repo mirror pattern as the
// password policy). Enforcement is Supabase-native: when captcha is enabled in the Supabase
// dashboard, signInWithPassword requires a valid Turnstile token in options.captchaToken. This
// widget produces that token; Supabase verifies it server-side (we hold no secret).
//
// Config-driven / feature-flagged: renders nothing unless VITE_TURNSTILE_SITE_KEY is set, so with
// no key the whole thing is a no-op (login behaves exactly as before). The secret key lives ONLY
// in the Supabase dashboard.

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

// True when a site key is configured — the caller gates its submit button on this so an
// unconfigured build never blocks login waiting for a token that will never come.
export const captchaConfigured = !!SITE_KEY;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// Load the Turnstile script exactly once for the whole app.
let scriptPromise = null;
function loadTurnstile() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.appendChild(el);
  });
  return scriptPromise;
}

// The admin login card is light, so the widget defaults to the light Turnstile theme.
// Exposes reset() via ref — the caller resets after a failed submit because Turnstile tokens are
// SINGLE-USE and expire (~5 min), so a retry needs a fresh token.
export const Captcha = forwardRef(function Captcha({ onVerify, onExpire, theme = 'light', style }, ref) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
    },
  }), []);

  useEffect(() => {
    if (!captchaConfigured) return undefined;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          theme,
          // Invisible for the common silent pass — the widget only renders when Turnstile actually
          // needs the user to solve a challenge (no confusing "Success!" box before any input).
          appearance: 'interaction-only',
          callback: (token) => onVerifyRef.current(token),
          'expired-callback': () => onExpireRef.current && onExpireRef.current(),
          'error-callback': () => onExpireRef.current && onExpireRef.current(),
        });
      })
      .catch(() => {
        // Script blocked / offline: leave the widget empty. The caller's submit stays gated on
        // captchaConfigured, so this surfaces as "can't get a token" rather than a silent bypass.
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already gone */ }
        widgetIdRef.current = null;
      }
    };
  }, [theme]);

  if (!captchaConfigured) return null;
  return <div ref={containerRef} style={style} />;
});
