import { defineConfig, devices } from '@playwright/test';

const defaultLocalBase = 'http://127.0.0.1:9333';
const remoteBase = process.env.BASE_URL?.trim();
const baseURL =
  remoteBase && remoteBase.length > 0
    ? remoteBase.replace(/\/$/, '')
    : defaultLocalBase;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(remoteBase && remoteBase.length > 0
    ? {}
    : {
        webServer: {
          command: 'npx serve . -l 9333',
          url: 'http://127.0.0.1:9333',
          reuseExistingServer: !process.env.CI,
        },
      }),
});
