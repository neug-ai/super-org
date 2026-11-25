import type { ProjectTask } from './projects.ts'

export interface DeliveryEvidence { summary: string; links: string[]; ticketId?: string; reportAt?: string;
  code?: { url: string; head: string; mergeCommit: string; base?: string; updatedAt: string } }
export type ReviewOutcome = 'accepted' | 'rejected' | 'feedback'
export interface ReviewEntry {
  actorId: string | null
  actorName?: string
  reviewerName?: string
  source: string
  reason: string
  at: string
  links?: string[]
}
export interface ProjectReview {
  id: string
  version: number
  requestedAt: string
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  taskId?: string
  requirements: { title: string; description: string; acceptance: string; ownerId?: string | null }
  evidence: DeliveryEvidence
  feedback?: ReviewEntry[]
  decision?: ReviewEntry
}

export const reviewReference = (review: ProjectReview) => `〔交付第 ${review.version} 版 · 验收 ${review.id.slice(0, 8)}〕`
export const currentReview = (task: ProjectTask) => task.reviews?.findLast(review => review.version === task.deliveryVersion)

/** Describes the current delivery, including the assignee of a legacy linked review task. */
export function deliveryReviewState(task: ProjectTask, tasks: readonly ProjectTask[] = []) {
  const review = currentReview(task)
  return review ? { status: review.status, reviewId: review.id, version: review.version, ...(review.taskId && { taskId: review.taskId }),
    reviewerId: review.taskId ? tasks.find(item => item.id === review.taskId)?.ownerId ?? null : null }
    : { status: 'not-requested' as const, reviewerId: null }
}

/** Invalidates the old review before beginning a new execution or changing its acceptance scope. */
export function nextDelivery(task: ProjectTask): void {
  const review = currentReview(task)
  if (review?.status === 'pending') review.status = 'superseded'
  task.deliveryVersion = (task.deliveryVersion ?? 0) + 1
}

export function deliveryScopeChanged(before: ProjectTask, after: ProjectTask): boolean {
  before = { ...before, deliveryMode: before.deliveryMode ?? 'report', pullRequestUrl: before.pullRequestUrl ?? null, targetBranch: before.targetBranch ?? null }
  after = { ...after, deliveryMode: after.deliveryMode ?? 'report', pullRequestUrl: after.pullRequestUrl ?? null, targetBranch: after.targetBranch ?? null }
  return ['title', 'description', 'acceptance', 'ownerId', 'executionMode', 'blockedBy', 'deliveryMode', 'pullRequestUrl', 'targetBranch'].some(field =>
    JSON.stringify(before[field as keyof ProjectTask]) !== JSON.stringify(after[field as keyof ProjectTask]))
}
