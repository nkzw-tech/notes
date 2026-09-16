import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@nkzw/mdx-editor/styles.css';
import { loadWorkspace } from './documentApi.ts';
import './styles.css';

// Read disk and load the editor in parallel, then commit the complete UI once.
// The desktop preload starts its request even earlier, during navigation.
const [initial, { default: App }] = await Promise.all([
  loadWorkspace().then(
    (workspace) => ({ error: null, workspace }),
    (error: unknown) => ({
      error: error instanceof Error ? error.message : 'Failed to load documents.',
      workspace: undefined,
    }),
  ),
  import('./App.tsx'),
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialLoadError={initial.error} initialWorkspace={initial.workspace} />
  </StrictMode>,
);
