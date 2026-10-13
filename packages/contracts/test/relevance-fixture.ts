import { z } from "zod";
import { relevanceDeadlinesSchema, relevanceEvaluationSchema, relevanceItemSchema, relevancePolicySchema, subjectActorSchema, subjectVersionSchema } from "../src/relevance.js";
export const relevanceFixtureSchema = z.object({
  version: z.literal(1),
  policies: z.array(z.object({ name: z.string(), policy: relevancePolicySchema, occurredAt: z.string(), acceptedAt: z.string(), expected: relevanceDeadlinesSchema })),
  evaluations: z.array(z.object({ name: z.string(), item: relevanceItemSchema, current: subjectVersionSchema.nullable(), now: z.string(), clockTrusted: z.boolean(), expected: relevanceEvaluationSchema })),
  transitions: z.array(z.object({ name: z.string(), actor: subjectActorSchema, candidate: subjectVersionSchema, current: subjectVersionSchema.nullable(), operation: z.enum(["update", "replace"]), expected: z.string() })),
});
