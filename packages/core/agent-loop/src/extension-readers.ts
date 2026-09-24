/** Required external record readers folded from the native Session log. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

type RequiredReaders = Record<string, number[]>

/** Host-only projection used before recovery and every model step. */
export const extensionReadersProjectionDefinition = {
  key: 'extensionReaders',
  stateVersion: 1,
  stateSchema: z.record(z.string(), z.array(z.number().int().positive())),
  init: (): RequiredReaders => ({}),
  apply(state: RequiredReaders, event) {
    if (event.type !== 'extension/record') return state
    const { namespace, schemaVersion, recordId, kind } = event.data
    if (!namespace.trim() || !recordId.trim() || !kind.trim()
      || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error(`invalid extension record at session seq ${event.seq}`)
    }
    const versions = state[namespace] ?? []
    if (versions.includes(schemaVersion)) return state
    return { ...state, [namespace]: [...versions, schemaVersion] }
  },
} satisfies ProjectionDefinition<'extensionReaders', RequiredReaders>
