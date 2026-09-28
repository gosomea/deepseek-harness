/** Strict check policies keep public TMP, user files and the network outside the allowed range. */
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '../src/index.ts'
import { bwrapProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'
import { afterEach, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const policy = { mode: 'workspace-write' as const, workspaceRoot: '/private/check', verification: { readRoots: ['/usr', '/bin'] } }

it('Seatbelt writes only the check tree and denies undeclared reads and all network', () => {
  const profile = seatbeltProfileArgs(policy)[1]!
  expect(profile).toContain('(deny network*)')
  expect(profile).toContain('(deny file-read-data)')
  expect(profile).toContain('(allow file-write* (subpath "/private/check") (literal "/dev/null"))')
  expect(profile).not.toContain('(subpath "/tmp")')
})
it('bwrap exposes only declared reads, one writable tree, private PIDs and no network', () => {
  const argv = bwrapProfileArgs(policy)
  expect(argv).toContain('--unshare-net')
  expect(argv).toContain('--unshare-pid')
  expect(argv.some((part, index) => part === '--ro-bind' && argv[index + 1] === '/')).toBe(false)
  expect(argv.slice(-5)).toEqual(['--bind', '/private/check', '/private/check', '--remount-ro', '/'])
})
it('unsupported providers reject instead of downgrading a verification policy', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = { platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'full', landlockLauncher: '/fake/landlock' }
  await expect(provider.confine(['true'], policy)).rejects.toThrow('does not provide')
})
it('verification facts are affirmative and ordinary policy behavior is retained', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = { platform: 'darwin' }
  expect((await provider.confine(['true'], policy)).verificationEnforced).toBe(true)
  expect((await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: '/private/check' })).verificationEnforced).toBeUndefined()
  await expect(provider.confine(['true'], { ...policy, verification: { readRoots: ['/'] } })).rejects.toThrow('restricted')
})
