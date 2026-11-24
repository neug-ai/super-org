import type { Member } from './projects.ts'

/** The selected project Agent has a stable identity in the same directory as other members. */
export const projectAgentAccount = { provider: 'agent', scope: '', accountId: 'project-agent' }

export function isProjectAgent(member: Member | undefined): boolean {
  return !!member?.accounts.some(account => account.provider === projectAgentAccount.provider &&
    account.scope === projectAgentAccount.scope && account.accountId === projectAgentAccount.accountId)
}
