import { AgentPersona, type ForgeIssue } from '@emberline/protocol';

export const TICKET_TITLE_MAX = 200;
export const TICKET_BODY_MAX = 18_000;

const PRIORITY_LABELS: Record<string, number> = {
  'priority:critical': 3,
  p0: 3,
  'priority:high': 2,
  p1: 2,
  'priority:low': 0,
  p3: 0,
};

export interface MappedTicket {
  title: string;
  body: string;
  persona: AgentPersona;
  priority: number;
  status: 'backlog' | 'ready';
}

/** Persona from the first label that is `persona:<id>` or exactly a persona id; `coder` otherwise. */
function personaOf(labels: string[]): AgentPersona {
  for (const label of labels) {
    const name = label.trim().toLowerCase();
    const parsed = AgentPersona.safeParse(name.startsWith('persona:') ? name.slice('persona:'.length) : name);
    if (parsed.success) return parsed.data;
  }
  return 'coder';
}

/** Priority from the first priority label; 1 otherwise. */
function priorityOf(labels: string[]): number {
  for (const label of labels) {
    const p = PRIORITY_LABELS[label.trim().toLowerCase()];
    if (p !== undefined) return p;
  }
  return 1;
}

/** The ticket fields for an issue (the issue's own content, never the client's). */
export function mapIssueToTicket(issue: ForgeIssue, status: 'backlog' | 'ready'): MappedTicket {
  const title = issue.title.trim().slice(0, TICKET_TITLE_MAX).trim() || `Issue #${issue.number}`;
  const text = issue.body.length > TICKET_BODY_MAX ? `${issue.body.slice(0, TICKET_BODY_MAX)}…` : issue.body;
  const source = `Source: ${issue.url}`;
  return {
    title,
    body: text.trim() === '' ? source : `${text}\n\n${source}`,
    persona: personaOf(issue.labels),
    priority: priorityOf(issue.labels),
    status,
  };
}
