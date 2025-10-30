import './style.css'
import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'

const app = document.querySelector('div#app')

// Simple status checker
function updateStatus() {
  const statusElement = app?.querySelector('p#status')
  const tunnelUrlElement = app?.querySelector('span#tunnel-url')
  if (!statusElement || !tunnelUrlElement) return

  try {
    // Get the tunnel URL from the virtual module
    const tunnelUrl = getTunnelUrl()

    // Check if we can detect we're running through Cloudflare
    const isCloudflare =
      document.location.hostname !== 'localhost' &&
      document.location.hostname !== '127.0.0.1'

    if (isCloudflare) {
      statusElement.textContent = '🟢 Connected via Cloudflare Tunnel'
      tunnelUrlElement.textContent = tunnelUrl
      statusElement.style.color = 'green'

      // Show copy button for sharing
      const copyBtn = app?.querySelector('button#copy-url')
      if (copyBtn) {
        copyBtn.style.display = 'inline-block'
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(tunnelUrl)
          alert('Tunnel URL copied to clipboard!')
        }
      }
    } else {
      statusElement.textContent =
        '🟡 Running locally (tunnel may be starting...)'
      statusElement.style.color = 'orange'
      tunnelUrlElement.textContent = tunnelUrl || 'Tunnel starting...'
    }

    console.log('🌐 Tunnel URL from virtual module:', tunnelUrl)
  } catch (error) {
    // Virtual module not available (probably in production)
    statusElement.textContent = '🔴 Virtual module not available'
    statusElement.style.color = 'red'
    console.warn('Virtual module not available:', error)
    statusElement.style.color = 'red'
  }
}

// Add refresh functionality
app?.querySelector('button#refresh')?.addEventListener('click', () => {
  updateStatus()
  console.log('Status refreshed at:', new Date().toLocaleTimeString())
})

// Update status on page load
updateStatus()

// Log some helpful info
console.log('🌐 Unplugin Cloudflare Tunnel Example')
console.log('Current URL:', window.location.href)
console.log('User Agent:', navigator.userAgent)

// Add some interactivity
let clickCount = 0
document.addEventListener('click', () => {
  clickCount++
  if (clickCount === 10) {
    alert('🎉 You clicked 10 times! The tunnel is working great!')
    clickCount = 0
  }
})
