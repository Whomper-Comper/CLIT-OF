const path = require("node:path");
const runtimeDirectory = process.env.BOT_RUNTIME_DIR || __dirname;
const releaseDirectory = process.env.BOT_RELEASE_DIR || __dirname;

module.exports = {
  apps: [
    {
      name: "clit-of-bot",
      script: path.join(releaseDirectory, "dist", "index.js"),
      cwd: runtimeDirectory,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      node_args: "--no-warnings",
      time: true,
      env: {
        NODE_ENV: "production",
        BOT_RUNTIME_DIR: runtimeDirectory,
        BOT_RELEASE_DIR: releaseDirectory,
        BOT_DEPLOY_COMMIT: process.env.BOT_DEPLOY_COMMIT || "",
        BOT_HEALTH_FILE: process.env.BOT_HEALTH_FILE || path.join(runtimeDirectory, "data", "bot-health.json"),
      },
    },
  ],
};
