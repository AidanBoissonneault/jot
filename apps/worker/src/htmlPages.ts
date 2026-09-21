/**
 * @file Renders the worker's legal, OAuth completion, and YouTube embed HTML pages.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

/**
 * Renders a sandbox-friendly page containing a YouTube iframe.
 * @param embedUrl - Validated YouTube embed URL.
 * @returns Complete HTML document.
 */
export function youtubeEmbedPage(embedUrl: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube video</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #111113; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe
    src="${escapeHtml(embedUrl)}"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen></iframe>
</body>
</html>`;
}

/**
 * Wraps policy content in the shared legal-document layout.
 * @param title - Browser and document title.
 * @param body - Trusted policy HTML.
 * @returns Complete HTML document.
 */
export function legalPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Inkwell</title><style>
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #fafafa; color: #171717; } main { width: min(100% - 32px, 920px); margin: 0 auto; padding: 48px 0; }
article { padding: clamp(28px, 5vw, 56px); border: 1px solid #e7e5e4; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px rgba(0,0,0,.06); line-height: 1.7; }
h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.05; } h2 { margin: 32px 0 10px; font-size: 1.3rem; line-height: 1.25; }
p, li { color: #44403c; } a { color: #1d4ed8; text-decoration: none; overflow-wrap: anywhere; } a:hover { text-decoration: underline; }
ul { padding-left: 1.35rem; } .updated { margin: 0 0 28px; color: #78716c; }
</style></head><body><main><article>${body}</article></main></body></html>`;
}

/**
 * Defines the public Terms of Service content.
 * @returns Trusted policy HTML fragment.
 */
export function termsBody(): string {
  return `
    <h1>Terms of Service</h1>
    <p class="updated"><strong>Last updated</strong> May 09, 2026</p>
    <p>These Terms of Service govern your access to and use of Inkwell, a browser-based note-taking and content capture tool operated by Aidan Boissonneault, doing business as Inkwell.</p>
    <h2>Use of the Service</h2><p>Inkwell lets users collect, organize, edit, and sync notes, highlights, project content, and uploaded media with connected Notion workspaces. You may use the service only for lawful purposes and in compliance with these terms.</p>
    <h2>Notion and Third-Party Services</h2><p>Inkwell relies on third-party services, including Notion, to provide sync, storage, and workspace features. Some functionality may be unavailable, delayed, or interrupted due to third-party outages, API limits, network issues, or synchronization conflicts.</p>
    <h2>User Content</h2><p>You are responsible for the notes, highlights, media, and other content you create or sync through Inkwell. You retain ownership of your content. You grant Inkwell the limited permission needed to process, store, transmit, and synchronize that content to provide the service.</p>
    <h2>Accounts and Security</h2><p>You are responsible for maintaining control of your browser profile, Notion account, and devices used with Inkwell. Do not misuse, disrupt, reverse engineer, or attempt to bypass access restrictions, rate limits, or security protections.</p>
    <h2>Availability and Disclaimer</h2><p>The service is provided as-is and as-available. Inkwell does not guarantee that synchronization will always be uninterrupted or error-free. Users should review important changes and maintain backups of critical content.</p>
    <h2>Privacy</h2><p>Your use of Inkwell is also governed by the <a href="/privacy">Privacy Policy</a>, which explains how Inkwell collects, uses, stores, and shares user data.</p>
    <h2>Contact</h2><p>Questions about these terms can be sent to <a href="mailto:support@byaidan.com">support@byaidan.com</a>.</p>`;
}

/**
 * Defines the public Privacy Policy content.
 * @returns Trusted policy HTML fragment.
 */
export function privacyBody(): string {
  return `
    <h1>Privacy Policy</h1>
    <p class="updated"><strong>Last updated</strong> May 13, 2026</p>
    <p>This Privacy Policy explains how Inkwell collects, uses, stores, and shares information when you use the Inkwell browser extension and sync service.</p>
    <h2>Information Inkwell Handles</h2><ul>
      <li>Notion account and workspace information returned during Notion OAuth, such as account identifiers, name, email address, workspace ID, and workspace name.</li>
      <li>Authentication and session metadata required to keep you logged in, including session tokens, IP address, user agent, and token expiry metadata.</li>
      <li>User-generated content you create or sync, including notes, highlights, page titles, source links, project metadata, images, audio, and other media you choose to add.</li>
      <li>Website content and browsing-related data you intentionally capture with the extension, such as selected text, source URLs, page titles, and highlight context.</li>
      <li>Synchronization metadata needed to map local Inkwell content to Notion pages, blocks, databases, and file uploads.</li>
    </ul>
    <h2>How Information Is Used</h2><p>Inkwell uses this information to authenticate with Notion, create and update your Inkwell workspace structure, synchronize content across devices, upload or refresh media, detect sync conflicts, provide user-facing capture features, prevent abuse, and maintain service security.</p>
    <h2>Sharing</h2><p>Inkwell shares user data with Notion only as needed to provide the sync features you request. Inkwell uses Supabase and Cloudflare infrastructure to store and process authentication, session, and synchronization data. Inkwell does not sell user data and does not use user data for personalized advertising.</p>
    <h2>Local Storage</h2><p>The extension stores local projects, pages, pending sync operations, server configuration, and legal acceptance metadata in browser storage and IndexedDB on your device.</p>
    <h2>Security</h2><p>Inkwell transmits data using HTTPS in production and stores authentication tokens in server-side storage. You should keep your browser profile, device, and Notion account secure.</p>
    <h2>Chrome Web Store Limited Use</h2><p>The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.</p>
    <h2>Your Choices</h2><p>You can disconnect Notion from Inkwell by logging out in the extension. You can also revoke access from your Notion workspace settings and remove local extension data through your browser.</p>
    <h2>Contact</h2><p>Questions about this policy can be sent to <a href="mailto:support@byaidan.com">support@byaidan.com</a>.</p>`;
}

/**
 * Renders an OAuth completion page that closes itself.
 * @param message - User-facing completion message.
 * @returns Complete HTML document.
 */
export function closePage(message: string): string {
  return `<!doctype html><html><body><p>${escapeHtml(message)}</p><script>setTimeout(() => window.close(), 900)</script></body></html>`;
}

/**
 * Escapes text before insertion into HTML content or attributes.
 * @param value - Untrusted text value.
 * @returns HTML-safe text.
 */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
