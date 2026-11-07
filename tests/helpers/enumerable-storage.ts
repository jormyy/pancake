export function enumerableStorage<T extends object>(storage: T, keys: () => string[], before?: () => void): T {
    return new Proxy(storage, {
        ownKeys: () => { before?.(); return keys() },
        getOwnPropertyDescriptor: (target, name) => typeof name === 'string' && keys().includes(name)
            ? { configurable: true, enumerable: true, writable: true, value: undefined }
            : Reflect.getOwnPropertyDescriptor(target, name),
    })
}
