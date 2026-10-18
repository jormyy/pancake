import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useWebPushNotifications } from '../../hooks/use-web-push-notifications'
import { disableWebPush, enableWebPush } from '../../lib/web-push'

function Probe() {
    useWebPushNotifications()
    useEffect(() => { Object.assign(window, { pushProbeReady: true }) }, [])
    return null
}
Object.assign(window, { pushProbe: { enable: enableWebPush, disable: disableWebPush } })
createRoot(document.getElementById('root')!).render(createElement(Probe))
