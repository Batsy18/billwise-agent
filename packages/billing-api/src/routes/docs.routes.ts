import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse as parseYaml } from 'yaml';

/** Repo-root docs/openapi.yaml (same relative depth from src/ and dist/). */
export const DEFAULT_OPENAPI_PATH = path.resolve(__dirname, '../../../../docs/openapi.yaml');

export function loadOpenApi(file: string = DEFAULT_OPENAPI_PATH): Record<string, unknown> {
  return parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function docsRoutes(doc: Record<string, unknown>): Router {
  const r = Router();
  r.get('/api/v1/openapi.json', (_req, res) => {
    res.json(doc);
  });
  r.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: 'billwise API' }));
  return r;
}
