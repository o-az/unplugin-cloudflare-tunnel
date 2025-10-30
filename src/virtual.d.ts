/**
 * Type definitions for virtual:unplugin-cloudflare-tunnel
 *
 * This virtual module is provided by unplugin-cloudflare-tunnel
 * and is only available during development mode.
 */

declare module 'virtual:unplugin-cloudflare-tunnel' {
  /**
   * Get the current tunnel URL.
   *
   * Returns the active Cloudflare tunnel URL for the current development session.
   * - In quick tunnel mode: Returns a random `https://xyz.trycloudflare.com` URL
   * - In named tunnel mode: Returns your custom domain URL (e.g., `https://dev.example.com`)
   *
   * The URL is automatically updated if the local port changes or the tunnel is restarted.
   *
   * @returns The current tunnel URL as a string
   *
   * @example
   * ```typescript
   * import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel';
   *
   * // Get the tunnel URL
   * const tunnelUrl = getTunnelUrl();
   * console.log('Public tunnel URL:', tunnelUrl);
   *
   * // Use in your app
   * const shareButton = document.getElementById('share');
   * shareButton.onclick = () => {
   *   navigator.clipboard.writeText(getTunnelUrl());
   *   alert('Tunnel URL copied to clipboard!');
   * };
   * ```
   *
   * @note This function is only available during development mode.
   * In production builds, this virtual module will not be available.
   */
  export function getTunnelUrl(): string
}
