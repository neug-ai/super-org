import type { Project, ProjectDetail, ProjectTask } from './projects.ts'

export const taskReference = (id: string) => `〔任务 ${id.slice(0, 8)}〕`

/** A managed execution may be queued independently of the task's start status. */
export function awaitsTaskExecution(task: ProjectTask): boolean {
  return task.status === 'in-progress' || (task.status === 'todo' && !!task.executionStartedAt)
}

export function taskExecution(project: Pick<ProjectDetail, 'tickets'>, task: ProjectTask) {
  return project.tickets.find(ticket => ticket.id === task.ticketId)
    ?? project.tickets.find(ticket => ticket.taskId === task.id && !ticket.ended)
}

export function taskContext(project: Pick<Project, 'id' | 'name'>, task: ProjectTask, acceptanceLabel: string): string {
  return [`# ${project.name} / ${task.title}`, `Super Agent task: ${project.id}/${task.id}`, task.description,
    task.acceptance && `## ${acceptanceLabel}\n\n${task.acceptance}`].filter(Boolean).join('\n\n')
}
