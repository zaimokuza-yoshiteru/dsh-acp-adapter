import { parentPort, workerData } from 'node:worker_threads'
import { readDevinHistory, type DevinHistoryScope } from './devin-live-history.ts'

if (parentPort === null) throw new Error('Devin history collector requires its bounded worker')
parentPort.postMessage(readDevinHistory(workerData as DevinHistoryScope))
