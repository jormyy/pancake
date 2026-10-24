import { ScrollViewStyleReset } from 'expo-router/html'
import { usePathname } from 'expo-router'
import { type PropsWithChildren } from 'react'
import { colors, fontFamily, shadows, webChrome } from '@/constants/tokens'
import { Asset } from 'expo-asset'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { FontDisplay, useFonts } from 'expo-font'
import { criticalFonts } from '@/constants/fonts'
import { BOOT_SHELL_CSS, BOOT_SHELL_HTML, BOOT_SHELL_SCRIPT } from '@/constants/boot-shell'
import { THEME_BOOT_SCRIPT } from '@/lib/theme-preference'
import { AUTH_SCAFFOLD_CSS } from '@/components/auth/authScaffoldCss'
import { AuthDocumentForm } from '@/components/auth/AuthDocumentForm'

// Root HTML document for the web build. Adds the PWA manifest, theme color,
// Apple install metadata, and registers the offline-shell service worker.
// Native is unaffected (this file is web-only).

// Dev is excluded: Metro serves unhashed bundles, so the service worker's
// stale-while-revalidate would replay outdated module graphs after every edit
// ("Requiring unknown module"). Registration is a production-build concern only.
const SW_REGISTER = process.env.NODE_ENV === 'production' ? `
if ('serviceWorker' in navigator && window.isSecureContext) {
  (function () {
    var documentVersion = document.querySelector?.('meta[name="pancake-release"]')?.content;
    var workerVersionKey = 'pancake-sw-worker-version';
    var pendingVersion = null;
    var workerReconciled = !documentVersion;
    var reloaded = false;
    var assetMissed = false;
    var noticeTimer = null;
    var registration = null;
    var observation = 0;
    var lastCheck = 0;
    var checking = null;
    var held = function () { return !!window.__pancakePwaHolds?.size; };
    var showNotice = function () {
      noticeTimer = null;
      if (!pendingVersion || reloaded || document.getElementById('pancake-update-notice')) return;
      var notice = document.createElement('div');
      notice.id = 'pancake-update-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;bottom:80px;left:16px;right:16px;z-index:10000;padding:16px;border-radius:12px;background:${colors.bgCard};color:${colors.textPrimary};box-shadow:${shadows.lg};font:14px system-ui';
      notice.textContent = 'An update is ready. Finish your current work, then reload.';
      var button = document.createElement('button');
      button.textContent = 'Reload';
      button.disabled = held();
      button.style.cssText = 'margin-left:12px;padding:8px 12px;font:inherit';
      button.addEventListener('click', function () { tryReload(true); });
      notice.appendChild(button);
      document.body.appendChild(notice);
    };
    var tryReload = function (manual, leaving) {
      if (!pendingVersion || reloaded) return;
      if (!workerReconciled || held() || document.readyState === 'loading' || document.readyState === 'interactive' ||
          (!manual && !leaving && !assetMissed && document.visibilityState !== 'hidden') ||
          (manual && document.visibilityState === 'hidden') || navigator.onLine === false) {
        if (assetMissed && held()) showNotice();
        else if (!noticeTimer) noticeTimer = setTimeout(showNotice, 60000);
        return;
      }
      try {
        var key = 'pancake-update-reload:' + window.location.pathname;
        if (!manual && sessionStorage.getItem(key) === pendingVersion) { showNotice(); return; }
        sessionStorage.setItem(key, pendingVersion);
      } catch { return; }
      reloaded = true;
      if (noticeTimer) clearTimeout(noticeTimer);
      window.location.reload();
    };
    var observeWorkerVersion = function (worker) {
      if (!worker) return;
      var currentObservation = ++observation;
      var channel = new MessageChannel();
      var settled = false;
      var finish = function (version) {
        if (settled) return;
        settled = true;
        channel.port1.close();
        if (!version || reloaded || currentObservation !== observation ||
            (navigator.serviceWorker.controller && worker !== navigator.serviceWorker.controller)) return;
        var previous;
        try {
          previous = sessionStorage.getItem(workerVersionKey);
          sessionStorage.setItem(workerVersionKey, version);
        } catch { return; }
        if ((documentVersion || previous) === version || (!documentVersion && !previous)) {
          pendingVersion = null;
          if (noticeTimer) clearTimeout(noticeTimer);
          noticeTimer = null;
          return;
        }
        pendingVersion = version;
        if (!workerReconciled) checkForUpdate(true);
        tryReload(false);
      };
      channel.port1.onmessage = function (event) { finish(event.data && event.data.version); };
      worker.postMessage({ type: 'PANCAKE_WORKER_VERSION' }, [channel.port2]);
      setTimeout(function () { finish(null); }, 10000);
    };
    var checkForUpdate = function (force) {
      if (!registration || navigator.onLine === false || checking ||
          (!force && Date.now() - lastCheck < 300000)) return;
      lastCheck = Date.now();
      checking = registration.update().catch(function () {}).finally(function () {
        checking = null;
        if (!registration.installing && !registration.waiting) workerReconciled = true;
        observeWorkerVersion(navigator.serviceWorker.controller || registration.active);
      });
    };
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      workerReconciled = true;
      observeWorkerVersion(navigator.serviceWorker.controller);
    });
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data?.type === 'PANCAKE_ASSET_MISS') {
        assetMissed = true;
        checkForUpdate(true);
        tryReload(false);
      }
    });
    window.addEventListener('pancake-pwa-hold-change', function () {
      var button = document.getElementById('pancake-update-notice')?.querySelector('button');
      if (button) button.disabled = held();
      tryReload(false);
    });
    window.addEventListener('online', function () { checkForUpdate(false); tryReload(false); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkForUpdate(false);
      else tryReload(false);
    });
    window.addEventListener('pagehide', function () { tryReload(false, true); });
    var failedChunk = function (event) {
      var message = String(event.reason?.message || event.message || '');
      if (/Loading chunk|ChunkLoadError|dynamically imported module|Importing a module script failed|Loading module .* failed|AsyncRequireError/.test(message)) {
        assetMissed = true;
        checkForUpdate(true);
        tryReload(false);
      }
    };
    window.addEventListener('error', failedChunk);
    window.addEventListener('unhandledrejection', failedChunk);
    if (documentVersion) observeWorkerVersion(navigator.serviceWorker.controller);
    window.addEventListener('load', function () {
      tryReload(false);
      navigator.serviceWorker.register('/sw.js').then(function (value) {
        registration = value;
        lastCheck = Date.now();
        if (pendingVersion && !workerReconciled) checkForUpdate(true);
        else observeWorkerVersion(navigator.serviceWorker.controller || registration.active);
        setInterval(function () {
          if (document.visibilityState === 'visible') checkForUpdate(false);
        }, 60 * 60 * 1000);
      }).catch(function () {});
    });
  })();
}
` : `
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (rs) {
    rs.forEach(function (r) { r.unregister() });
  });
}
`

