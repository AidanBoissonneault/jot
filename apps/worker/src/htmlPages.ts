/**
 * @file Renders the worker's legal, OAuth completion, and YouTube embed HTML pages.
 * @author Aidan Boissonneault
 * @lastModified October 2026
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
    <p class="updated"><strong>Last updated</strong> October 13, 2026</p>
    <p>These Terms of Service are an agreement between you and Aidan Boissonneault, an individual doing business as Inkwell ("Inkwell," "we," or "us"). They apply to the Inkwell browser extension, its local note editor and capture features, the Inkwell demonstration website, and the hosted synchronization service (together, the "Service").</p>

    <h2>1. Accepting these Terms</h2>
    <p>By installing, accessing, or using the Service, you agree to these Terms and the <a href="/privacy">Privacy Policy</a>. You can use the extension locally without connecting Notion. Before starting a Notion connection, the extension asks you to confirm that you have read and agree to the current Terms and Privacy Policy. If you use Inkwell for an organization, you confirm that you have authority to accept these Terms for it. You must be legally able to enter into this agreement where you live; if you are not, a parent or legal guardian must review and accept these Terms for you and supervise your use where required by law.</p>

    <h2>2. What Inkwell does</h2>
    <p>Inkwell is a browser-based tool for saving selected web text with its source, organizing notes into projects and pages, editing those notes, and optionally syncing them to a Notion workspace you connect. The editor can also handle content you add, including links, images, audio, recordings, and supported Notion blocks. The extension stores local workspace data in your browser. When you connect Notion, Inkwell initially uploads your local workspace for synchronization; later edits can sync while online or after connectivity returns.</p>
    <p>The Service currently has no subscription or usage fee charged by Inkwell. You remain responsible for any fees charged by Notion, your browser or device provider, or your internet provider. We will present applicable terms before charging for any future paid Inkwell feature.</p>

    <h2>3. Your account and connected services</h2>
    <p>Inkwell sign-in uses Notion authorization. You are responsible for the Notion account you connect, the workspace and parent pages you select, and keeping your browser profile and devices secure. Your use of Notion is also subject to Notion's own terms, privacy policy, availability, and API limits. Inkwell does not control Notion and cannot guarantee that a Notion feature or API will remain available or behave consistently.</p>
    <p>Settings let you change the synchronization server address. Use only a server you control or trust. A server address you choose receives the authentication information and content sent to it for syncing. If another person or organization operates that server, its terms and privacy practices apply to your use of it; we do not operate or control it.</p>

    <h2>4. Your content and responsibilities</h2>
    <p>"Your Content" means the notes, project information, captured passages, source details, links, images, audio, recordings, and other material that you create, capture, or add to Inkwell. As between you and Inkwell, you keep your rights in Your Content. You give us permission to store, process, transmit, convert, and display Your Content only as needed to provide, secure, and maintain features that you use, including syncing content to the Notion workspace or synchronization server you selected. This limited permission ends when the content is no longer needed for those purposes, subject to the retention and deletion details in the Privacy Policy and technical copies needed to finish pending operations.
    </p>
    <p>You are responsible for Your Content and for making sure you have the rights, permissions, and consents needed to collect, record, store, and sync it. Respect copyright, privacy, confidentiality, and the terms of the websites and services you use. Do not record or capture another person's private information or voice without any consent required by law. Keep separate copies of material that matters to you; Inkwell is not a guaranteed backup service.</p>

    <h2>5. Acceptable use</h2>
    <p>Use the Service only as permitted by law and these Terms. You must not use it to violate another person's rights, distribute unlawful or malicious material, interfere with or overload the Service or a third-party service, probe or bypass security controls, misuse credentials or rate limits, or attempt to gain unauthorized access. You must not reverse engineer or redistribute the Service except to the extent applicable law permits or these Terms allow. We may restrict or suspend access when reasonably needed to address a breach, security issue, legal requirement, or risk to the Service or its users.</p>

    <h2>6. Local data, synchronization, and deletion</h2>
    <p>Local-only notes are stored in your browser profile. Browser storage failures, clearing browser data, removing the extension, device loss, or device failure may make local content unavailable or remove it. Sync is asynchronous and can be delayed, fail, or produce conflicts, duplicates, or incomplete results. Notion may not support every block or media format in the same way as the Inkwell editor. Review important changes in both places and keep your own backups.</p>
    <p>Logging out ends the current Inkwell session and attempts to revoke Inkwell's Notion access; it leaves local documents and queued edits in that browser. <strong>Delete connection</strong> in Settings deletes Inkwell account and sync data from our server and, after server confirmation, removes Inkwell documents and storage from the browser where you take that action. It does not delete pages already written to Notion or local copies on your other browsers or devices. Uninstalling the extension is not the same as deleting your Inkwell server data. See the <a href="/privacy">Privacy Policy</a> for the detailed deletion and retention behavior.</p>

    <h2>7. Inkwell software and intellectual property</h2>
    <p>Inkwell and its software, name, design, and other materials are owned by or licensed to the operator and are protected by applicable intellectual property laws. Subject to these Terms, we grant you a personal, non-exclusive, non-transferable, revocable license to install and use the extension and website for your own personal or internal business use. This license does not transfer ownership to you. Do not sell, rent, sublicense, or distribute the Service or remove its proprietary notices.</p>

    <h2>8. Changes, suspension, and ending use</h2>
    <p>You may stop using Inkwell at any time. We may change, pause, or discontinue all or part of the Service, and may suspend or end access for the reasons described in these Terms. We will post revised Terms on this page and update the date above. If a material change requires notice or renewed consent under applicable law, we will take the required steps. If these Terms end, the permissions granted to use the Service end; the provisions about ownership, disclaimers, liability, and disputes continue to apply as needed to give them effect.</p>

    <h2>9. Disclaimer of warranties</h2>
    <p>To the fullest extent permitted by law, the Service is provided "as is" and "as available." We do not promise that it will be uninterrupted, secure, compatible with every website or Notion feature, error-free, or that data will always sync, remain available, or be preserved. You decide whether the Service is suitable for your needs. Nothing in these Terms removes a warranty or right that applicable law does not allow us to exclude.</p>

    <h2>10. Limitation of liability</h2>
    <p>To the fullest extent permitted by law, Inkwell and its operator will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue, goodwill, business opportunities, or data, arising from or related to the Service or these Terms, even if advised that such loss could occur. Nothing in these Terms excludes or limits liability or a consumer right that applicable law does not allow to exclude or limit.</p>

    <h2>11. Governing law and disputes</h2>
    <p>These Terms are governed by the laws of Ontario and the applicable federal laws of Canada, without regard to conflict-of-law rules. The courts located in Ontario, Canada will have jurisdiction over disputes relating to these Terms or the Service, except where applicable law gives you the right to bring a claim elsewhere or provides rights that cannot be waived.</p>

    <h2>12. Privacy and contact</h2>
    <p>The <a href="/privacy">Privacy Policy</a> explains how Inkwell handles information, including local storage, optional synchronization, and deletion. For questions about these Terms or the Service, contact Aidan Boissonneault at <a href="mailto:support@byaidan.com">support@byaidan.com</a>.</p>`;
}

/**
 * Defines the public Privacy Policy content.
 * @returns Trusted policy HTML fragment.
 */
