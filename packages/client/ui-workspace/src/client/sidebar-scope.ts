/** Workspace ownership for the sidebar's presentation of an active main panel. */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A main panel's Session ownership test, evaluated against the Host projection. */
export interface SidebarWorkspaceScope {
  readonly panelId: MainPanelId
  readonly ownsSession: (session: SessionSummary) => boolean
}

/**
 * Partition the sidebar without altering the Session catalog or persisted order.
 * @param selectedPanel - the scope the browser is showing, held apart from the center's
 * active panel: opening a Session reveals the Conversation (null) without leaving the scope.
 * Null shows the native Workspace and Session list, including anything no scope claims.
 */
export function sidebarProjection(scopes: readonly SidebarWorkspaceScope[], selectedPanel: MainPanelId | null,
  list: SessionListState, workspaces: readonly WorkspaceView[]) {
  if (!scopes.length) return { list, workspaces }
  const selected = scopes.find(scope => scope.panelId === selectedPanel)
  const sessionOwners = new Map<SessionId, SidebarWorkspaceScope>()
  const pathOwners = new Map<string, SidebarWorkspaceScope>()
  for (const session of Object.values(list.byId)) {
    const owner = scopes.find(scope => scope.ownsSession(session))
    if (!owner) continue
    sessionOwners.set(session.id, owner)
    // Archived Sessions can remain in the catalog without current Workspace membership.
    if (session.cwd) pathOwners.set(session.cwd, owner)
  }
  const visibleWorkspaces = workspaces.filter((workspace) => {
    const owner = workspace.sessionIds.map(id => sessionOwners.get(id)).find(Boolean) ?? pathOwners.get(workspace.path)
    if (owner) {
      pathOwners.set(workspace.path, owner)
      for (const id of workspace.sessionIds) sessionOwners.set(id, owner)
    }
    return owner === selected
  })
  const visible = (session: SessionSummary): boolean =>
    (sessionOwners.get(session.id) ?? (session.cwd ? pathOwners.get(session.cwd) : undefined)) === selected
  const byId = Object.fromEntries(Object.entries(list.byId).filter(([, row]) => visible(row)))
  return {
    list: { ...list, ids: list.ids.filter(id => byId[id] !== undefined), byId },
    workspaces: visibleWorkspaces,
  }
}
