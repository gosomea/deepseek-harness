import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  }
})

async function host(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

it('reopens extension records only when a compatible reader is present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extension-readers-'))
  roots.push(root)
  const id = SessionId('controlled-session')
  const first = await host(root, new MockAdapter([]))
  first.agents.registerSessionControlReader('example', [1])
  const { agent } = await first.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  agent.session.append('extension/record', {
    namespace: 'example', schemaVersion: 1, recordId: 'record-1', kind: 'task-created', payload: { objective: 'test' },
  })
  await first.sessionPersistence.flush()
  await first.fiber.dispose()
  contexts.splice(contexts.indexOf(first), 1)

  const second = await host(root, new MockAdapter([textResponse('resumed')]))
  await expect(second.agents.resume({ resumeSessionId: id })).rejects.toThrow('requires a compatible "example" extension reader')
  expect(second.sessions.get(id)).toBeUndefined()
  const incompatible = second.agents.registerSessionControlReader('example', [2])
  await expect(second.agents.resume({ resumeSessionId: id })).rejects.toThrow('requires a compatible "example" extension reader')
  await incompatible()
  const unregister = second.agents.registerSessionControlReader('example', [1])
  const restored = await second.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  await restored.agent.whenIdle()
  expect(restored.agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
  await unregister()
})

it('refuses the next model step after a required reader unloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extension-readers-'))
  roots.push(root)
  const adapter = new MockAdapter([textResponse('must not run')])
  const ctx = await host(root, adapter)
  const unregister = ctx.agents.registerSessionControlReader('example', [1])
  const { agent } = await ctx.agents.create({
    sessionId: SessionId('unloaded-reader'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  agent.session.append('extension/record', {
    namespace: 'example', schemaVersion: 1, recordId: 'record-1', kind: 'task-created', payload: null,
  })
  await unregister()
  const input = createUserMessage({ content: [{ type: 'text', text: 'Can you continue?' }], source: { kind: 'user' } })
  agent.followup(input)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect(agent.inbox.nextTurn.map(message => message.id)).toContain(input.id)
})
