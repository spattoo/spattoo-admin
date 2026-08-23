import React from 'react';
import { createRoot } from 'react-dom/client';
import StripeFrostingStudio from './admin/StripeFrostingStudio.jsx';

// Mounts the studio and nothing else — no app shell, no Supabase client, so this page never asks for
// credentials. See bands.html for why that matters.
createRoot(document.getElementById('root')).render(<StripeFrostingStudio />);
