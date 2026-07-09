export type FunctionLifecycleEvent =
    | { type: 'create'; key: string; definition: string }
    | { type: 'drop'; key: string }

export function dollarQuotedStatement(source: string): string
export function functionLifecycleEventsInSource(source: string): FunctionLifecycleEvent[]
export function latestFunctionDefinitions(): Promise<Map<string, string>>
export function latestFunctionDefinition(schema: string, name: string): Promise<string>
export function checkFunctionSources(): Promise<string[]>
