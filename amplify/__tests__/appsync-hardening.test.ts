/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backendSource = readFileSync(new URL('../backend.ts', import.meta.url), 'utf8');
const dataResourceSource = readFileSync(new URL('../data/resource.ts', import.meta.url), 'utf8');

function countGraphqlPolicyGrants(source: string, principal: string): number {
  const escapedPrincipal = principal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapedPrincipal}\\.addToRolePolicy\\(\\s*new iam\\.PolicyStatement\\(\\{[\\s\\S]*?actions:\\s*\\['appsync:GraphQL'\\]`,
    'g',
  );
  return [...source.matchAll(pattern)].length;
}

describe('AppSync access hardening', () => {
  it('uses backend resource auth and no broad principal categories', () => {
    const rules = dataResourceSource.match(/allow\.resource\([^)]+\)\.to\(\['query', 'mutate'\]\)/g) ?? [];

    expect(rules).toHaveLength(3);
    expect(dataResourceSource).toContain("allow.resource(honoApi).to(['query', 'mutate'])");
    expect(dataResourceSource).toContain("allow.resource(proverDispatchProxy).to(['query', 'mutate'])");
    expect(dataResourceSource).toContain("allow.resource(finalizeCallbackRunner).to(['query', 'mutate'])");
    expect(dataResourceSource).toContain("allow.group(MODEL_AUTH_FALLBACK_GROUP).to(['read'])");
    expect(dataResourceSource).not.toMatch(/allow\.(authenticated|guest|public)\(/);
  });

  it('keeps HybridCliAccessPolicy free of direct AppSync GraphQL permissions', () => {
    const start = backendSource.indexOf(
      "const cliManagedPolicy = new iam.ManagedPolicy(cliStack, 'HybridCliAccessPolicy'",
    );
    const end = backendSource.indexOf('const proofBundleBucketArn', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const cliPolicyBlock = backendSource.slice(start, end);
    expect(cliPolicyBlock).not.toContain('appsync:GraphQL');
  });

  it('does not add manual AppSync GraphQL grants in backend stack code', () => {
    expect(countGraphqlPolicyGrants(backendSource, 'lambdaFunction')).toBe(0);
    expect(countGraphqlPolicyGrants(backendSource, 'honoLambda')).toBe(0);
    expect(countGraphqlPolicyGrants(backendSource, 'callbackLambda')).toBe(0);
  });
});
