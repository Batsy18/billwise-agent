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
  // The UI page is served at /api/v1/docs/index.html (/docs and /docs/ redirect). GCP API Gateway
  // rejects path templates with a trailing slash, so through the gateway /api/v1/docs/ is not
  // routable; index.html and the assets (./swagger-ui.css, …) all match /api/v1/docs/{asset}.
  const page = swaggerUi.setup(doc, { customSiteTitle: 'billwise API' });
  r.get('/api/v1/docs', (_req, res) => {
    res.redirect(301, '/api/v1/docs/index.html');
  });
  r.get('/api/v1/docs/index.html', page); // before static: swagger-ui-dist has its own index.html
  r.use('/api/v1/docs', swaggerUi.serve);
  return r;
}
