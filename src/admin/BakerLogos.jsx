import { useCallback, useEffect, useState } from 'react';
import { getBakerLogos, reencodeBakerLogo } from '../lib/api.js';

// ── Baker logos ──────────────────────────────────────────────────────────────────────────────────
// "Which bakers' logos are too heavy, and make them lighter."
//
// This replaced a scripts/*.mjs backfill. Sandeep: *"instead of making these mjs files and adding
// these env keys always, admin already has them. why dont we make it part of admin, so this can be
// used in future also"* — which is the same rule as every POC landing in the menu rather than in a
// chat message. A script is a thing you run once and then cannot find.
//
// ⚠️ THE HEAVY ROWS ARE THE CONTENT, so heaviest first — the same decision StorefrontUsage makes by
// putting the quietest shops on top. A list in name order buries exactly what this is opened for.
//
// ── WHY A LOGO IS EVER HEAVY ────────────────────────────────────────────────────────────────────
// The cut-out used to be written as lossless WebP whatever was in it. That is correct for a flat
// wordmark — crisp edges, and small anyway — and wrong for a rendered emblem, because lossless
// cannot compress continuous tone. One real logo reached 237,718 bytes for a mark that draws 52px
// tall; on a throttled phone it was 23% of a cold template load. The encoder now tries both and
// keeps the smaller, so new uploads are fine and this screen is for the ones already stored.
//
// ⚠️ A RE-ENCODE IS LOSSY, ON SOMEBODY'S BRAND. So nothing is written until the result has been
// looked at: "Check" shows the new image beside the original at the size it is stored AND at the
// size it is drawn, and only then does Apply appear. INVARIANTS #11 — the control and what it
// changes are on screen together.

const C = {
  ink: '#2C4433',
  muted: '#5C7565',
  faint: '#9BB5A2',
  line: '#C5D4C8',
  page: '#EDEAE2',
  card: '#FFFFFF',
  okInk: '#065F46',
  okBg: '#D1FAE5',
  warnInk: '#92400E',
  warnBg: '#FEF3C7',
  alarmInk: '#991B1B',
  alarmBg: '#FEE2E2',
};

// The box a logo is actually drawn in, across every surface — the settings preview tile and the
// storefront header are both this, and nothing draws one larger. Shown beside the stored image
// because "238 KB" means nothing until you see how small the thing on screen is.
const DRAWN_W = 312, DRAWN_H = 52;

// Under this, a logo is not worth anyone's attention. Roughly where a well-encoded emblem lands.
const HEAVY = 80 * 1024;

const kb = n => (n == null ? '—' : `${(n / 1024).toFixed(0)} KB`);

function Badge({ ink, bg, children }) {
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                        background: bg, color: ink, whiteSpace: 'nowrap' }}>{children}</span>;
}

function Button({ onClick, disabled, busy, tone = 'plain', children }) {
  const tones = {
    plain:   { bg: '#fff',    fg: C.ink,  border: C.line },
    primary: { bg: '#2C4433', fg: '#fff', border: '#2C4433' },
  };
  const t = tones[tone];
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy}
      style={{
        appearance: 'none', font: 'inherit', fontSize: 12.5, fontWeight: 700,
        padding: '8px 14px', borderRadius: 10, cursor: disabled || busy ? 'default' : 'pointer',
        background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
        opacity: disabled || busy ? 0.5 : 1, whiteSpace: 'nowrap',
      }}>
      {busy ? 'Working…' : children}
    </button>
  );
}

// Original and result, at both sizes that matter. Stored size answers "did the encoder damage it";
// drawn size answers "would a baker ever see the difference" — and the honest answer is almost
// always no, which is the thing a reviewer needs to be able to check for themselves.
function Comparison({ beforeUrl, afterUrl, before, after }) {
  const pane = (label, src, bytes) => (
    <div style={{ flex: '1 1 260px', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 6 }}>
        {label} · {kb(bytes)}
      </div>
      <div style={{ background: C.page, border: `1px solid ${C.line}`, borderRadius: 10,
                    padding: 10, display: 'grid', placeItems: 'center', minHeight: 150 }}>
        <img src={src} alt={label} style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain', display: 'block' }} />
      </div>
      <div style={{ fontSize: 11, color: C.faint, margin: '8px 0 4px' }}>As drawn ({DRAWN_W}×{DRAWN_H})</div>
      <div style={{ background: '#fff', border: `1px dashed ${C.line}`, borderRadius: 8,
                    width: '100%', maxWidth: DRAWN_W, height: DRAWN_H, display: 'grid',
                    placeItems: 'center', overflow: 'hidden' }}>
        <img src={src} alt="" style={{ maxHeight: DRAWN_H - 8, maxWidth: '96%', objectFit: 'contain', display: 'block' }} />
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 14 }}>
      {pane('Now', beforeUrl, before)}
      {pane('After re-encoding', afterUrl, after)}
    </div>
  );
}

