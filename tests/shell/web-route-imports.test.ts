import { fileURLToPath, URL } from 'node:url'
import { transformSync } from '@babel/core'
import { getRewriteRequestUrl } from '@expo/metro-config/build/rewriteRequestUrl'
import { expoRouterBabelPlugin } from 'babel-preset-expo/build/expo-router-plugin'
import { expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

function routeImportMode(development: boolean) {
    const request = getRewriteRequestUrl(projectRoot)(
        `http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=web&dev=${development}`,
    )
    const options = new URL(request).searchParams
    const caller = {
        name: 'metro',
        platform: 'web',
        isDev: development,
        projectRoot,
        routerRoot: options.get('transform.routerRoot') ?? 'app',
        asyncRoutes: options.get('transform.asyncRoutes') === 'true',
    }
    return transformSync('process.env.EXPO_ROUTER_IMPORT_MODE;', {
        configFile: false,
        babelrc: false,
        plugins: [expoRouterBabelPlugin],
        caller,
    })?.code
}

it('keeps production routes lazy', () => {
    expect(routeImportMode(false)).toBe('"lazy";')
})

it('keeps development routes lazy', () => {
    expect(routeImportMode(true)).toBe('"lazy";')
})
