/** Durable admission for Host-owned workspace retirement. */
import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace } from './types.ts'
import { fullyQualifiedWorkspacePath } from './paths.ts'

const retirementTarget = z.object({
  key: z.string().min(1),
  directory: z.string(),
  quarantineDirectory: z.string(),
  sessionId: z.string().optional(),
})

export type WorkspaceRetirementTarget = z.input<typeof retirementTarget>
export interface WorkspaceRetirementInspection {
  reasons: string[]
  workspace?: { id: string; title: string }
  archived: boolean
}

export const workspaceRetirementSpec = defineDomain({
  name: 'workspace_retirement',
  version: 1,
  tables: { fences: domainTable<string, WorkspaceRetirementTarget>(retirementTarget) },
})

interface RetirementHost {
  workspaces(): Workspace[]
  workspaceSessionIds(id: string): readonly SessionId[]
  headers(): Promise<SessionHeader[]>
  header(id: string): Promise<SessionHeader | undefined>
  activity(id: SessionId): Promise<readonly string[]>
  liveLocations(): Promise<readonly { id: SessionId; directory?: string; activity?: 'terminal' }[]>
  archived(id: string): boolean
  archive(id: SessionId): Promise<void>
  remove(id: string): Promise<void>
  restore(directory: string, title?: string, sessionId?: SessionId, unarchive?: boolean): Promise<Workspace>
}

interface Subject {
  directory?: string | undefined
  sessionId?: string | undefined
  parentSessionId?: string | undefined
}

interface Claim {
  subject: Subject
  done: Promise<void>
}

interface SubjectPaths {
  ids: Set<string>
  paths: Set<string>
}

export class WorkspaceRetiredError extends Error {
  constructor(readonly key: string) {
    super('This workspace is reserved for retirement.')
    this.name = 'WorkspaceRetiredError'
  }
}

/** Resolve existing ancestors as well as the path itself, including after a rename. */
async function canonical(path: string, aliases = new Set<string>()): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    const info = await lstat(path).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    })
    if (info?.isSymbolicLink() === true) {
      if (aliases.has(path) || aliases.size >= 40) throw new Error('Cannot resolve a workspace path with cyclic links.')
      aliases.add(path)
      return canonical(resolve(parent, await readlink(path)), aliases)
    }
    return join(await canonical(parent, aliases), basename(path))
  }
}

