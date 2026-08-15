import { ScrollViewStyleReset } from 'expo-router/html'
import { type PropsWithChildren } from 'react'
import { webChrome } from '@/constants/tokens'

// Root HTML document for the web build. Adds the PWA manifest, theme color,
// Apple install metadata, and registers the offline-shell service worker.
// Native is unaffected (this file is web-only).

// Dev is excluded: Metro serves unhashed bundles, so the service worker's
// stale-while-revalidate would replay outdated module graphs after every edit
// ("Requiring unknown module"). Registration is a production-build concern only.
const SW_REGISTER = process.env.NODE_ENV === 'production' ? `
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').then(function (registration) {
      // Auto-update: re-check on every foreground so a backgrounded PWA picks
      // up new deploys, and reload once when the new worker takes control.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') registration.update().catch(function () {});
      });
      var reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }).catch(function () {});
  });
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
const SUPABASE_ORIGIN = process.env.EXPO_PUBLIC_SUPABASE_URL
    ? new URL(process.env.EXPO_PUBLIC_SUPABASE_URL).origin
    : 'https://ceeytbfmwsnzalxlkalc.supabase.co'

export default function Root({ children }: PropsWithChildren) {
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
                {/* Warm up the Supabase connection (DNS + TLS) before the first
                    auth/data request fires from the JS bundle. */}
                <link rel="preconnect" href={SUPABASE_ORIGIN} crossOrigin="anonymous" />
                <meta
                    name="description"
                    content="Dynasty fantasy basketball — drafts, lineups, trades, waivers, and live scoring."
                />

                {/* PWA — theme-color matches the cream app surface so the installed
                    status bar blends with the header instead of an orange strip;
                    the body background prevents a white flash before first paint. */}
                <link rel="manifest" href="/manifest.webmanifest" />
                <meta name="theme-color" content={webChrome.themeColor} />
                <style dangerouslySetInnerHTML={{ __html: webChrome.rootBackgroundCss }} />
                <style dangerouslySetInnerHTML={{ __html: 'input:focus,textarea:focus{outline:none;}' }} />
                <link rel="icon" href="/favicon.ico" />
                <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
                <meta name="mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-status-bar-style" content="default" />
                <meta name="apple-mobile-web-app-title" content="Pancake" />

                <ScrollViewStyleReset />
                <script dangerouslySetInnerHTML={{ __html: SW_REGISTER }} />
            </head>
            <body>{children}</body>
        </html>
    )
}
