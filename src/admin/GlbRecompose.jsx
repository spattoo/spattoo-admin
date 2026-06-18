import RecomposeEditor from './RecomposeEditor.jsx';

// GLB Recompose screen — split a single fused mesh into recolourable parts.
// This is now a thin wrapper: all behaviour lives in the shared <RecomposeEditor>
// (also used by the image→3D wizard). With no importSlot prop, the editor renders
// its default file-picker, so this screen behaves exactly as before the refactor.
export default function GlbRecompose() {
  return <RecomposeEditor />;
}