// Inlined at build time by Expo's static export; fall back to the production
// project so the preconnect never renders an empty href.
// Focus rings are for keyboard users. A mouse or finger tap marks the page so
// the ring stays hidden; the next key press brings it back.
const POINTER_FOCUS_SCRIPT = `
(function () {
  var root = document.documentElement;
  addEventListener('pointerdown', function () { root.setAttribute('data-pointer', ''); }, true);
  addEventListener('keydown', function (event) {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) root.removeAttribute('data-pointer');
  }, true);
})();
`
const FOCUS_CSS = 'input:focus,textarea:focus{outline:none;}html[data-pointer] :focus{outline:none;}'
const SHELL_GEOMETRY_CSS = `.pbs-side .pbs-league{height:68px;flex-shrink:0}.pbs-side .pbs-league-name{font-family:${fontFamily.displayMedium};line-height:18px}.pbs-side .pbs-league-meta{line-height:14px}.pbs-brand-title{font-family:${fontFamily.display}}`
const documentFonts = {
    ...criticalFonts,
    ...Object.fromEntries(Object.entries(MaterialIcons.font).map(([name, uri]) => [name, { uri, display: FontDisplay.BLOCK }])),
}

const SUPABASE_ORIGIN = process.env.EXPO_PUBLIC_SUPABASE_URL
    ? new URL(process.env.EXPO_PUBLIC_SUPABASE_URL).origin
    : 'https://ceeytbfmwsnzalxlkalc.supabase.co'

export default function Root({ children }: PropsWithChildren) {
    useFonts(documentFonts)
    const pathname = usePathname()
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
                />
                <title>Pancake</title>
                {Object.entries(documentFonts).map(([name, source]) => (
                    <link key={name} rel="preload" href={Asset.fromModule(source.uri).uri} as="font" type="font/woff2" crossOrigin="anonymous" />
                ))}
                <meta name="pancake-release" content="pancake-build" />
                {/* Warm up the Supabase connection (DNS + TLS) before the first
                    auth/data request fires from the JS bundle. */}
                <link rel="preconnect" href={SUPABASE_ORIGIN} crossOrigin="anonymous" />
                <meta
                    name="description"
                    content="Dynasty fantasy basketball — drafts, lineups, trades, waivers, and live scoring."
                />

                {/* PWA — theme-color matches the app surface in each theme so the
                    installed status bar blends with the header; the body background
                    prevents a white flash before first paint. */}
                <link rel="manifest" href="/manifest.webmanifest" />
                <meta name="color-scheme" content="light dark" />
                <meta name="theme-color" content={webChrome.themeColor} />
                {/* Applies the saved Appearance choice before first paint. */}
                <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
                <style dangerouslySetInnerHTML={{ __html: webChrome.rootBackgroundCss }} />
                {/* Paints the real app chrome from static HTML, before the JS
                    bundle mounts React. Removed by WebAppShell on mount. */}
                <style dangerouslySetInnerHTML={{ __html: BOOT_SHELL_CSS }} />
                <style dangerouslySetInnerHTML={{ __html: SHELL_GEOMETRY_CSS }} />
                <style dangerouslySetInnerHTML={{ __html: AUTH_SCAFFOLD_CSS }} />
                <style dangerouslySetInnerHTML={{ __html: FOCUS_CSS }} />
                <script dangerouslySetInnerHTML={{ __html: POINTER_FOCUS_SCRIPT }} />
                <link rel="icon" href="/favicon.ico" />
                <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
                <meta name="mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-status-bar-style" content="default" />
                <meta name="apple-mobile-web-app-title" content="Pancake" />

                <ScrollViewStyleReset />
                <script dangerouslySetInnerHTML={{ __html: SW_REGISTER }} />
            </head>
            <body>
                <div dangerouslySetInnerHTML={{ __html: BOOT_SHELL_HTML }} />
                <script dangerouslySetInnerHTML={{ __html: BOOT_SHELL_SCRIPT }} />
                <AuthDocumentForm pathname={pathname} />
                {children}
            </body>
        </html>
    )
}
