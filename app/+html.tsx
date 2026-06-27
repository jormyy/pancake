import { ScrollViewStyleReset } from 'expo-router/html'
import { type PropsWithChildren } from 'react'

// Root HTML document for the web build. Adds the PWA manifest, theme color,
// Apple install metadata, and registers the offline-shell service worker.
// Native is unaffected (this file is web-only).

const SW_REGISTER = `
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
`

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
                <meta
                    name="description"
                    content="Dynasty fantasy basketball — drafts, lineups, trades, waivers, and live scoring."
                />

                {/* PWA — theme-color matches the cream app surface so the installed
                    status bar blends with the header instead of an orange strip;
                    the body background prevents a white flash before first paint. */}
                <link rel="manifest" href="/manifest.webmanifest" />
                <meta name="theme-color" content="#FDF8EE" />
                <style dangerouslySetInnerHTML={{ __html: 'html,body,#root{background-color:#FDF8EE;}' }} />
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
