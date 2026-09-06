import { useState, useEffect, useCallback } from 'react';
import { getLegalPreview, publishLegalVersion } from '../lib/api.js';

// Publishing a legal document version.
//
// THE PROBLEM THIS SOLVES: legal text is authored in git and rendered by the marketing site, but the
// evidence a consent record points at lives in the API's legal_document_versions table. Those are
// two stores and a deploy updates only the first. Privacy v1.1 shipped to the website while the
// database still held v1.0 — so the site showed the analytics disclosure while the in-app modal
// served the older text saying the opposite, and nothing anywhere reported the split.
//
// Until now the only fix was running scripts/publish-legal-version.mjs by hand, passing every
// {{TOKEN}} on the command line. That works and is easy to get subtly wrong: a mistyped token or a
// stale --version freezes a document that does not match the page, and a wrong hash stays invisible
// until somebody disputes a consent.
//
// So this screen never asks anyone to type the text. The API fetches the site's own canonical bytes
// server-side and this publishes exactly those. What you can get wrong is reduced to one decision:
// whether to publish at all.
//
// ⚠️ `content-rights` is deliberately absent. It is authored in the API repo, not on the marketing
// site, so it has no page to read from — it is still published with the script.

const DOCS = [
  { key: 'tos', label: 'Terms of Service' },
  { key: 'privacy', label: 'Privacy Policy' },
  { key: 'refund', label: 'Refund & Cancellation' },
  { key: 'grievance', label: 'Grievance & Contact' },
];

const C = {
  ink: '#2C4433', muted: '#5C7565', faint: '#9BB5A2', line: '#C5D4C8', page: '#EDEAE2',
  okInk: '#065F46', okBg: '#D1FAE5',
  warnInk: '#92400E', warnBg: '#FEF3C7',
  alarmInk: '#991B1B', alarmBg: '#FEE2E2',
};

