/**
 * Contracts of the files agents write under `.emberline/` for core to read. Core parses them with
 * `safeParse` at the boundary; a file that fails is kept as `*.rejected.json` and the project hears
 * why through a `project_notice` event.
 */
import { z } from 'zod';
import {
  BrainstormSuggestion,
  CreateMilestoneBody,
  CreateRoadmapItemBody,
  RoadmapCategory,
} from './roadmap.js';
import { AgentCreateTicketsPayload } from './orchestrator.js';
import { AgentPersona } from './projects.js';
import { AgentId, AgentModelId } from './runs.js';
import { TicketPriority } from './tickets.js';

const roadmapText = CreateRoadmapItemBody.shape.description.unwrap();

export const GeneratedRoadmapItem = z.object({
  title: CreateRoadmapItemBody.shape.title,
  description: roadmapText.optional(),
  category: RoadmapCategory.optional(),
  persona: AgentPersona.optional(),
  priority: TicketPriority.optional(),
});
export type GeneratedRoadmapItem = z.infer<typeof GeneratedRoadmapItem>;

export const GeneratedRoadmapMilestone = z.object({
  code: CreateMilestoneBody.shape.code,
  title: CreateMilestoneBody.shape.title.optional(),
  description: CreateMilestoneBody.shape.description.unwrap().optional(),
  items: z.array(GeneratedRoadmapItem).max(100).default([]),
});
export type GeneratedRoadmapMilestone = z.infer<typeof GeneratedRoadmapMilestone>;

/** `.emberline/roadmap-generated.json`, written by a roadmap-generation agent. */
export const GeneratedRoadmapFile = z.object({
  visionSummary: z.string().trim().max(2000).optional(),
  milestones: z.array(GeneratedRoadmapMilestone).max(20).default([]),
});
export type GeneratedRoadmapFile = z.infer<typeof GeneratedRoadmapFile>;

export const GeneratedBrainstormSuggestion = z.object({
  title: CreateRoadmapItemBody.shape.title,
  rationale: roadmapText.optional(),
  implementationPrompt: roadmapText.optional(),
  category: RoadmapCategory.optional(),
  impact: BrainstormSuggestion.shape.impact.unwrap().optional(),
  effort: BrainstormSuggestion.shape.effort.unwrap().optional(),
  persona: AgentPersona.optional(),
  preferredAgent: AgentId.optional(),
  preferredModel: AgentModelId.optional(),
  suggestedMilestoneCode: CreateMilestoneBody.shape.code,
});
export type GeneratedBrainstormSuggestion = z.infer<typeof GeneratedBrainstormSuggestion>;

/** `.emberline/brainstorm-suggestions.json`, written by a brainstorming agent. */
export const BrainstormSuggestionsFile = z.object({
  suggestions: z.array(GeneratedBrainstormSuggestion).max(50).default([]),
});
export type BrainstormSuggestionsFile = z.infer<typeof BrainstormSuggestionsFile>;

/**
 * `.emberline/new-tickets.json` (or `tickets.json`): a batch of ticket drafts, or a bare array of
 * drafts, which is read as a batch that dispatches.
 */
export const NewTicketsFile = z.preprocess(
  (json) => (Array.isArray(json) ? { autoDispatch: true, tickets: json } : json),
  AgentCreateTicketsPayload,
);
export type NewTicketsFile = z.infer<typeof NewTicketsFile>;

/** The first issue of a failed parse, as `path: message` (`(root)` for the file itself). */
export function firstZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid file';
  const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  return `${where}: ${issue.message}`;
}
