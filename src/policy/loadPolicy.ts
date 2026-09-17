import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import * as z from 'zod';
import { ActionClass } from '../core/schema.ts';
import { DEFAULT_POLICY, type PolicyConfig } from './policyEngine.ts';

const PolicyFile = z.object({
  allowedOrigins: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  allowedActionKinds: z.array(z.enum([
    'click', 'type', 'select', 'press', 'navigate', 'scroll', 'extract', 'assert',
  ])).default(DEFAULT_POLICY.allowedActionKinds),
  maxUnapprovedActionClass: ActionClass.default('write_reversible'),
  requireApprovalLabels: z.array(z.string()).default([]),
  denyLabels: z.array(z.string()).default([]),
  valueLimits: z.array(z.object({ field: z.string(), max: z.number() })).default([]),
});

export function loadPolicy(path = 'config/policy.yaml'): PolicyConfig {
  const parsed = PolicyFile.parse(YAML.parse(readFileSync(path, 'utf8')));
  return parsed;
}
