export type FunctionLifecycleEvent =
    | { type: 'create'; key: string; identityKey: string; definition: string; start: number; end: number }
    | { type: 'drop'; key: string; identityKey: string; start: number; end: number }

export function dollarQuotedStatement(source: string): string
export function functionLifecycleEventsInSource(source: string): FunctionLifecycleEvent[]
export function functionIdentityArguments(source: string, openIndex: number, maskedSource?: string): string[]
export function latestFunctionDefinitions(): Promise<Map<string, string>>
export function latestFunctionDefinition(schema: string, name: string): Promise<string>
export function checkFunctionSources(): Promise<string[]>
