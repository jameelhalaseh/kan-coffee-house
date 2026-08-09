import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initMonitoring, reportError } from './monitoring';

initMonitoring();

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
    reportError(error, { componentStack: info && info.componentStack });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0f1117', color: '#e6e6e6', fontFamily: "'DM Sans', system-ui, sans-serif", padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: '#9aa0aa', marginBottom: 20, maxWidth: 480 }}>
            The app hit an unexpected error. Your saved data is safe. Reload to continue.
          </div>
          <pre style={{ fontSize: 11, color: '#ff6b6b', background: '#1a1c25', padding: 12, borderRadius: 8, maxWidth: 600, overflow: 'auto', marginBottom: 20 }}>
            {String(this.state.error && (this.state.error.message || this.state.error))}
          </pre>
          <button onClick={() => window.location.reload()} style={{ padding: '11px 24px', borderRadius: 9, border: 'none', background: '#f0a830', color: '#0f1117', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register((process.env.PUBLIC_URL || '') + '/sw.js')
      .catch((e) => console.warn('SW registration failed:', e));
  });
}