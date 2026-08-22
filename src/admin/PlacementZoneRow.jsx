import { zoneShowsSeat, zoneShowsInsert, zoneShowsFullRing, zoneAltMode } from '../lib/placementSeat.js';

// One zone's placement controls — a mode (position) select plus, for a wall-hug zone
// (side/middle_tier), a seat-depth select (auto/proud/flush), plus an INSERT modifier (base sunk into
// the surface at an angle) for the upright poses (stand/hug). Presentational: the parent owns state
// and passes the current mode/seat/insert + change handlers, so AddElement (create) and
// ManageElements (edit) render the IDENTICAL row through their own wiring. Which zones/modes show
// each control lives once in `zoneShowsSeat` / `zoneShowsInsert`. `insert` is null (off) or an object
// of params (on; {} = on with defaults). See spattoo-core PLACEMENT_CONFIG.md for the semantics.
export default function PlacementZoneRow({ zone, zoneLabel, mode, seat, insert, fullRing, alt, modes, selectStyle, inputStyle, onModeChange, onSeatChange, onInsertToggle, onInsertField, onFullRingToggle, onAltToggle }) {
  const sel = { ...selectStyle, flex: 1 };
  const num = { ...inputStyle, flex: 1 };
  const showInsert = zoneShowsInsert(mode);
  const insertOn = insert != null;
  // The other pose this surface could offer, or null. Only flat surfaces, only stand <-> hug.
  const altMode = zoneAltMode(zone, mode);
  const ALT_WORD = { stand: 'stand up', hug: 'lie flat' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>{zoneLabel}</span>
        <select style={sel} value={mode} onChange={e => onModeChange(e.target.value)}>
          {modes.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {zoneShowsSeat(zone, mode) && (
          <select style={sel} value={seat ?? 'auto'} title="How a solid piece sits against the wall"
            onChange={e => onSeatChange(e.target.value)}>
            <option value="auto">seat: auto (default)</option>
            <option value="proud">seat: proud (stands off wall)</option>
            <option value="flush">seat: flush (into wall)</option>
          </select>
        )}
      </div>
      {altMode && onAltToggle && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 110, fontSize: 12, fontWeight: 600, color: '#2C4433', cursor: 'pointer' }}
          title="The customer picks the pose per decoration. The mode above stays the default.">
          <input type="checkbox" checked={alt === altMode} onChange={e => onAltToggle(e.target.checked ? altMode : null)} />
          Let the customer also {ALT_WORD[altMode] ?? altMode} it here
        </label>
      )}
      {zoneShowsFullRing(zone) && onFullRingToggle && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 110, fontSize: 12, fontWeight: 600, color: '#2C4433', cursor: 'pointer' }}
          title="Repeat this decoration all the way around the perimeter, keeping its real materials">
          <input type="checkbox" checked={!!fullRing} onChange={e => onFullRingToggle(e.target.checked)} />
          Show full ring (repeat around the {zoneLabel.toLowerCase()})
        </label>
      )}
      {showInsert && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 110 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: '#2C4433', cursor: 'pointer' }}>
            <input type="checkbox" checked={insertOn}
              onChange={e => onInsertToggle(e.target.checked)} />
            Insert base into surface (buried, angled)
          </label>
          {insertOn && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" min="0" max="1" step="0.05" style={num} value={insert?.depth ?? ''}
                placeholder="depth 0–1 (blank = default)"
                onChange={e => onInsertField('depth', e.target.value)} />
              <input type="number" min="-89" max="89" step="1" style={num} value={insert?.lean_deg ?? ''}
                placeholder="lean° (blank = 0)"
                onChange={e => onInsertField('lean_deg', e.target.value)} />
              <input type="number" min="0" max="89" step="1" style={num} value={insert?.jitter_deg ?? ''}
                placeholder="jitter° (blank = 0)"
                onChange={e => onInsertField('jitter_deg', e.target.value)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