function Badge({ ink, bg, children }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: bg, color: ink, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

// One row's state, reduced to the single question the screen answers.
function statusOf(p) {
  if (!p) return { key: 'loading', label: 'Checking…', ink: C.muted, bg: C.page };
  if (p.fetchError || !p.site) return { key: 'unreachable', label: 'Site unreachable', ink: C.alarmInk, bg: C.alarmBg };
  if (!p.published) return { key: 'never', label: 'Never published', ink: C.alarmInk, bg: C.alarmBg };
  if (p.inSync) return { key: 'synced', label: 'In sync', ink: C.okInk, bg: C.okBg };
  return { key: 'drift', label: 'Needs publishing', ink: C.warnInk, bg: C.warnBg };
}

export default function LegalVersions() {
  const [previews, setPreviews] = useState({});
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const loadOne = useCallback(async (key) => {
    try {
      const p = await getLegalPreview(key);
      setPreviews((prev) => ({ ...prev, [key]: p }));
    } catch (e) {
      setPreviews((prev) => ({ ...prev, [key]: { docKey: key, fetchError: e.message || 'Failed to load' } }));
    }
  }, []);

  useEffect(() => { DOCS.forEach((d) => loadOne(d.key)); }, [loadOne]);

  const publish = async (key) => {
    const p = previews[key];
    if (!p?.site) return;
    setBusy(key);
    setNote(null);
    try {
      const res = await publishLegalVersion({
        docKey: key,
        version: p.site.version,
        effectiveAt: p.site.effectiveAtIso,
        content: p.site.content,
        contentHash: p.site.contentHash,
      });
      setNote({ kind: 'ok', text: `Published ${key} v${res.version}. It is now the current version.` });
      await loadOne(key);
    } catch (e) {
      setNote({ kind: 'err', text: e.message || 'Publish failed.' });
    } finally {
      setBusy(null);
    }
  };

  const drifting = DOCS.filter((d) => statusOf(previews[d.key]).key === 'drift' || statusOf(previews[d.key]).key === 'never').length;
  const allLoaded = DOCS.every((d) => previews[d.key]);

  return (
    <div style={{ minHeight: '100vh', background: C.page, fontFamily: "'Quicksand', sans-serif", padding: '28px 20px 60px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: C.ink, margin: '0 0 4px' }}>Legal Versions</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 20px', lineHeight: 1.5 }}>
          Publishing a document freezes the exact text the website is serving, so a consent record can
          point at it. Deploying the website does <strong>not</strong> do this &mdash; it is a separate act.
        </p>

        {allLoaded && (
          <div style={{
            background: drifting ? C.warnBg : C.okBg, color: drifting ? C.warnInk : C.okInk,
            borderRadius: 12, padding: '14px 18px', marginBottom: 18, fontSize: 14, fontWeight: 700, lineHeight: 1.5,
          }}>
            {drifting === 0
              ? 'Every document on the website matches what is frozen in the database.'
              : `${drifting} document${drifting === 1 ? '' : 's'} on the website ${drifting === 1 ? 'does' : 'do'} not match what is frozen in the database.`}
          </div>
        )}

        {note && (
          <div style={{
            background: note.kind === 'ok' ? C.okBg : C.alarmBg, color: note.kind === 'ok' ? C.okInk : C.alarmInk,
            borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13, fontWeight: 600,
          }}>
            {note.text}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {DOCS.map((d) => {
            const p = previews[d.key];
            const st = statusOf(p);
            const isOpen = open === d.key;
            const canPublish = p?.site?.publishable && !p.inSync && p.site.effectiveAtIso && p.site.contentHash;

            return (
              <div key={d.key} style={{ background: '#fff', borderRadius: 14, border: `1px solid ${C.line}`, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{d.label}</div>
                    <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>
                      Website <strong>v{p?.site?.version ?? '—'}</strong>
                      {'   ·   '}
                      Frozen <strong>v{p?.published?.version ?? 'none'}</strong>
                    </div>
                  </div>
                  <Badge ink={st.ink} bg={st.bg}>{st.label}</Badge>
                  <button
                    onClick={() => setOpen(isOpen ? null : d.key)}
                    style={{
                      padding: '7px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                      fontFamily: "'Quicksand', sans-serif", minHeight: 36,
                      border: `1.5px solid ${C.line}`, background: '#fff', color: C.muted,
                    }}
                  >
                    {isOpen ? 'Hide text' : 'Review'}
                  </button>
                </div>

                {isOpen && (
                  <div style={{ borderTop: `1px solid ${C.page}`, padding: '14px 16px', background: '#FCFBF8' }}>
                    {p?.fetchError && (
                      <p style={{ fontSize: 12, color: C.alarmInk, margin: '0 0 10px' }}>
                        Could not read the website: {p.fetchError}
                      </p>
                    )}
                    {p?.site?.unresolvedTokens?.length > 0 && (
                      <p style={{ fontSize: 12, color: C.alarmInk, margin: '0 0 10px', fontWeight: 700 }}>
                        Not publishable &mdash; unfilled placeholders: {p.site.unresolvedTokens.join(', ')}
                      </p>
                    )}
                    {p?.site && (
                      <>
                        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, lineHeight: 1.7 }}>
                          Effective <strong>{p.site.effectiveDate}</strong> ({p.site.effectiveAtIso ?? 'unparseable date'})
                          {' · '}{p.site.bytes} bytes
                          <br />
                          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: C.faint }}>
                            website sha256 {String(p.site.contentHash).slice(0, 24)}…
                          </span>
                          {p.published && (
                            <>
                              <br />
                              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: C.faint }}>
                                frozen  sha256 {String(p.published.contentHash).slice(0, 24)}…
                              </span>
                            </>
                          )}
                        </div>
                        {/* The exact bytes that will be frozen — shown, never edited. An editable box
                            here would reintroduce the retyping this screen exists to remove. */}
                        <pre style={{
                          margin: 0, maxHeight: 300, overflow: 'auto', background: '#fff',
                          border: `1px solid ${C.line}`, borderRadius: 10, padding: 12,
                          fontSize: 11, lineHeight: 1.6, color: C.ink, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        }}>
                          {p.site.content}
                        </pre>
                        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button
                            onClick={() => publish(d.key)}
                            disabled={!canPublish || busy === d.key}
                            style={{
                              padding: '9px 18px', borderRadius: 20, fontSize: 13, fontWeight: 700,
                              fontFamily: "'Quicksand', sans-serif", minHeight: 40,
                              border: 'none', color: '#fff',
                              background: canPublish ? C.ink : C.faint,
                              cursor: canPublish && busy !== d.key ? 'pointer' : 'not-allowed',
                            }}
                          >
                            {busy === d.key ? 'Publishing…' : `Publish v${p.site.version}`}
                          </button>
                          <span style={{ fontSize: 11, color: C.muted }}>
                            {p.inSync
                              ? 'Already frozen — nothing to publish.'
                              : canPublish
                                ? 'Freezes exactly the text above. Immutable once written.'
                                : 'Not publishable yet.'}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 11, color: C.faint, margin: '16px 2px 0', lineHeight: 1.6 }}>
          A version is immutable once published: re-publishing the same version number with different
          text is refused. To change a published document, bump its version in the marketing repo and
          deploy, then publish here. The content-rights attestation is authored in the API repo and is
          still published with <code>scripts/publish-legal-version.mjs</code>.
        </p>
      </div>
    </div>
  );
}
