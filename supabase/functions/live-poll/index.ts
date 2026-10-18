import { serveInternal } from '../_shared/serve.ts'
import { runLivePoll } from './runner.ts'

serveInternal('live-poll', runLivePoll)