export function privacyBody(): string {
  return `
    <h1>Privacy Policy</h1>
    <p class="updated"><strong>Last updated</strong> September 30, 2026</p>
    <p>This Privacy Policy explains how Inkwell collects, uses, stores, and shares information when you use the Inkwell browser extension and sync service.</p>
    <h2>Information Inkwell Handles</h2><ul>
      <li>Notion account and workspace information returned during Notion OAuth, such as account identifiers, name, email address, workspace ID, and workspace name.</li>
      <li>Authentication and session metadata required to keep you logged in, including an HTTP-only browser session cookie, its server-side hash, IP address, user agent, and token expiry metadata.</li>
      <li>User-generated content you create or sync, including notes, highlights, page titles, source links, project metadata, images, audio, and other media you choose to add.</li>
      <li>Website content and browsing-related data you intentionally capture with the extension, such as selected text, source URLs, page titles, and highlight context.</li>
      <li>Synchronization metadata needed to map local Inkwell content to Notion pages, blocks, databases, and file uploads.</li>
    </ul>
    <h2>How Information Is Used</h2><p>Inkwell uses this information to authenticate with Notion, create and update your Inkwell workspace structure, synchronize content across devices, upload or refresh media, detect sync conflicts, provide user-facing capture features, prevent abuse, and maintain service security.</p>
    <h2>Sharing</h2><p>Inkwell shares user data with Notion only as needed to provide the sync features you request. Inkwell uses Supabase and Cloudflare infrastructure to store and process authentication, session, and synchronization data. If you configure a custom sync server, that server receives your Inkwell authentication data and any content you sync to it; review its operator's privacy and security practices. Inkwell does not sell user data and does not use user data for personalized advertising.</p>
    <h2>Local Storage</h2><p>The extension stores local projects, pages, pending sync operations, server configuration, a non-secret account identifier used to keep retained documents bound to their original Notion account, and legal acceptance metadata in browser storage and IndexedDB on your device. The extension does not store Notion access or refresh tokens; those credentials are kept in server-side storage while connected.</p>
    <h2>Security</h2><p>Inkwell transmits data using HTTPS in production and stores authentication tokens in server-side storage. You should keep your browser profile, device, and Notion account secure.</p>
    <h2>Chrome Web Store Limited Use</h2><p>The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.</p>
    <h2>Your Choices</h2><p>Logging out in the extension signs you out, asks Notion to revoke its access token, and removes Inkwell's stored Notion access and refresh tokens and active session. Local documents and queued edits remain in this browser and stay bound to their original Notion account. If server cleanup cannot be confirmed, the extension reports that result.</p>
    <p>Delete connection in Settings removes the Inkwell account, sync data, and queued cloud payloads from Inkwell's server. After the server confirms deletion, the extension removes local Inkwell documents and storage from this browser. Pages already stored in Notion remain. Local copies on other browsers or devices are not remotely erased by this action and must be removed on those devices. Inkwell retains a minimal deletion receipt containing a one-way request hash, completion state, revocation result, and timestamps so an interrupted deletion can be retried; the receipt does not retain the account ID or document content.</p>
    <p>You can also revoke Inkwell access from your Notion workspace settings.</p>
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
