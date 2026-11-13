// The settings the server refuses to start without (the `[envs]` checks at the top of src/server/index.js), with
// made-up values: local assets, and the three addresses a browser would use pointing at the server's own port.
// Shared by the two checks that start a server nobody visits: scripts/prod-smoke.mjs (the built server on this
// machine) and scripts/image-check.mjs (the Docker image). A setting the start-up begins to require is added here
// once. NODE_ENV and COMMIT_HASH are not in it: the image sets its own.
export function serverStartEnv({ world, port, jwtSecret, host = '127.0.0.1' }) {
  const origin = `http://${host}:${port}`
  return {
    WORLD: world,
    PORT: String(port),
    JWT_SECRET: jwtSecret,
    SAVE_INTERVAL: '60',
    PUBLIC_MAX_UPLOAD_SIZE: '12',
    PUBLIC_WS_URL: `ws://${host}:${port}/ws`,
    PUBLIC_API_URL: `${origin}/api`,
    ASSETS: 'local',
    ASSETS_BASE_URL: `${origin}/assets`,
  }
}
