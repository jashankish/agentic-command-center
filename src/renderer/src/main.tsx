import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import FeedWindow from './components/FeedWindow'
import TerminalsWindow from './components/TerminalsWindow'
import './styles.css'
import { initTooltips } from './lib/tooltip'

initTooltips()

// Docked panel windows load this same bundle with a location hash and mount
// only their surface; everything else is the full command center.
const surface =
  window.location.hash === '#feed' ? (
    <FeedWindow />
  ) : window.location.hash === '#terminals' ? (
    <TerminalsWindow />
  ) : (
    <App />
  )

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{surface}</React.StrictMode>
)
