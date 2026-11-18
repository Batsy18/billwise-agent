import path from 'node:path';

/** Package root; identical from src/ (tests, tsx) and dist/ (built). */
export const PACKAGE_ROOT = path.resolve(__dirname, '..');

export const GUIDE_FILE_NAME = 'Mobile_Provider_Billing_Guide.md';
export const GUIDE_PATH = path.join(PACKAGE_ROOT, 'data', GUIDE_FILE_NAME);
export const INDEX_PATH = path.join(PACKAGE_ROOT, 'generated', 'search-index.json');
