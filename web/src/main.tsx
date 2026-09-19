import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import App from './App'
import { markNativeShell } from './lib/nativeShell'
import { markBrowserSupport, ensureBraveMarked } from './lib/browserSupport'
import { refreshFormFactorClasses } from './lib/platform'
import './index.css'
import './studio-ui.css'
import './desktop-remaster.css'
import './orion-apk-studio.css'
import './orion-brave.css'
import './platform-shell.css'

markNativeShell()
markBrowserSupport()
void ensureBraveMarked()
if (typeof document !== 'undefined' && !document.documentElement.classList.contains('orion-native')) {
  try {
    if (Capacitor.getPlatform() === 'android' || Capacitor.getPlatform() === 'ios') {
      document.documentElement.classList.add('orion-native')
      document.body?.classList.add('orion-native')
    }
  } catch {
    /* ignore */
  }
}

if (typeof window !== 'undefined') {
  let formResizeTimer: number | undefined
  window.addEventListener('resize', () => {
    window.clearTimeout(formResizeTimer)
    formResizeTimer = window.setTimeout(() => refreshFormFactorClasses(), 180)
  })
  window.addEventListener('orientationchange', () => {
    window.setTimeout(() => refreshFormFactorClasses(), 120)
  })
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }

  static getDerivedStateFromError(e: Error) {
    return { err: e }
  }

  render() {
    if (this.state.err) {
      return (
        <div className="fatal-wrap">
          <div className="card elevate fatal-card">
            <h1 style={{ marginTop: 0 }}>Something broke</h1>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>
              Fix the cause below or hard-refresh after changing <code>.env</code>.
            </p>
            <pre className="err-block">{this.state.err.message}</pre>
            <button
              type="button"
              className="primary"
              onClick={() => {
                window.location.replace('/home')
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RootErrorBoundary>
  </React.StrictMode>,
)

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/orion-sw.js').catch((error) => {
      console.warn('[Orion Social] service worker registration failed', error)
    })
  })
}
