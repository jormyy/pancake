import { webChrome } from '@/constants/tokens'

/**
 * The web Appearance setting. Light is the default; "system" follows the
 * device. The choice lives on this device only, like the device's own setting.
 * The theme CSS keys off `data-theme` on <html>, so changing it repaints at once.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'pancake-theme'
export const DEFAULT_THEME: ThemePreference = 'light'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function isThemePreference(value: unknown): value is ThemePreference {
    return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * Runs in <head> before first paint, so a saved dark choice never flashes
 * light. It also keeps the browser bar color in step when the device switches
 * while the choice is "system".
 */
export const THEME_BOOT_SCRIPT = `(function(){
var d=document.documentElement,p=${JSON.stringify(DEFAULT_THEME)};
try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==='dark'||s==='system')p=s}catch(e){}
d.setAttribute('data-theme',p);
var mq=window.matchMedia?window.matchMedia(${JSON.stringify(DARK_QUERY)}):null;
function sync(){var t=d.getAttribute('data-theme'),dark=t==='dark'||(t==='system'&&!!mq&&mq.matches),m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',dark?${JSON.stringify(webChrome.themeColorDark)}:${JSON.stringify(webChrome.themeColor)})}
sync();
if(mq&&mq.addEventListener)mq.addEventListener('change',sync);
})();`

export function readThemePreference(): ThemePreference {
    if (typeof document === 'undefined') return DEFAULT_THEME
    const current = document.documentElement.getAttribute('data-theme')
    return isThemePreference(current) ? current : DEFAULT_THEME
}

export function setThemePreference(preference: ThemePreference): void {
    if (typeof document === 'undefined') return
    try {
        localStorage.setItem(THEME_STORAGE_KEY, preference)
    } catch {
        // Private mode or blocked storage: the choice still applies until reload.
    }
    document.documentElement.setAttribute('data-theme', preference)
    const dark = preference === 'dark'
        || (preference === 'system' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches)
    document.querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? webChrome.themeColorDark : webChrome.themeColor)
}
