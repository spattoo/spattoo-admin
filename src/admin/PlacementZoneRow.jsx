import { zoneShowsSeat } from '../lib/placementSeat.js';

// One zone's placement controls — a mode select plus, for a wall-hug zone (side/middle_tier),
// a seat-depth select (auto/proud/flush). Presentational: the parent owns state and passes the
// current mode/seat + change handlers, so AddElement (create) and ManageElements (edit) render
// the IDENTICAL row through their own wiring. The seat rule (which zones/modes show it) lives once
// in `zoneShowsSeat`. See spattoo-core PLACEMENT_CONFIG.md for what proud/flush mean.
export default function PlacementZoneRow({ zone, zoneLabel, mode, seat, modes, selectStyle, onModeChange, onSeatChange }) {
  const sel = { ...selectStyle, flex: 1 };
  return (
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
  );
}
