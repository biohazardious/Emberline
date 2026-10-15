/** API contracts: Interactive Roadmap, Milestones & AI Brainstorming Studio. */
import { z } from 'zod';
import { AgentPersona } from './projects.js';
import { AgentId, AgentModelId, Run } from './runs.js';
import { Ticket, TicketPriority } from './tickets.js';

export const RoadmapCategory = z.enum([
  'feature',
  'ui_ux',
  'architecture',
  'performance',
  'qa_security',
]);
export type RoadmapCategory = z.infer<typeof RoadmapCategory>;

export const RoadmapItemStatus = z.enum(['idea', 'planned', 'in_progress', 'done']);
export type RoadmapItemStatus = z.infer<typeof RoadmapItemStatus>;

export const RoadmapItem = z.object({
  id: z.string(),
  milestoneId: z.string(),
  title: z.string(),
  description: z.string(),
  category: RoadmapCategory.default('feature'),
  persona: AgentPersona.default('coder'),
  preferredAgent: AgentId.default('claude'),
  preferredModel: AgentModelId.default('auto'),
  priority: TicketPriority.default(2),
  status: RoadmapItemStatus.default('planned'),
  ticketId: z.string().nullable().default(null),
  ticketKey: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type RoadmapItem = z.infer<typeof RoadmapItem>;

export const RoadmapMilestone = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  description: z.string().default(''),
  status: z.enum(['planned', 'active', 'completed']).default('planned'),
  items: z.array(RoadmapItem).default([]),
});
export type RoadmapMilestone = z.infer<typeof RoadmapMilestone>;

export const BrainstormSuggestion = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  implementationPrompt: z.string(),
  category: RoadmapCategory,
  impact: z.enum(['high', 'medium', 'low']).default('high'),
  effort: z.enum(['small', 'medium', 'large']).default('medium'),
  persona: AgentPersona,
  preferredAgent: AgentId,
  preferredModel: AgentModelId,
  suggestedMilestoneCode: z.string().default('M2'),
});
export type BrainstormSuggestion = z.infer<typeof BrainstormSuggestion>;

export const ProjectRoadmapState = z.object({
  projectId: z.string(),
  visionSummary: z.string(),
  totalItems: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(),
  completionPercent: z.number().int().min(0).max(100),
  milestones: z.array(RoadmapMilestone),
  suggestions: z.array(BrainstormSuggestion),
  updatedAt: z.string(),
});
export type ProjectRoadmapState = z.infer<typeof ProjectRoadmapState>;

export const CreateMilestoneBody = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
});
export type CreateMilestoneBody = z.input<typeof CreateMilestoneBody>;

export const CreateRoadmapItemBody = z.object({
  milestoneId: z.string().min(1).default('auto'),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).default(''),
  category: RoadmapCategory.optional(),
  persona: AgentPersona.optional(),
  preferredAgent: AgentId.optional(),
  preferredModel: AgentModelId.optional(),
  priority: TicketPriority.optional(),
  status: RoadmapItemStatus.default('planned'),
});
export type CreateRoadmapItemBody = z.input<typeof CreateRoadmapItemBody>;

export const AutoGenerateRoadmapBody = z.object({
  mode: z.enum(['instant', 'agent']).default('instant'),
  instructions: z.string().trim().max(2000).default(''),
});
export type AutoGenerateRoadmapBody = z.input<typeof AutoGenerateRoadmapBody>;

export const AutoGenerateRoadmapResponse = z.object({
  roadmap: ProjectRoadmapState,
  agentRun: Run.nullable().default(null),
});
export type AutoGenerateRoadmapResponse = z.infer<typeof AutoGenerateRoadmapResponse>;

export const UpdateRoadmapItemBody = z
  .object({
    milestoneId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000),
    category: RoadmapCategory,
    persona: AgentPersona,
    preferredAgent: AgentId,
    preferredModel: AgentModelId,
    priority: TicketPriority,
    status: RoadmapItemStatus,
  })
  .partial();
export type UpdateRoadmapItemBody = z.input<typeof UpdateRoadmapItemBody>;

export const BrainstormRequestBody = z.object({
  focus: z.string().trim().max(2000).default(''),
  mode: z.enum(['instant', 'agent']).default('instant'),
  leadPersona: AgentPersona.default('product_owner'),
});
export type BrainstormRequestBody = z.input<typeof BrainstormRequestBody>;

export const BrainstormResponse = z.object({
  roadmap: ProjectRoadmapState,
  agentRun: Run.nullable().default(null),
});
export type BrainstormResponse = z.infer<typeof BrainstormResponse>;

export const DispatchRoadmapItemsBody = z.object({
  itemIds: z.array(z.string()).default([]),
  suggestionIds: z.array(z.string()).default([]),
  targetMilestoneId: z.string().optional(),
  autoStart: z.boolean().default(true),
});
export type DispatchRoadmapItemsBody = z.input<typeof DispatchRoadmapItemsBody>;

export const DispatchRoadmapItemsResponse = z.object({
  roadmap: ProjectRoadmapState,
  createdTickets: z.array(Ticket),
  startedRun: Run.nullable().default(null),
});
export type DispatchRoadmapItemsResponse = z.infer<typeof DispatchRoadmapItemsResponse>;