function comparable(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

function inside(root: string, path: string): boolean {
  const child = relative(comparable(root), comparable(path))
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
}

function overlaps(a: string, b: string): boolean {
  return inside(a, b) || inside(b, a)
}

function pathsOf(target: WorkspaceRetirementTarget): readonly string[] {
  return [target.directory, target.quarantineDirectory]
}

function sameTarget(a: WorkspaceRetirementTarget, b: WorkspaceRetirementTarget): boolean {
  return a.key === b.key && a.directory === b.directory
    && a.quarantineDirectory === b.quarantineDirectory && a.sessionId === b.sessionId
}

function validate(target: WorkspaceRetirementTarget): WorkspaceRetirementTarget {
  const parsed = retirementTarget.parse(target)
  const paths = pathsOf(parsed)
  if (paths.some(path => !fullyQualifiedWorkspacePath(path) || normalize(path) !== path || parse(path).root === path)
    || overlaps(parsed.directory, parsed.quarantineDirectory)) {
    throw new Error('Retirement requires separate canonical workspace and quarantine directories.')
  }
  return parsed
}

function matches(target: WorkspaceRetirementTarget, subject: SubjectPaths): boolean {
  return (target.sessionId !== undefined && subject.ids.has(target.sessionId))
    || pathsOf(target).some(root => [...subject.paths].some(path => inside(root, path)))
}

/** Installed with the Workspace registry before its consumers can admit work. */
export class WorkspaceRetirement {
  readonly version: 1
  private store?: KvTable<string, WorkspaceRetirementTarget>
  private readonly fences = new Map<string, WorkspaceRetirementTarget>()
  private readonly claims = new Set<Claim>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly host: RetirementHost) {
    this.version = 1
  }

  initialize(store: KvTable<string, WorkspaceRetirementTarget>): void {
    for (const [key, target] of store.entries()) {
      if (key !== target.key) throw new Error('Stored workspace retirement key mismatch.')
      const parsed = validate(target)
      this.assertAvailable(parsed)
      this.fences.set(key, parsed)
    }
    this.store = store
  }

  /**
   * Reserve a native operation until its durable work is complete. Identity
   * resolution may await I/O, so a pending claim is visible before it starts.
   */
  async claim(subject: Subject): Promise<Disposable> {
    const { promise: done, resolve: release } = Promise.withResolvers<void>()
    const claim = { subject, done }
    this.claims.add(claim)
    const dispose = () => {
      this.claims.delete(claim)
      release()
    }
    try {
      await this.assertAdmitted(subject)
      return { [Symbol.dispose]: dispose }
    } catch (error) {
      dispose()
      throw error
    }
  }

  async assertAdmitted(subject: Subject): Promise<void> {
    if (this.fences.size === 0) return
    for (const target of this.fences.values()) {
      if (target.sessionId !== undefined
        && (target.sessionId === subject.sessionId || target.sessionId === subject.parentSessionId)) {
        throw new WorkspaceRetiredError(target.key)
      }
    }
    const resolved = await this.resolveSubject(subject)
    for (const target of this.fences.values()) {
      if (matches(target, resolved)) throw new WorkspaceRetiredError(target.key)
    }
  }

  async inspect(target: WorkspaceRetirementTarget): Promise<WorkspaceRetirementInspection> {
    target = validate(target)
    this.assertAvailable(target)
    const workspace = this.host.workspaces().find(entry => entry.path === target.directory)
    const reasons: string[] = []
    for (const entry of this.host.workspaces()) {
      if (entry.id !== workspace?.id && pathsOf(target).some(path => inside(path, entry.path))) {
        reasons.push(`Another workspace occupies the directory (${entry.id}).`)
      }
    }

    const headers = new Map((await this.host.headers()).map(header => [String(header.id), header]))
    const owned = new Set<string>()
    if (target.sessionId !== undefined) {
      const cwd = headers.get(target.sessionId)?.cwd
      if (cwd === undefined || !fullyQualifiedWorkspacePath(cwd) || await canonical(cwd) !== target.directory) {
        reasons.push('The Worker Session does not belong to this workspace.')
      } else {
        owned.add(target.sessionId)
      }
    }
    for (const header of headers.values()) {
      if (isDescendant(header, owned, headers)) owned.add(header.id)
    }
    for (const id of workspace === undefined ? [] : this.host.workspaceSessionIds(workspace.id)) {
      if (!owned.has(id)) reasons.push(`Another Session belongs to the workspace (${id}).`)
    }
    for (const location of await this.host.liveLocations()) {
      const identity = await this.resolveSubject({ directory: location.directory })
      if (owned.has(location.id)) {
        if (location.activity !== undefined) reasons.push(`Session ${location.id} is active (${location.activity}).`)
      } else if (matches(target, identity)) {
        reasons.push(`Another Session occupies the directory (${location.id}).`)
      }
    }
    for (const header of headers.values()) {
      const identity = await this.resolveSubject({ directory: header.cwd })
      if (!owned.has(header.id) && matches(target, identity)) {
        reasons.push(`Another Session occupies the directory (${header.id}).`)
      }
      if (owned.has(header.id)) reasons.push(...await this.host.activity(header.id))
    }
    for (const claim of this.claims) {
      if (matches(target, await this.resolveSubject(claim.subject))) {
        reasons.push('A native operation is still using the workspace.')
        break
      }
    }
    return {
      reasons: [...new Set(reasons)],
      ...(workspace === undefined ? {} : { workspace: { id: workspace.id, title: workspace.title } }),
      archived: target.sessionId !== undefined && this.host.archived(target.sessionId),
    }
  }

  fence(target: WorkspaceRetirementTarget): Promise<void> {
    return this.serial(async () => {
      target = validate(target)
      this.assertAvailable(target)
      for (const path of pathsOf(target)) {
        if (await canonical(path) !== path) throw new Error('The retirement path is no longer canonical.')
      }
      this.fences.set(target.key, target)
      if (this.requireStore().get(target.key) === undefined) await this.requireStore().put(target.key, target)
      const priorClaims = [...this.claims]
      await this.drain(priorClaims, target)
    })
  }

  archive(target: WorkspaceRetirementTarget): Promise<void> {
    return this.serial(async () => {
      this.requireFence(target)
      const inspection = await this.inspect(target)
      this.assertQuiet(inspection)
      if (target.sessionId !== undefined) await this.host.archive(target.sessionId as SessionId)
    })
  }

  remove(target: WorkspaceRetirementTarget, workspaceId?: string): Promise<void> {
    return this.serial(async () => {
      this.requireFence(target)
      const inspection = await this.inspect(target)
      this.assertQuiet(inspection)
      const workspace = this.host.workspaces().find(entry => entry.id === workspaceId)
      if (workspace !== undefined && workspace.path !== target.directory
        || inspection.workspace !== undefined && inspection.workspace.id !== workspaceId) {
        throw new Error('The workspace registration no longer matches its retirement record.')
      }
      if (workspace !== undefined) await this.host.remove(workspace.id)
    })
  }

  restore(target: WorkspaceRetirementTarget, options: {
    title?: string
    unarchive: boolean
  }): Promise<{ id: string; title: string } | undefined> {
    return this.serial(async () => {
      this.requireFence(target)
      this.assertQuiet(await this.inspect(target))
      if (options.title === undefined && target.sessionId === undefined) return undefined
      const workspace = await this.host.restore(
        target.directory, options.title, target.sessionId as SessionId | undefined, options.unarchive,
      )
      return { id: workspace.id, title: workspace.title }
    })
  }

  release(target: WorkspaceRetirementTarget): Promise<void> {
    return this.serial(async () => {
      target = validate(target)
      const current = this.fences.get(target.key)
      if (current === undefined) return
      this.requireFence(target)
      await this.requireStore().delete(target.key)
      this.fences.delete(target.key)
    })
  }

  private async drain(claims: Claim[], target: WorkspaceRetirementTarget): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(claims.map(async (claim) => {
          if (matches(target, await this.resolveSubject(claim.subject))) await claim.done
        })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native workspace operations have not finished. Retry once they are idle.')), 3_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private requireStore(): KvTable<string, WorkspaceRetirementTarget> {
    if (this.store === undefined) throw new Error('Workspace retirement is unavailable before Host initialization.')
    return this.store
  }

  private requireFence(target: WorkspaceRetirementTarget): void {
    const current = this.fences.get(target.key)
    const stored = this.requireStore().get(target.key)
    if (current === undefined || stored === undefined || !sameTarget(current, target) || !sameTarget(stored, target)) {
      throw new Error('No matching durable workspace retirement fence.')
    }
  }

  private assertAvailable(target: WorkspaceRetirementTarget): void {
    for (const other of this.fences.values()) {
      if (sameTarget(other, target)) continue
      if (target.key === other.key
        || target.sessionId !== undefined && target.sessionId === other.sessionId
        || pathsOf(target).some(a => pathsOf(other).some(b => overlaps(a, b)))) {
        throw new Error('Another retirement owns this workspace or Session.')
      }
    }
  }

  private assertQuiet(inspection: WorkspaceRetirementInspection): void {
    if (inspection.reasons.length > 0) throw new Error(inspection.reasons.join(' '))
  }

  private async resolveSubject(subject: Subject): Promise<SubjectPaths> {
    const ids = new Set<string>()
    const paths = new Set<string>()
    if (subject.directory !== undefined) await this.addPath(paths, subject.directory)
    for (const id of [subject.sessionId, subject.parentSessionId]) {
      let ancestor = id
      while (ancestor !== undefined && !ids.has(ancestor)) {
        ids.add(ancestor)
        const header = await this.host.header(ancestor)
        if (header?.cwd !== undefined) await this.addPath(paths, header.cwd)
        ancestor = header?.origin === 'subagent' ? header.parentSession : undefined
      }
    }
    if (ids.size > 0) {
      for (const location of await this.host.liveLocations()) {
        if (ids.has(location.id) && location.directory !== undefined) await this.addPath(paths, location.directory)
      }
    }
    return { ids, paths }
  }

  private async addPath(paths: Set<string>, path: string): Promise<void> {
    if (!fullyQualifiedWorkspacePath(path)) return
    paths.add(normalize(path))
    paths.add(await canonical(path))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function isDescendant(header: SessionHeader, owners: ReadonlySet<string>, headers: ReadonlyMap<string, SessionHeader>): boolean {
  const visited = new Set<string>()
  let ancestor: SessionHeader | undefined = header
  while (ancestor?.origin === 'subagent' && ancestor.parentSession !== undefined && !visited.has(ancestor.id)) {
    if (owners.has(ancestor.parentSession)) return true
    visited.add(ancestor.id)
    ancestor = headers.get(ancestor.parentSession)
  }
  return false
}
