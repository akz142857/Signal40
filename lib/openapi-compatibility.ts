const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const DEPRECATION_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

type JsonObject = Record<string, unknown>;

export type OpenApiCompatibilityOptions = {
  asOf?: Date;
};

export type BreakingChangeApprovalResult = {
  unapproved: string[];
  stale: string[];
};

export function reconcileBreakingChangeApprovals(
  detected: string[],
  approved: string[],
): BreakingChangeApprovalResult {
  const detectedSet = new Set(detected);
  const approvedSet = new Set(approved);
  return {
    unapproved: [...detectedSet].filter((change) => !approvedSet.has(change)).sort(),
    stale: [...approvedSet].filter((change) => !detectedSet.has(change)).sort(),
  };
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function resolveRef(document: JsonObject, value: unknown): JsonObject | undefined {
  let current = object(value);
  const seen = new Set<string>();
  while (typeof current?.$ref === 'string' && current.$ref.startsWith('#/')) {
    const ref = current.$ref;
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    current = ref
      .slice(2)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce<unknown>((node, key) => object(node)?.[key], document) as JsonObject | undefined;
  }
  return current;
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}

function sameScalarOrArray(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return Object.is(left, right);
  return left.length === right.length
    && left.every((value) => right.some((candidate) => Object.is(candidate, value)));
}

function schemaFromMedia(document: JsonObject, container: unknown): JsonObject | undefined {
  const resolved = resolveRef(document, container);
  const content = object(resolved?.content);
  const media = object(content?.['application/json']) ?? object(Object.values(content ?? {})[0]);
  return object(media?.schema);
}

function removalAllowed(value: unknown, asOf: Date): boolean {
  const item = object(value);
  if (item?.deprecated !== true) return false;
  const deprecatedAtValue = item['x-deprecated-at'];
  const sunsetAtValue = item['x-sunset-at'];
  const deprecatedAt = typeof deprecatedAtValue === 'string' ? Date.parse(deprecatedAtValue) : Number.NaN;
  const sunsetAt = typeof sunsetAtValue === 'string' ? Date.parse(sunsetAtValue) : Number.NaN;
  return Number.isFinite(deprecatedAt) && Number.isFinite(sunsetAt)
    && sunsetAt - deprecatedAt >= DEPRECATION_WINDOW_MS
    && asOf.getTime() >= sunsetAt;
}

function effectiveSecurity(document: JsonObject, operation: JsonObject): unknown[] {
  const value = Object.hasOwn(operation, 'security') ? operation.security : document.security;
  return Array.isArray(value) ? value : [];
}

function weakensSecurity(baseline: unknown[], current: unknown[]): boolean {
  if (baseline.length === 0) return false;
  if (current.length === 0) return true;
  const baselineAlternatives = baseline.map((entry) => new Set(Object.keys(object(entry) ?? {})));
  return current.some((entry) => {
    const schemes = new Set(Object.keys(object(entry) ?? {}));
    if (schemes.size === 0) return true;
    return !baselineAlternatives.some((required) =>
      required.size > 0 && [...required].every((scheme) => schemes.has(scheme)));
  });
}

function compareSchemas(
  baselineDocument: JsonObject,
  currentDocument: JsonObject,
  baselineValue: unknown,
  currentValue: unknown,
  location: string,
  direction: 'request' | 'response',
  issues: string[],
  seen = new Set<string>(),
) {
  const baseline = resolveRef(baselineDocument, baselineValue);
  const current = resolveRef(currentDocument, currentValue);
  if (!baseline) return;
  if (!current) {
    issues.push(`${location}: schema removed or replaced by an unresolved schema`);
    return;
  }

  const pairKey = `${location}:${String(baseline.$ref)}:${String(current.$ref)}`;
  if (seen.has(pairKey)) return;
  seen.add(pairKey);

  if (baseline.type !== undefined && !sameScalarOrArray(current.type, baseline.type)) {
    issues.push(`${location}: type changed from ${JSON.stringify(baseline.type)} to ${JSON.stringify(current.type)}`);
  }
  if (baseline.format !== undefined && current.format !== baseline.format) {
    issues.push(`${location}: format changed from ${JSON.stringify(baseline.format)} to ${JSON.stringify(current.format)}`);
  }

  const baselineEnum = Array.isArray(baseline.enum) ? baseline.enum : undefined;
  const currentEnum = Array.isArray(current.enum) ? current.enum : undefined;
  if (baselineEnum && currentEnum) {
    for (const value of baselineEnum) {
      if (!currentEnum.some((candidate) => Object.is(candidate, value))) {
        issues.push(`${location}: enum value ${JSON.stringify(value)} was removed`);
      }
    }
  } else if (!baselineEnum && currentEnum) {
    issues.push(`${location}: an unrestricted value was narrowed to an enum`);
  }

  const baselineRequired = stringSet(baseline.required);
  const currentRequired = stringSet(current.required);
  if (direction === 'request') {
    for (const name of currentRequired) {
      if (!baselineRequired.has(name)) issues.push(`${location}.${name}: request field became required`);
    }
  } else {
    for (const name of baselineRequired) {
      if (!currentRequired.has(name)) issues.push(`${location}.${name}: required response field is no longer guaranteed`);
    }
  }

  const baselineProperties = object(baseline.properties) ?? {};
  const currentProperties = object(current.properties) ?? {};
  for (const [name, property] of Object.entries(baselineProperties)) {
    if (!(name in currentProperties)) {
      issues.push(`${location}.${name}: property was removed`);
      continue;
    }
    compareSchemas(baselineDocument, currentDocument, property, currentProperties[name], `${location}.${name}`, direction, issues, seen);
  }

  if (baseline.items) {
    compareSchemas(baselineDocument, currentDocument, baseline.items, current.items, `${location}[]`, direction, issues, seen);
  }

  for (const composition of ['allOf', 'anyOf', 'oneOf'] as const) {
    const before = Array.isArray(baseline[composition]) ? baseline[composition] as unknown[] : [];
    const after = Array.isArray(current[composition]) ? current[composition] as unknown[] : [];
    if (before.length !== after.length) {
      issues.push(`${location}: ${composition} branch count changed from ${before.length} to ${after.length}`);
      continue;
    }
    before.forEach((branch, index) => compareSchemas(
      baselineDocument,
      currentDocument,
      branch,
      after[index],
      `${location}.${composition}[${index}]`,
      direction,
      issues,
      seen,
    ));
  }

  if (baseline.additionalProperties !== false && current.additionalProperties === false) {
    issues.push(`${location}: additional properties became forbidden`);
  }
  for (const keyword of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'] as const) {
    if (typeof current[keyword] === 'number'
      && (typeof baseline[keyword] !== 'number' || current[keyword] > baseline[keyword])) {
      issues.push(`${location}: ${keyword} became more restrictive`);
    }
  }
  for (const keyword of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'] as const) {
    if (typeof current[keyword] === 'number'
      && (typeof baseline[keyword] !== 'number' || current[keyword] < baseline[keyword])) {
      issues.push(`${location}: ${keyword} became more restrictive`);
    }
  }
  if (current.pattern !== undefined && current.pattern !== baseline.pattern) {
    issues.push(`${location}: pattern was added or changed`);
  }
}

function collectRequiredParameters(document: JsonObject, operation: JsonObject): Set<string> {
  const result = new Set<string>();
  for (const parameter of Array.isArray(operation.parameters) ? operation.parameters : []) {
    const resolved = resolveRef(document, parameter);
    if (resolved?.required === true && typeof resolved.name === 'string' && typeof resolved.in === 'string') {
      result.add(`${resolved.in}:${resolved.name}`);
    }
  }
  return result;
}

export function findOpenApiBreakingChanges(
  baselineDocument: unknown,
  currentDocument: unknown,
  options: OpenApiCompatibilityOptions = {},
): string[] {
  const baseline = object(baselineDocument);
  const current = object(currentDocument);
  if (!baseline || !current) return ['OpenAPI documents must be objects'];
  const asOf = options.asOf ?? new Date();
  const issues: string[] = [];
  const baselinePaths = object(baseline.paths) ?? {};
  const currentPaths = object(current.paths) ?? {};

  for (const [path, baselinePathValue] of Object.entries(baselinePaths)) {
    const baselinePath = object(baselinePathValue) ?? {};
    const currentPath = object(currentPaths[path]);
    if (!currentPath) {
      if (!removalAllowed(baselinePathValue, asOf)) issues.push(`${path}: path was removed without a completed 90-day deprecation window`);
      continue;
    }
    for (const method of HTTP_METHODS) {
      const baselineOperation = object(baselinePath[method]);
      if (!baselineOperation) continue;
      const currentOperation = object(currentPath[method]);
      const operationLocation = `${method.toUpperCase()} ${path}`;
      if (!currentOperation) {
        if (!removalAllowed(baselineOperation, asOf)) issues.push(`${operationLocation}: operation was removed without a completed 90-day deprecation window`);
        continue;
      }

      if (weakensSecurity(effectiveSecurity(baseline, baselineOperation), effectiveSecurity(current, currentOperation))) {
        issues.push(`${operationLocation}: security requirements were weakened`);
      }

      const beforeParameters = collectRequiredParameters(baseline, baselineOperation);
      const afterParameters = collectRequiredParameters(current, currentOperation);
      for (const parameter of afterParameters) {
        if (!beforeParameters.has(parameter)) issues.push(`${operationLocation}: required parameter ${parameter} was added`);
      }

      const baselineRequestBody = resolveRef(baseline, baselineOperation.requestBody);
      const currentRequestBody = resolveRef(current, currentOperation.requestBody);
      if (baselineRequestBody?.required !== true && currentRequestBody?.required === true) {
        issues.push(`${operationLocation}: request body became required`);
      }
      const baselineRequestSchema = schemaFromMedia(baseline, baselineRequestBody);
      if (baselineRequestSchema) {
        compareSchemas(baseline, current, baselineRequestSchema, schemaFromMedia(current, currentRequestBody), `${operationLocation} request`, 'request', issues);
      }

      const baselineResponses = object(baselineOperation.responses) ?? {};
      const currentResponses = object(currentOperation.responses) ?? {};
      for (const [status, baselineResponse] of Object.entries(baselineResponses)) {
        if (!(status in currentResponses)) {
          issues.push(`${operationLocation}: response status ${status} was removed`);
          continue;
        }
        const baselineResponseSchema = schemaFromMedia(baseline, baselineResponse);
        if (!baselineResponseSchema) continue;
        compareSchemas(baseline, current, baselineResponseSchema, schemaFromMedia(current, currentResponses[status]), `${operationLocation} response ${status}`, 'response', issues);
      }
    }
  }
  return [...new Set(issues)].sort();
}