function Row({ row, onChanged }) {
  const [checked, setChecked] = useState(null);   // the dry-run result
  const [busy, setBusy]       = useState('');
  const [error, setError]     = useState('');
  const [done, setDone]       = useState(null);

  const current = done ?? row;
  const heavy = (current.bytes ?? 0) >= HEAVY;

  async function check() {
    setBusy('check'); setError('');
    try {
      setChecked(await reencodeBakerLogo(row.bakerId, { preview: true }));
    } catch (e) {
      setError(e.message || 'Could not check this logo.');
    } finally { setBusy(''); }
  }

  async function apply() {
    setBusy('apply'); setError('');
    try {
      const out = await reencodeBakerLogo(row.bakerId, { apply: true });
      // The URL changes, because applying mints a new key — so read the new one back rather than
      // re-rendering the old src, which would show the old bytes from cache and look like nothing
      // happened.
      setDone({ ...row, bytes: out.after, url: out.url ?? row.url });
      setChecked(null);
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not re-encode this logo.');
    } finally { setBusy(''); }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14,
                  padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ width: 56, height: 56, borderRadius: 10, background: C.page,
                      border: `1px solid ${C.line}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          {current.url
            ? <img src={current.url} alt="" style={{ maxWidth: 48, maxHeight: 48, objectFit: 'contain', display: 'block' }} />
            : <span style={{ fontSize: 10, color: C.faint }}>none</span>}
        </div>

        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, overflowWrap: 'break-word' }}>
            {row.name || row.bakerId}
          </div>
          <div style={{ fontSize: 11, color: C.faint, marginTop: 3, overflowWrap: 'anywhere' }}>{current.key}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {row.missing
            ? <Badge ink={C.alarmInk} bg={C.alarmBg}>Object missing</Badge>
            : <Badge ink={heavy ? C.warnInk : C.okInk} bg={heavy ? C.warnBg : C.okBg}>{kb(current.bytes)}</Badge>}
          {!row.immutable && !row.missing && <Badge ink={C.warnInk} bg={C.warnBg}>Not cached</Badge>}
          {done && <Badge ink={C.okInk} bg={C.okBg}>Re-encoded</Badge>}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!row.missing && !done && (
            <Button onClick={check} busy={busy === 'check'}>Check</Button>
          )}
          {checked && !checked.alreadyOptimal && (
            <Button tone="primary" onClick={apply} busy={busy === 'apply'}>
              Apply · save {kb(checked.before - checked.after)}
            </Button>
          )}
        </div>
      </div>

      {error && <div style={{ marginTop: 10, fontSize: 12, color: C.alarmInk }}>{error}</div>}

      {checked?.alreadyOptimal && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: C.muted }}>
          Already as small as it goes — this one is a flat mark, and lossless is genuinely its best
          encoding. Nothing to do.
        </div>
      )}

      {checked && !checked.alreadyOptimal && (
        <>
          <div style={{ marginTop: 12, fontSize: 12.5, color: C.muted }}>
            {kb(checked.before)} → <strong style={{ color: C.ink }}>{kb(checked.after)}</strong>
            {' '}({Math.round(checked.saving * 100)}% smaller), {checked.width}×{checked.height}.
            Nothing has been written yet.
          </div>
          <Comparison beforeUrl={current.url} afterUrl={checked.previewDataUrl}
                      before={checked.before} after={checked.after} />
        </>
      )}
    </div>
  );
}

export default function BakerLogos() {
  const [data, setData]       = useState(null);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setData(await getBakerLogos());
    } catch (e) {
      setError(e.message || 'Could not load baker logos.');
      setData(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const heavy = (data?.rows ?? []).filter(r => (r.bytes ?? 0) >= HEAVY).length;

  return (
    <div style={{ padding: '22px 16px 60px', maxWidth: 940, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: C.ink, margin: '0 0 6px' }}>Baker Logos</h1>
      <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, margin: '0 0 18px', maxWidth: 620 }}>
        What each baker's cut-out logo weighs, heaviest first. A logo is downloaded on every cold
        app load, and it is drawn at {DRAWN_W}×{DRAWN_H} — so a heavy one is paid for and never
        seen. Check a logo to see what re-encoding would do before anything is written.
      </p>

      {loading && <div style={{ fontSize: 13, color: C.muted }}>Loading…</div>}
      {error && <div style={{ fontSize: 13, color: C.alarmInk }}>{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, fontSize: 12.5, color: C.muted }}>
            <Badge ink={C.ink} bg="#fff">{data.summary.logos} logos</Badge>
            <Badge ink={C.ink} bg="#fff">{kb(data.summary.bytes)} total</Badge>
            {heavy > 0 && <Badge ink={C.warnInk} bg={C.warnBg}>{heavy} over {kb(HEAVY)}</Badge>}
            {data.summary.missing > 0 && <Badge ink={C.alarmInk} bg={C.alarmBg}>{data.summary.missing} missing</Badge>}
          </div>

          {data.rows.length === 0
            ? <div style={{ fontSize: 13, color: C.muted }}>No baker has a cut-out logo yet.</div>
            : data.rows.map(r => <Row key={r.bakerId} row={r} onChanged={load} />)}
        </>
      )}
    </div>
  );
}
