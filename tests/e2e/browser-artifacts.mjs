import path from 'node:path'
export const browserArtifactPath = (...parts) => path.join(process.env.E2E_BROWSER_ARTIFACT_DIR ?? path.join(process.cwd(), 'tests'), ...parts)
