import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4273',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: process.env.E2E_CHANNEL,
  },
  timeout: 60000,
  webServer: {
    command: 'node --import tsx scripts/preview.ts',
    url: 'http://localhost:4273/api/health',
    env: { PREVIEW_PORT: '4273' },
    reuseExistingServer: false,
    timeout: 60000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1080 } } },
  ],
});
