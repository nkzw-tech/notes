import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@nkzw/mdx-editor/styles.css';
import App from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
